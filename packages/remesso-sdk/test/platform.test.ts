import { assertEquals, assertRejects } from "@std/assert";
import { toHex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { makeAgents } from "../src/agents.ts";
import { makeCtx } from "../src/context.ts";
import { ALLOWANCE, EXECUTOR, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import { fileRemittanceStore } from "../src/node.ts";
import { makeRemittances, type SendRemittanceInput } from "../src/remittances.ts";
import { memoryRemittanceStore, type RemittanceRecord } from "../src/remittance-store.ts";
import type { RequestStatus, Requests } from "../src/requests.ts";
import type { Policies } from "../src/policies.ts";
import { memoryStore } from "../src/store.ts";

const account = privateKeyToAccount(toHex(12345, { size: 32 }));
const receiver = privateKeyToAccount(toHex(23456, { size: 32 })).address;
const other = privateKeyToAccount(toHex(34567, { size: 32 })).address;
const tx = toHex(1, { size: 32 });
const usd = token("USDT");
const requestId = "bf0305f6-1ec5-4d42-9352-a09c84aa5f18";
function context(pub = {} as PublicClient) {
  return makeCtx({ account, wallet: null, pub, endpoints: { requestPayment: "https://sdk.test/requests", paymentEvents: "https://sdk.test/events", webhooks: "https://sdk.test/webhooks" },
    appOrigin: "https://sdk.test", fetch, dataSuffix: undefined, store: memoryStore() });
}
function invoice(changes: Partial<RequestStatus> = {}): RequestStatus {
  return { id: requestId, reference: requestId.replaceAll("-", ""), status: "pending", payer: account.address,
    requested: { to: receiver, amount: "1", token: "USDT", intervalSeconds: null, runs: 1 }, signed: null, payment: null, ...changes };
}
const result = { status: "confirmed" as const, hash: tx, policyId: 1n, to: receiver, amount: 1_000_000n, token: usd.address, sent: "1 USDT", explorer: "https://sdk.test/tx" };
const input: SendRemittanceInput = { funding: "policy", to: receiver, amount: "1", token: "USDT", idempotencyKey: "invoice-17", requestId };

function platform(request = invoice()) {
  let payments = 0;
  const api = makeRemittances(context(), {
    pay: async () => { payments++; return result; },
    policies: { get: async () => ({ owner: account.address }) } as unknown as Policies,
    requests: { get: async () => request, pay: async () => { payments++; return result; } } as unknown as Requests,
    wallet: { send: async () => { payments++; return { ...result, funding: "wallet" }; } } as never,
  });
  return { api, payments: () => payments };
}

Deno.test("platform policy remittance preserves exact invoice settlement and funding owner", async () => {
  const p = platform();
  const paid = await p.api.send(input);
  assertEquals([paid.funding, paid.payer, paid.amount, paid.fee, p.payments()], ["policy", account.address, 1_000_000n, 0n, 1]);
});

Deno.test("platform rejects recurring, unspecified and changed invoice terms before any payment", async () => {
  for (const changes of [{ intervalSeconds: 604800 }, { runs: 2 }, { amount: null }, { token: null }, { amount: "0.50" }, { token: "USDC" }, { to: other }]) {
    const r = invoice(); r.requested = { ...r.requested, ...changes };
    const p = platform(r);
    assertEquals((await assertRejects(() => p.api.send(input), RemessoError)).code, "refused");
    assertEquals(p.payments(), 0);
  }
});

Deno.test("an existing scheduled invoice cannot receive a second policy remittance", async () => {
  const p = platform(invoice({ payment: { state: "scheduled", schedule: { contract: EXECUTOR, id: "1" }, txs: [], reason: null } }));
  assertEquals((await assertRejects(() => p.api.send(input), RemessoError)).code, "refused");
  assertEquals(p.payments(), 0);
});

Deno.test("the platform requires an explicit funding mode, key and matching payer", async () => {
  const p = platform();
  for (const changed of [{ funding: "guess" }, { idempotencyKey: "" }, { idempotencyKey: " " }, { funding: "wallet", payer: other }]) {
    assertEquals((await assertRejects(() => p.api.send({ ...input, ...changed } as SendRemittanceInput), RemessoError)).code, "invalid");
  }
  assertEquals((await assertRejects(() => p.api.send({ ...input, payer: other }), RemessoError)).code, "refused");
  assertEquals(p.payments(), 0);
});

function counterparty(opts: { required?: boolean; profile?: boolean; accepted?: string; switched?: boolean; noWallet?: boolean } = {}) {
  let reads = 0, sends = 0;
  let terms: unknown;
  const doc = { wallet: other, services: [{ name: "remesso", version: "1", assets: [{ network: "eip155:42220", asset: opts.accepted ?? usd.address }], reference: { required: opts.required ?? false } }] };
  const pub = { chain: celo, readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "getAgentWallet") return opts.noWallet ? `0x${"0".repeat(40)}` : opts.switched && ++reads > 1 ? other : receiver;
    return `data:application/json,${encodeURIComponent(JSON.stringify(opts.profile === false ? {} : doc))}`;
  } } as unknown as PublicClient;
  return { agents: makeAgents(context(pub), { getRequest: async () => invoice(), send: async (i) => { sends++; terms = i; return { ...result, funding: "policy", payer: account.address, fee: 0n }; } }),
    sends: () => sends, terms: () => terms };
}

