import { assertEquals, assertRejects } from "@std/assert";
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, parseAbi, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { executorAbi } from "../src/abi.ts";
import { makeCtx } from "../src/context.ts";
import { EXECUTOR, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import { memoryRemittanceStore, type RemittanceRecord, type RemittanceStore } from "../src/remittance-store.ts";
import type { RequestStatus } from "../src/requests.ts";
import { memoryStore } from "../src/store.ts";
import { makeWalletRemittances, remittanceScope } from "../src/wallet-remittances.ts";

const payer = privateKeyToAccount(toHex(717171, { size: 32 }));
const to = privateKeyToAccount(toHex(717172, { size: 32 })).address;
const asset = token("USDT").address;
const hashes = { approval: toHex(71, { size: 32 }), creation: toHex(72, { size: 32 }), execution: toHex(73, { size: 32 }), payment: toHex(74, { size: 32 }), cancellation: toHex(76, { size: 32 }) };
const blockHash = toHex(75, { size: 32 });
const approvalAbi = parseAbi(["event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const endpoints = { requestPayment: "https://remesso.test/request-payment", paymentEvents: "https://remesso.test/payment-events", webhooks: "https://remesso.test/webhooks" };

function context(pub: PublicClient) {
  return makeCtx({ account: payer, wallet: null, pub, endpoints, appOrigin: "https://remesso.test", dataSuffix: undefined, store: memoryStore(), fetch: globalThis.fetch });
}
function record(scope: string, overrides: Partial<RemittanceRecord> = {}): RemittanceRecord {
  return { key: "invoice-71", scope, payer: payer.address, to, token: asset, amount: "1000000", amountIn: "1002507", fee: "2507", feeBps: 25,
    firstRunAt: 1_999_996_400, expiresAt: 2_000_000_000, approvalAmount: "1002507", createdAt: new Date().toISOString(),
    approval: { hash: hashes.approval, raw: "0x01", nonce: 1 }, creation: { hash: hashes.creation, raw: "0x02", nonce: 2 },
    scheduleId: "7", creationBlock: "100", ...overrides };
}
function log(hash: Hex, address: Address, topics: readonly Hex[], data: Hex) {
  return { address, topics, data, transactionHash: hash, transactionIndex: "0x0", logIndex: "0x0", blockHash, blockNumber: "0x64", removed: false };
}
function approvalLog() {
  return log(hashes.approval, asset, encodeEventTopics({ abi: approvalAbi, eventName: "Approval", args: { owner: payer.address, spender: EXECUTOR } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [1002507n]));
}
function creationLog(id = 7n) {
  return log(hashes.creation, EXECUTOR, encodeEventTopics({ abi: executorAbi, eventName: "ScheduleCreated", args: { id, sender: payer.address, destination: to } }) as Hex[],
    encodeAbiParameters([{ type: "uint128" }, { type: "uint64" }, { type: "uint96" }, { type: "uint32" }, { type: "uint64" }, { type: "uint8" }], [1002507n, 3600n, 0n, 1, 2_000_000_000n, 2]));
}
function runLog(hash = hashes.payment, amount = 1000000n) {
  return log(hash, EXECUTOR, encodeEventTopics({ abi: executorAbi, eventName: "RunExecuted", args: { id: 7n, sender: payer.address, destination: to } }) as Hex[],
    encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint32" }, { type: "uint64" }], [1002507n, amount, 1, 2000n]));
}
function receipt(hash: Hex, logs: unknown[], status = "0x1") {
  return { transactionHash: hash, transactionIndex: "0x0", blockHash, blockNumber: "0x64", from: payer.address, to: EXECUTOR,
    cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
    logs, logsBloom: `0x${"00".repeat(256)}`, status, type: "0x0" };
}
function mock(options: { receipts?: Record<string, unknown>; runs?: ReturnType<typeof runLog>[]; schedule?: Record<string, unknown>; nonce?: number } = {}) {
  const sent: string[] = [];
  const receipts: Record<string, unknown> = options.receipts ?? {
    [hashes.approval]: receipt(hashes.approval, [approvalLog()]), [hashes.creation]: receipt(hashes.creation, [creationLog()]),
    [hashes.payment]: receipt(hashes.payment, [runLog()]),
  };
  const pub = createPublicClient({ chain: celo, transport: custom({ request: async ({ method, params }) => {
    if (method === "eth_chainId") return "0xa4ec";
    if (method === "eth_getTransactionReceipt") return receipts[(params as string[])[0]] ?? null;
    if (method === "eth_getTransactionByHash") return null;
    if (method === "eth_getTransactionCount") return toHex(options.nonce ?? 0);
    sent.push(method);
    throw new Error(`unexpected RPC ${method}`);
  } }) });
  Object.assign(pub, {
    readContract: async () => ({ sender: payer.address, destination: to, token: asset, amountIn: 1002507n, interval: 3600n, maxRuns: 1, payoutType: 2,
      feeBps: 25, runsExecuted: 1, active: false, cancelled: false, expiresAt: 2_000_000_000n, ...options.schedule }),
    getBlock: async () => ({ number: 100n, hash: blockHash, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBlockNumber: async () => 100n,
    getContractEvents: async () => options.runs ?? [runLog()],
    waitForTransactionReceipt: async () => { throw new Error("not mined yet"); },
  });
  return { pub: pub as unknown as PublicClient, sent, receipts };
}
const input = { to, amount: "1", token: "USDT", idempotencyKey: "invoice-71" };
const unusedRequests = { getRequest: async (): Promise<RequestStatus> => { throw new Error("unexpected request read"); }, answer: async () => ({ status: "accepted", signed: null }) };

Deno.test("wallet remittance keys are required and changes cannot create another schedule", async () => {
  const m = mock(); const ctx = context(m.pub); const store = memoryRemittanceStore();
  await store.save(record(remittanceScope(ctx)));
  const wallet = makeWalletRemittances(ctx, { store, ...unusedRequests });
  for (const change of [{ amount: "2" }, { token: "USDC" }, { to: payer.address }, { requestId: "another" }]) {
    const e = await assertRejects(() => wallet.send({ ...input, ...change }), RemessoError);
    assertEquals(["key_reused", "invalid"].includes(e.code), true);
  }
  assertEquals((await assertRejects(() => wallet.send({ ...input, idempotencyKey: "" }), RemessoError)).code, "invalid");
  assertEquals(m.sent, []);
});

Deno.test("a restarted wallet recovers the original schedule and a regular executor's payment", async () => {
  const m = mock(); const ctx = context(m.pub); const store = memoryRemittanceStore();
  await store.save(record(remittanceScope(ctx), { scheduleId: undefined, creationBlock: undefined }));
  let bound = 0;
  const wallet = makeWalletRemittances(ctx, { store, ...unusedRequests, answer: async () => { bound++; return { status: "accepted", signed: null }; } });
  const first = await wallet.send(input);
  const again = await makeWalletRemittances(context(m.pub), { store, ...unusedRequests }).send(input);
  assertEquals([first.status, first.hash, first.scheduleId, first.amount, first.fee], ["confirmed", hashes.payment, 7n, 1000000n, 2507n]);
  assertEquals([again.status, again.hash], ["confirmed", hashes.payment]);
  assertEquals((await store.get(input.idempotencyKey, remittanceScope(ctx)))?.creation?.hash, hashes.creation);
  assertEquals([m.sent, bound], [[], 0]);
});

Deno.test("a consumed creation nonce without its receipt fails closed", async () => {
  const m = mock({ receipts: {}, nonce: 3 }); const ctx = context(m.pub); const store = memoryRemittanceStore();
  await store.save(record(remittanceScope(ctx), { scheduleId: undefined, creationBlock: undefined }));
  const e = await assertRejects(() => makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input), RemessoError);
  assertEquals(e.code, "conflict"); assertEquals(m.sent, []);
});

Deno.test("a successful approval without its expected Approval event is not proof", async () => {
  const m = mock({ schedule: { runsExecuted: 0, active: true }, runs: [] }); m.receipts[hashes.approval] = receipt(hashes.approval, []);
  const ctx = context(m.pub); const store = memoryRemittanceStore(); await store.save(record(remittanceScope(ctx)));
  assertEquals((await assertRejects(() => makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input), RemessoError)).code, "conflict");
  assertEquals(m.sent, []);
});

Deno.test("the original creation receipt must identify this exact one-payment schedule", async () => {
  const m = mock(); m.receipts[hashes.creation] = receipt(hashes.creation, [creationLog(8n)]);
  const ctx = context(m.pub); const store = memoryRemittanceStore(); await store.save(record(remittanceScope(ctx)));
  assertEquals((await assertRejects(() => makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input), RemessoError)).code, "conflict");
  assertEquals(m.sent, []);
});

Deno.test("a fee-mismatch cancellation reports nothing paid only once the schedule reads as cancelled and unrun", async () => {
  const m = mock({ schedule: { feeBps: 30, runsExecuted: 0, cancelled: true } }); const ctx = context(m.pub); const store = memoryRemittanceStore();
  const cancelled = log(hashes.cancellation, EXECUTOR, encodeEventTopics({ abi: executorAbi, eventName: "ScheduleCancelled", args: { id: 7n } }) as Hex[], "0x");
  m.receipts[hashes.cancellation] = receipt(hashes.cancellation, [cancelled]);
  await store.save(record(remittanceScope(ctx), { approval: undefined, cancellation: { hash: hashes.cancellation, raw: "0x04", nonce: 3 }, cancelReason: "the contract's fee changed after this payment was quoted" }));
  const error = await assertRejects(() => makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input), RemessoError);
  assertEquals(error.code, "refused");
  assertEquals([error.details?.scheduleId, error.details?.cancellationHash, error.details?.cancelled], ["7", hashes.cancellation, true]);
  assertEquals((await store.get(input.idempotencyKey, remittanceScope(ctx)))?.approval, undefined);
  assertEquals(m.sent, []);
});

Deno.test("a cancellation whose nonce was used without its receipt fails closed and keeps its signed bytes", async () => {
  const m = mock({ schedule: { feeBps: 30, runsExecuted: 0 }, nonce: 4 }); const ctx = context(m.pub); const store = memoryRemittanceStore();
  await store.save(record(remittanceScope(ctx), { approval: undefined, cancellation: { hash: hashes.cancellation, raw: "0x04", nonce: 3 } }));
  const error = await assertRejects(() => makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input), RemessoError);
  assertEquals([error.code, error.details?.hash], ["conflict", hashes.cancellation]);
  assertEquals((await store.get(input.idempotencyKey, remittanceScope(ctx)))?.cancellation?.raw, "0x04");
  assertEquals(m.sent, []);
});

Deno.test("a previous confirmation is cleared when the actual payment receipt disappeared", async () => {
  const m = mock({ runs: [] }); delete m.receipts[hashes.payment];
  const ctx = context(m.pub); const store = memoryRemittanceStore(); await store.save(record(remittanceScope(ctx), { paymentHash: hashes.payment }));
  const r = await makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input);
  assertEquals([r.status, r.hash], ["pending", undefined]);
  assertEquals((await store.get(input.idempotencyKey, remittanceScope(ctx)))?.paymentHash, undefined);
  assertEquals(m.sent, []);
});

Deno.test("an executor race still confirms after the payer's own runNow reverted", async () => {
  const m = mock(); m.receipts[hashes.execution] = receipt(hashes.execution, [], "0x0");
  const ctx = context(m.pub); const store = memoryRemittanceStore();
  await store.save(record(remittanceScope(ctx), { execution: { hash: hashes.execution, raw: "0x03", nonce: 3 } }));
  const r = await makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input);
  assertEquals([r.status, r.hash, r.scheduleId], ["confirmed", hashes.payment, 7n]); assertEquals(m.sent, []);
});

