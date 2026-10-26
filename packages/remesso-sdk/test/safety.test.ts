import { assertEquals, assertRejects } from "@std/assert";
import { createPublicClient, custom, http, toHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { signedHeaders } from "../../../supabase/functions/_shared/standard-webhooks.ts";
import { makeCtx, write } from "../src/context.ts";
import { createRemesso } from "../src/client.ts";
import { ALLOWANCE, EXECUTOR, token } from "../src/deployment.ts";
import { allowanceAbi } from "../src/abi.ts";
import { RemessoError } from "../src/errors.ts";
import { DEPLOYMENT, makePay, paymentScope, priorPayment } from "../src/payments.ts";
import { makePolicies, type Policies } from "../src/policies.ts";
import { makeRequests, type RequestStatus } from "../src/requests.ts";
import { memoryStore, upsert, type PaymentRecord, type PaymentStore } from "../src/store.ts";
import { fileStore } from "../src/node.ts";
import { parseWebhook, webhookHandler } from "../src/webhooks.ts";

const agent = privateKeyToAccount(toHex(123456, { size: 32 }));
const other = privateKeyToAccount(toHex(789012, { size: 32 }));
const to = "0x000000000000000000000000000000000000bEEF" as Address;
const endpoints = { requestPayment: "https://remesso.test/request-payment", paymentEvents: "https://remesso.test/payment-events", webhooks: "https://remesso.test/webhooks" };
const noPolicies = { find: async () => [], get: async () => { throw new Error("must not reread a completed payment's policy"); } } as unknown as Policies;

function context(store: PaymentStore = memoryStore(), account = agent, pub?: PublicClient, fetch = globalThis.fetch) {
  return makeCtx({ account, wallet: null, pub: pub ?? { chain: celo, getChainId: async () => 42220 } as unknown as PublicClient,
    endpoints, appOrigin: "https://remesso.test", dataSuffix: undefined, store, fetch });
}
function record(ctx: ReturnType<typeof context>, overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return { key: "invoice", deployment: paymentScope(ctx), owner: other.address, policyId: "1", to, units: "1000000",
    token: token("USDT").address, memo: toHex(new Uint8Array(32)), hash: toHex(1, { size: 32 }), nonce: 1,
    raw: "0x", status: "confirmed", at: new Date().toISOString(), ...overrides };
}

Deno.test("a completed payment key refuses a changed token, policy or payer", async () => {
  const ctx = context();
  await ctx.store.save(record(ctx));
  const pay = makePay(ctx, noPolicies);
  for (const change of [{ token: "USDC" }, { policyId: 2 }, { payer: to }]) {
    const e = await assertRejects(() => pay({ to, amount: "1", idempotencyKey: "invoice", ...change }), RemessoError);
    assertEquals(e.code, "key_reused");
  }
});

Deno.test("two agents sharing a store cannot inherit each other's invoice key", async () => {
  const store = memoryStore();
  const a = context(store);
  await store.save(record(a));
  const b = context(store, other);
  const e = await assertRejects(() => makePay(b, noPolicies)({ to, amount: "1", idempotencyKey: "invoice" }), RemessoError);
  assertEquals(e.code, "refused");
});

Deno.test("missing receipt with a consumed nonce refuses to sign a new payment", async () => {
  const methods: string[] = [];
  const pub = createPublicClient({ chain: celo, transport: custom({ request: async ({ method }) => {
    methods.push(method);
    if (method === "eth_chainId") return "0xa4ec";
    if (method === "eth_getTransactionReceipt" || method === "eth_getTransactionByHash") return null;
    if (method === "eth_getTransactionCount") return "0x2";
    throw new Error(`unexpected signing RPC ${method}`);
  } }) });
  const ctx = context(memoryStore(), agent, pub as unknown as PublicClient);
  await ctx.store.save(record(ctx, { status: "sent" }));
  const e = await assertRejects(() => makePay(ctx, noPolicies)({ to, amount: "1", idempotencyKey: "invoice" }), RemessoError);
  assertEquals(e.code, "conflict");
  assertEquals(methods.some((m) => m.includes("send") || m.includes("sign")), false);
});

Deno.test("a stored confirmation is rechecked and needs the expected Paid event", async () => {
  const receipt = { transactionHash: toHex(1, { size: 32 }), transactionIndex: "0x0", blockHash: toHex(2, { size: 32 }), blockNumber: "0x10",
    from: agent.address, to: ALLOWANCE, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
    logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x0" };
  const pub = createPublicClient({ chain: celo, transport: custom({ request: async ({ method }) => {
    if (method === "eth_chainId") return "0xa4ec";
    if (method === "eth_getTransactionReceipt") return receipt;
    throw new Error(`unexpected RPC ${method}`);
  } }) });
  const ctx = context(memoryStore(), agent, pub as unknown as PublicClient);
  await ctx.store.save(record(ctx));
  assertEquals((await assertRejects(() => makePay(ctx, noPolicies)({ to, amount: "1", idempotencyKey: "invoice" }), RemessoError)).code, "conflict");
});

Deno.test("legacy payment records migrate only to their policy's immutable agent", async () => {
  const store = memoryStore();
  const pub = { chain: celo, readContract: async () => ({ agent: agent.address, owner: other.address }) } as unknown as PublicClient;
  const a = context(store, agent, pub);
  // Old stores can contain a Celo fee-currency signature, not ordinary EVM bytes.
  await store.save(record(a, { deployment: DEPLOYMENT, raw: "0x7bdeadbeef" }));
  assertEquals((await priorPayment(a, "invoice"))?.deployment, paymentScope(a));
  assertEquals(await priorPayment(context(store, other, pub), "invoice"), undefined);
});

Deno.test("payment keys and unresolved transactions survive age and volume retention", () => {
  const ctx = context();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const first = record(ctx, { at: old });
  const pending = record(ctx, { key: null, hash: toHex(2, { size: 32 }), at: old, status: "sent" });
  let records = [first, pending];
  for (let n = 3; n < 1100; n++) records = upsert(records, record(ctx, { key: null, hash: toHex(n, { size: 32 }) }));
  assertEquals(records.some((p) => p.key === "invoice"), true);
  assertEquals(records.some((p) => p.hash === pending.hash), true);
  assertEquals(records.filter((p) => p.key === null && p.status === "confirmed").length, 1000);
});

Deno.test("a corrupt file store refuses a payment instead of forgetting its history", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/payments.json`;
  await Deno.writeTextFile(path, "{interrupted");
  const e = await assertRejects(() => fileStore(path).byKey("invoice", "42220:contract"), RemessoError);
  assertEquals(e.code, "conflict");
  assertEquals(await Deno.readTextFile(path), "{interrupted");
});

Deno.test("policy discovery reads every event page instead of stopping at 500", async () => {
  const pages: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const after = new URL(String(url)).searchParams.get("after")!;
    pages.push(after);
    const ids = after === "0" ? Array.from({ length: 500 }, (_, i) => i + 1) : [501];
    return Response.json({ events: ids.map((id) => ({ contract: ALLOWANCE, refId: String(id), removed: false })), next: after === "0" ? 500 : 501 });
  }) as typeof globalThis.fetch;
  const pub = { readContract: async () => 502n } as unknown as PublicClient;
  const ids = await makePolicies(context(memoryStore(), agent, pub, fetch)).find();
  assertEquals([ids.length, ids[0], ids.at(-1)], [501, 501n, 1n]);
  assertEquals(pages, ["0", "500"]);
});

Deno.test("failure on a later policy page falls back to the complete chain", async () => {
  let requests = 0;
  const fetch = (async () => ++requests === 1
    ? Response.json({ events: Array.from({ length: 500 }, (_, i) => ({ contract: ALLOWANCE, refId: String(i + 2), removed: false })), next: 500 })
    : Response.json({ error: "unavailable" }, { status: 503 })) as typeof globalThis.fetch;
  const pub = { readContract: async () => 502n, multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ agent: agent.address })) } as unknown as PublicClient;
  const ids = await makePolicies(context(memoryStore(), agent, pub, fetch)).find();
  assertEquals([requests, ids.length, ids.includes(1n)], [2, 501, true]);
});

Deno.test("a supplied Celo public client typechecks without consumer casts", () => {
  const chain = createPublicClient({ chain: celo, transport: http("http://127.0.0.1:8546") });
  assertEquals(createRemesso({ publicClient: chain, account: agent }).publicClient === chain, true);
  const reader = createPublicClient({ transport: http("http://127.0.0.1:8546") });
  assertEquals(createRemesso({ publicClient: reader }).publicClient, reader);
});

Deno.test("invalid policy terms are refused before increasing token approval", async () => {
  let signed = 0;
  const pub = { chain: celo, getChainId: async () => 42220, readContract: async () => { throw new Error("should validate before reading allowance"); } } as unknown as PublicClient;
  const ctx = makeCtx({ ...context(memoryStore(), agent, pub), wallet: { getChainId: async () => 42220, writeContract: async () => { signed++; } } as never });
  const policies = makePolicies(ctx);
  for (const change of [{ agent: agent.address }, { days: 366 }, { days: Infinity }, { budget: "0" }, { recipients: Array(51).fill(to) }]) {
    const e = await assertRejects(() => policies.create({ agent: other.address, token: "USDT", perPayment: "1", perDay: "2", budget: "5", ...change }), RemessoError);
    assertEquals(e.code, "invalid");
  }
  assertEquals(signed, 0);
});

Deno.test("request payments delegate selection with the exact requested payer", async () => {
  const id = "bf0305f6-1ec5-4d42-9352-a09c84aa5f18";
  const request: RequestStatus = { id, reference: id.replaceAll("-", ""), status: "pending", payer: other.address,
    requested: { to, amount: "1", token: "USDT", intervalSeconds: null, runs: 1 }, signed: null, payment: null };
  const ctx = context(memoryStore(), agent, undefined, (async () => Response.json(request)) as typeof fetch);
  let sent: unknown;
  const requests = makeRequests(ctx, { policies: noPolicies, pay: async (input) => { sent = input; return {} as never; } });
  await requests.pay(id);
  assertEquals(sent, { to, amount: "1", token: "USDT", payer: other.address, memo: request.reference, idempotencyKey: `request:${id}` });
  request.payment = { state: "paid", schedule: null, txs: [], reason: null };
  assertEquals((await assertRejects(() => requests.pay(id), RemessoError)).code, "refused");
});

Deno.test("waitUntilPaid can wait for finality instead of returning on inclusion", async () => {
  const id = "bf0305f6-1ec5-4d42-9352-a09c84aa5f18";
  let reads = 0;
  const fetch = (async () => Response.json({ id, status: "accepted", payment: { state: "paid", txs: [{ txHash: toHex(1, { size: 32 }), final: ++reads > 1 }] } })) as typeof globalThis.fetch;
  const ctx = context(memoryStore(), agent, undefined, fetch);
  const requests = makeRequests(ctx, { policies: noPolicies, pay: async () => { throw new Error("read only"); } });
  const out = await requests.waitUntilPaid(id, { final: true, intervalMs: 1, timeoutMs: 1000 });
  assertEquals([reads, out.payment?.txs[0].final], [2, true]);
});

Deno.test("clients sharing a signer serialize writes, and a wallet on another chain is refused", async () => {
  const a = context();
  const b = context();
  const order: string[] = [];
  await Promise.all([
    a.serial(async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 5)); order.push("a-end"); }),
    b.serial(async () => { order.push("b"); }),
  ]);
  assertEquals(order, ["a-start", "a-end", "b"]);
  const wrongWallet = makeCtx({ ...a, wallet: { getChainId: async () => 1 } as never });
  assertEquals((await assertRejects(() => wrongWallet.assertChain(), RemessoError)).code, "wrong_chain");
});

Deno.test("a successful replacement cannot be reported as a completed policy revocation", async () => {
  const original = toHex(10, { size: 32 });
  const replacement = toHex(11, { size: 32 });
  const pub = { chain: celo, getChainId: async () => 42220, getBalance: async () => 10n ** 18n,
    getGasPrice: async () => 1n, getTransactionCount: async () => 0, simulateContract: async () => ({}),
    waitForTransactionReceipt: async () => ({ status: "success", transactionHash: replacement }),
  } as unknown as PublicClient;
  const ctx = makeCtx({ ...context(memoryStore(), other, pub),
    wallet: { getChainId: async () => 42220, writeContract: async () => original } as never });
  const error = await assertRejects(() => write(ctx, {
    address: ALLOWANCE, abi: allowanceAbi, functionName: "revoke", args: [1n], gasToken: null,
  }), RemessoError);
  assertEquals(error.code, "conflict");
  assertEquals(error.details, { hash: original, replacement });
});

Deno.test("signed webhook deliveries are schema checked and bound to this recipient", async () => {
  const secret = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
  const body = { type: "payment.received", timestamp: new Date().toISOString(), data: { chainId: 42220, contract: EXECUTOR, schedule: "1",
    from: other.address, to: agent.address, token: token("USDT").address, amount: "1000000", txHash: toHex(1, { size: 32 }), logIndex: 0,
    blockNumber: 10, blockHash: toHex(2, { size: 32 }), blockTime: new Date().toISOString(), final: false, removed: false } };
  let processed = 0;
  const handle = webhookHandler({ secret, recipient: agent.address, onPayment: () => { processed++; } });
  async function post(value: unknown) {
    const raw = JSON.stringify(value);
    return await handle(new Request("https://receiver.test/", { method: "POST", body: raw, headers: await signedHeaders([secret], "event-1", raw) }));
  }
  assertEquals((await post(body)).status, 200);
  assertEquals((await post({ ...body, data: { ...body.data, to: other.address } })).status, 403);
  assertEquals((await post({ ...body, data: undefined })).status, 400);
  assertEquals((await post({ ...body, type: "payment.finalized" })).status, 400);
  assertEquals((await post(null)).status, 400);
  assertEquals(processed, 1);
  const raw = JSON.stringify(body);
  const headers = await signedHeaders([secret], "event-2", raw);
  const mixed = Object.fromEntries(Object.entries(headers).map(([key, val]) => [key.toUpperCase(), val]));
  assertEquals((await parseWebhook(raw, mixed, secret)).id, "event-2");
});
