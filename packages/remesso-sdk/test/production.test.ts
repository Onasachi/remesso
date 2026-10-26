import { assertEquals, assertRejects } from "@std/assert";
import { createPublicClient, custom, keccak256, toHex, type Account, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { allowanceAbi } from "../src/abi.ts";
import { createRemesso } from "../src/client.ts";
import { makeCtx, write } from "../src/context.ts";
import type { SignerCoordinator } from "../src/coordination.ts";
import { ALLOWANCE, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import { memoryStore } from "../src/store.ts";

const recipient = privateKeyToAccount(toHex(606099, { size: 32 })).address;
const endpoints = { requestPayment: "https://remesso.test/request-payment", paymentEvents: "https://remesso.test/payment-events", webhooks: "https://remesso.test/webhooks" };

function coordinated(key: number, opts: { loseAfterSign?: boolean; rejectJournal?: boolean; noJournal?: boolean } = {}) {
  const original = privateKeyToAccount(toHex(key, { size: 32 }));
  const events: string[] = [];
  let active = true;
  let hash: Hex = "0x";
  const account: typeof original = { ...original, signTransaction: async (transaction, options) => {
    const raw = await original.signTransaction(transaction, options);
    events.push("signed");
    if (opts.loseAfterSign) active = false;
    return raw;
  } };
  const pub = createPublicClient({ chain: celo, transport: custom({ request: async ({ method, params }) => {
    if (method === "eth_sendRawTransaction") { events.push("broadcast"); return keccak256((params as [Hex])[0]); }
    throw new Error(`unexpected RPC ${method}`);
  } }) });
  Object.assign(pub, {
    getChainId: async () => 42220, getBalance: async () => 10n ** 18n, getGasPrice: async () => 1n,
    getTransactionCount: async () => 10, simulateContract: async () => ({}),
    fillTransaction: async (input: Record<string, unknown>) => ({ transaction: { ...input, chainId: 42220, type: "eip1559", gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } }),
    waitForTransactionReceipt: async () => ({ status: "success", transactionHash: hash }),
  });
  const coordinator: SignerCoordinator = {
    runExclusive: async (_scope, run) => await run({ assertActive: async () => { if (!active) throw new Error("signer lease lost"); } }),
    nextNonce: async (_scope, minimum) => Math.max(minimum, 17),
    recordSigned: opts.noJournal ? undefined : async (_scope, signed) => {
      events.push("journal"); hash = signed.hash;
      assertEquals(keccak256(signed.raw), signed.hash);
      if (opts.rejectJournal) throw new Error("journal commit uncertain");
    },
    noteNonce: async () => { events.push("floor"); },
  };
  const ctx = makeCtx({ pub: pub as unknown as PublicClient, wallet: { getChainId: async () => 42220 } as WalletClient, account,
    endpoints, appOrigin: "https://remesso.test", dataSuffix: undefined, fetch: globalThis.fetch, store: memoryStore(), coordinator });
  const run = () => ctx.serial(() => write(ctx, { address: ALLOWANCE, abi: allowanceAbi, functionName: "revoke", args: [1n], gasToken: null }));
  return { events, run };
}

Deno.test("coordinated contract writes journal immutable signed bytes and nonce before broadcasting", async () => {
  const h = coordinated(606001);
  const result = await h.run();
  assertEquals(h.events, ["signed", "journal", "floor", "broadcast"]);
  assertEquals(result.hash.length, 66);
});

Deno.test("a delayed signer cannot save or broadcast after losing its coordination lease", async () => {
  const h = coordinated(606002, { loseAfterSign: true });
  const error = await assertRejects(h.run, RemessoError);
  assertEquals(error.code, "conflict");
  assertEquals(typeof error.details?.hash, "string");
  assertEquals(h.events, ["signed"]);
});

Deno.test("an uncertain generic signed-write commit reports its original hash and never broadcasts", async () => {
  const h = coordinated(606003, { rejectJournal: true });
  const error = await assertRejects(h.run, RemessoError);
  assertEquals(error.code, "conflict");
  assertEquals(typeof error.details?.hash, "string");
  assertEquals(error.details?.nonce, 17);
  assertEquals(h.events, ["signed", "journal"]);
});

Deno.test("coordinated generic writes refuse adapters without a durable signed-byte journal", async () => {
  const h = coordinated(606004, { noJournal: true });
  assertEquals((await assertRejects(h.run, RemessoError)).code, "invalid");
  assertEquals(h.events, []);
});

function preparation(balance = 100_000_000n) {
  let fee = 25;
  let writes = 0;
  const account = privateKeyToAccount(toHex(606010, { size: 32 }));
  const pub = {
    chain: celo, getChainId: async () => 42220, getBalance: async () => 10n ** 20n, getGasPrice: async () => 1n,
    getBlock: async () => ({ number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    readContract: async ({ functionName }: { functionName: string }) => {
      const values: Record<string, unknown> = { feeBps: fee, directTokenAllowed: true, allowance: 0n, balanceOf: balance, MAX_LIFETIME: 31_536_000n };
      if (!(functionName in values)) throw new Error(`unexpected read ${functionName}`);
      return values[functionName];
    },
    simulateContract: async () => ({}), estimateContractGas: async () => 100_000n,
  } as unknown as PublicClient;
  const sdk = createRemesso({ publicClient: pub, attribution: false,
    walletClient: { account, getChainId: async () => 42220 } as unknown as WalletClient & { account: Account },
    remittanceStore: { get: async () => undefined, list: async () => [], save: async () => { writes++; throw new Error("must not write"); } } });
  const input = { funding: "wallet" as const, to: recipient, amount: "1", token: "USDT", idempotencyKey: "prepared-606" };
  return { sdk, input, fee: (n: number) => { fee = n; }, writes: () => writes };
}

Deno.test("prepare freezes the token debit and quote deadline without journal or nonce writes", async () => {
  const h = preparation();
  const shortDeadline = Math.floor(Date.now() / 1000) + 10;
  const result = await h.sdk.remittances.prepare({ ...h.input, validUntil: shortDeadline });
  assertEquals(result.input.maxDebit, "1.002507");
  assertEquals(result.input.token, token("USDT").address);
  assertEquals(result.input.validUntil, shortDeadline);
  assertEquals(h.writes(), 0);
});

Deno.test("prepare refuses unavailable funds, an insufficient debit cap and an expired intent", async () => {
  const h = preparation();
  for (const change of [{ maxDebit: "1.002506" }, { validUntil: Math.floor(Date.now() / 1000) - 1 }]) {
    assertEquals((await assertRejects(() => h.sdk.remittances.prepare({ ...h.input, ...change }), RemessoError)).code, "refused");
  }
  const empty = preparation(0n);
  assertEquals((await assertRejects(() => empty.sdk.remittances.prepare(empty.input), RemessoError)).code, "refused");
  for (const change of [{ validUntil: NaN }, { validUntil: 1.5 }, { idempotencyKey: "" }]) {
    assertEquals((await assertRejects(() => h.sdk.remittances.prepare({ ...h.input, ...change }), RemessoError)).code, "invalid");
  }
  assertEquals([h.writes(), empty.writes()], [0, 0]);
});

Deno.test("send enforces prepared expiry and a changed live fee before creating a mandate", async () => {
  const h = preparation();
  const prepared = await h.sdk.remittances.prepare(h.input);
  h.fee(30);
  assertEquals((await assertRejects(() => h.sdk.remittances.send(prepared.input), RemessoError)).code, "refused");
  assertEquals((await assertRejects(() => h.sdk.remittances.send({ ...h.input, validUntil: 1 }), RemessoError)).code, "refused");
  assertEquals(h.writes(), 0);
});