Deno.test("a payment event with the wrong net amount cannot confirm a wallet remittance", async () => {
  const wrong = runLog(hashes.payment, 999999n);
  const m = mock({ runs: [wrong] }); m.receipts[hashes.payment] = receipt(hashes.payment, [wrong]);
  const ctx = context(m.pub); const store = memoryRemittanceStore(); await store.save(record(remittanceScope(ctx)));
  const r = await makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input);
  assertEquals([r.status, r.hash], ["pending", undefined]); assertEquals(m.sent, []);
});

Deno.test("request binding resumes against the saved schedule and never needs another payment", async () => {
  const m = mock(); const ctx = context(m.pub); const store = memoryRemittanceStore();
  await store.save(record(remittanceScope(ctx), { requestId: "request-71" }));
  let attempts = 0;
  const deps = { store, ...unusedRequests, answer: async (_id: string, scheduleId: bigint) => {
    assertEquals(scheduleId, 7n); if (++attempts === 1) throw new Error("indexer is behind"); return { status: "accepted", signed: null };
  } };
  const first = await makeWalletRemittances(ctx, deps).send({ ...input, requestId: "request-71" });
  assertEquals([first.status, first.request?.bound, first.request?.error], ["confirmed", false, "indexer is behind"]);
  const again = await makeWalletRemittances(context(m.pub), deps).send({ ...input, requestId: "request-71" });
  assertEquals([again.status, again.request?.bound, attempts], ["confirmed", true, 2]); assertEquals(m.sent, []);
});