Deno.test("agent payments use the registry wallet and published asset, ignoring file wallet fields", async () => {
  const c = counterparty();
  const paid = await c.agents.pay(7, { funding: "policy", amount: "1", token: "USDT", idempotencyKey: "invoice-17" });
  assertEquals(paid.counterparty, { agentId: 7n, wallet: receiver });
  assertEquals((c.terms() as SendRemittanceInput).to, receiver);
  assertEquals(c.sends(), 1);
});

Deno.test("agent payments refuse unsupported profiles, assets, missing references and wallet changes", async () => {
  for (const opts of [{ profile: false }, { accepted: token("USDC").address }, { required: true }, { switched: true }, { noWallet: true }]) {
    const c = counterparty(opts);
    await assertRejects(() => c.agents.pay(7, { funding: "policy", amount: "1", token: "USDT", idempotencyKey: "invoice-17" }), RemessoError);
    assertEquals(c.sends(), 0);
  }
});

Deno.test("agent invoice payment defaults to a stable request key and honors expectedWallet", async () => {
  const c = counterparty({ required: true });
  await c.agents.pay(7, { funding: "wallet", requestId, expectedWallet: receiver });
  assertEquals((c.terms() as SendRemittanceInput).idempotencyKey, `request:${requestId}`);
  assertEquals((c.terms() as SendRemittanceInput).funding, "wallet");
  await assertRejects(() => c.agents.pay(7, { funding: "wallet", requestId, expectedWallet: other }), RemessoError);
  assertEquals(c.sends(), 1);
});

Deno.test("wallet remittance file store keeps separate signer keys and fails closed on corruption", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/remittances.json`;
    const store = fileRemittanceStore(path);
    const record: RemittanceRecord = { key: "invoice-17", scope: `42220:${EXECUTOR}:${account.address}`, payer: account.address, to: receiver, token: usd.address,
      amount: "1000000", amountIn: "1002507", fee: "2507", feeBps: 25, expiresAt: Math.floor(Date.now() / 1000) + 86400, firstRunAt: Math.floor(Date.now() / 1000) + 3600,
      approvalAmount: "1002507", createdAt: new Date().toISOString() };
    await store.save(record);
    const second = { ...record, scope: `42220:${EXECUTOR}:${other}` };
    await store.save(second);
    assertEquals(await fileRemittanceStore(path).get(record.key, record.scope), record);
    assertEquals(await store.get(second.key, second.scope), second);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    await Deno.writeTextFile(path, "{interrupted");
    assertEquals((await assertRejects(() => store.get(record.key, record.scope), RemessoError)).code, "conflict");
    await assertRejects(() => store.save(record), RemessoError);
    assertEquals(await Deno.readTextFile(path), "{interrupted");
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("a new key after restart recovers the nonce floor across policy and wallet journals", async () => {
  const signer = privateKeyToAccount(toHex(7654321, { size: 32 }));
  const policy = memoryStore();
  const wallet = memoryRemittanceStore();
  const scope = `42220:${EXECUTOR.toLowerCase()}:${signer.address.toLowerCase()}`;
  const r: RemittanceRecord = { key: "other-invoice", scope, payer: signer.address, to: receiver, token: usd.address,
    amount: "1000000", amountIn: "1002507", fee: "2507", feeBps: 25, expiresAt: 2_000_000_000, firstRunAt: 1_999_999_000,
    approvalAmount: "1002507", createdAt: new Date().toISOString(), creation: { hash: tx, raw: "0x1234", nonce: 12 } };
  await wallet.save(r);
  await policy.save({ key: "old-policy-invoice", deployment: `42220:${ALLOWANCE.toLowerCase()}:${signer.address.toLowerCase()}`,
    policyId: "1", to: receiver, units: "1000000", token: usd.address, memo: toHex(new Uint8Array(32)), hash: tx,
    nonce: 14, raw: "0x1234", status: "sent", at: new Date().toISOString() });
  const pub = { getTransactionCount: async () => 0 } as unknown as PublicClient;
  const resumed = makeCtx({ ...context(pub), account: signer, store: policy, remittanceStore: wallet });
  assertEquals(await resumed.nextNonce(), 15);
  await wallet.save({ ...r, execution: { hash: tx, raw: "0x1234", nonce: 17 } });
  assertEquals(await makeCtx({ ...resumed }).nextNonce(), 18);
});