Deno.test("the exact one-off request path rejects recurrence, changed terms and existing answers before signing", async () => {
  const m = mock(); const ctx = context(m.pub); const store = memoryRemittanceStore();
  const base: RequestStatus = { id: "request-71", reference: "71".repeat(16), status: "pending", payer: payer.address,
    requested: { to, amount: "1", token: "USDT", intervalSeconds: null, runs: null }, signed: null, payment: null };
  const cases = [
    { ...base, status: "accepted" as const },
    { ...base, requested: { ...base.requested, intervalSeconds: 3600 } },
    { ...base, requested: { ...base.requested, amount: null } },
    { ...base, requested: { ...base.requested, token: null } },
    { ...base, requested: { ...base.requested, amount: "2" } },
    { ...base, payer: to },
  ];
  for (const request of cases) {
    const wallet = makeWalletRemittances(ctx, { store, ...unusedRequests, getRequest: async () => request });
    assertEquals((await assertRejects(() => wallet.send({ ...input, requestId: "request-71" }), RemessoError)).code, "refused");
  }
  assertEquals(m.sent, []);
});

Deno.test("remittance storage scopes keys and does not expose mutable live records", async () => {
  const store = memoryRemittanceStore(); const r = record("chain:contract:agent-a"); await store.save(r);
  r.amount = "42";
  const read = await store.get(r.key, r.scope); assertEquals(read?.amount, "1000000");
  read!.amount = "43";
  assertEquals((await store.get(r.key, r.scope))?.amount, "1000000");
  assertEquals(await store.get(r.key, "chain:contract:agent-b"), undefined);
  const list = await store.list(r.scope);
  list[0].amount = "44";
  assertEquals((await store.list(r.scope))[0].amount, "1000000");
  assertEquals(await store.list("chain:contract:agent-b"), []);
});

Deno.test("a custom journal entry must belong to the requested key, scope and payer", async () => {
  const m = mock(); const ctx = context(m.pub);
  for (const change of [{ key: "another" }, { scope: "another" }, { payer: to }]) {
    const store: RemittanceStore = { get: async () => record(remittanceScope(ctx), change), list: async () => [], save: async () => { throw new Error("must not save"); } };
    const error = await assertRejects(() => makeWalletRemittances(ctx, { store, ...unusedRequests }).send(input), RemessoError);
    assertEquals(error.code, "conflict");
  }
  assertEquals(m.sent, []);
});

Deno.test("a new key after restart rebroadcasts unsent journaled steps in order and signs above them", async () => {
  const m = mock();
  const broadcasts: string[] = [];
  Object.assign(m.pub, {
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      if (method === "eth_sendRawTransaction") { broadcasts.push(params[0] as string); return toHex(1, { size: 32 }); }
      if (method === "eth_getTransactionByHash") return null;
      throw new Error(`unexpected RPC ${method}`);
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "directTokenAllowed") return true;
      if (functionName === "feeBps") return 25;
      if (functionName === "MAX_LIFETIME") return 31_536_000n;
      if (functionName === "allowance") return 0n;
      if (functionName === "balanceOf") return 1_000_000_000n;
      throw new Error(`unexpected read ${functionName}`);
    },
    getTransactionCount: async () => 0,
    getBalance: async () => 10n ** 18n,
    getGasPrice: async () => 1n,
    getBlock: async () => ({ timestamp: 1_900_000_000n }),
    simulateContract: async () => ({}),
    fillTransaction: async (args: Record<string, unknown>) => ({ transaction: { ...args, chainId: 42220, type: "eip1559", gas: 300_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } }),
  });
  const ctx = context(m.pub); const durable = memoryRemittanceStore();
  await durable.save(record(remittanceScope(ctx), { key: "older-payment", creation: { hash: hashes.creation, raw: "0x02", nonce: 42 }, cancellation: { hash: hashes.cancellation, raw: "0x04", nonce: 49 } }));
  let captured: number | undefined;
  const store: RemittanceStore = {
    get: durable.get, list: durable.list,
    save: async (r) => {
      if (r.key === "new-payment" && r.creation) { captured = r.creation.nonce; throw new Error("crash before broadcast"); }
      await durable.save(r);
    },
  };
  await assertRejects(() => makeWalletRemittances(ctx, { store, ...unusedRequests }).send({ ...input, idempotencyKey: "new-payment" }), Error, "crash before broadcast");
  assertEquals(captured, 50);
  // Each saved step the node doesn't know goes out again with its own bytes,
  // lowest nonce first, before anything new is signed.
  assertEquals(broadcasts, ["0x01", "0x02", "0x04"]);
  assertEquals(m.sent, []);
});
