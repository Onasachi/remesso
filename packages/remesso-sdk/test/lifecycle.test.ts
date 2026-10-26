import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { allowanceAbi, executorAbi } from "../src/abi.ts";
import { makeCtx } from "../src/context.ts";
import { ALLOWANCE, EXECUTOR, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import { makeLifecycle } from "../src/lifecycle.ts";
import { DEPLOYMENT, memo32, paymentScope, type PayInput, type PaymentResult } from "../src/payments.ts";
import { makeReceipts, type Receipts } from "../src/receipts.ts";
import { memoryRemittanceStore, type RemittanceRecord } from "../src/remittance-store.ts";
import { memoryStore, type PaymentRecord } from "../src/store.ts";
import { remittanceScope, type WalletRemittanceInput, type WalletRemittances } from "../src/wallet-remittances.ts";

const signer = privateKeyToAccount(toHex(912345, { size: 32 }));
const owner = privateKeyToAccount(toHex(912346, { size: 32 })).address;
const recipient = privateKeyToAccount(toHex(912347, { size: 32 })).address;
const asset = token("USDT");
const hashes = { creation: toHex(401, { size: 32 }), approval: toHex(402, { size: 32 }), execution: toHex(403, { size: 32 }), external: toHex(404, { size: 32 }), policy: toHex(405, { size: 32 }) };
const blockHash = toHex(499, { size: 32 });
const approvalAbi = parseAbi(["event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function log(hash: Hex, address: Address, topics: readonly Hex[], data: Hex): TransactionReceipt["logs"][number] {
  return { address, topics: topics as [Hex, ...Hex[]], data, transactionHash: hash, transactionIndex: 0, logIndex: 0, blockHash, blockNumber: 100n, removed: false };
}
function creation() {
  return log(hashes.creation, EXECUTOR, encodeEventTopics({ abi: executorAbi, eventName: "ScheduleCreated", args: { id: 7n, sender: signer.address, destination: recipient } }) as Hex[],
    encodeAbiParameters([{ type: "uint128" }, { type: "uint64" }, { type: "uint96" }, { type: "uint32" }, { type: "uint64" }, { type: "uint8" }], [1002507n, 3600n, 0n, 1, 2_000_000_000n, 2]));
}
function approval(amount = 1002507n) {
  return log(hashes.approval, asset.address, encodeEventTopics({ abi: approvalAbi, eventName: "Approval", args: { owner: signer.address, spender: EXECUTOR } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [amount]));
}
function run(hash = hashes.external) {
  return log(hash, EXECUTOR, encodeEventTopics({ abi: executorAbi, eventName: "RunExecuted", args: { id: 7n, sender: signer.address, destination: recipient } }) as Hex[],
    encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint32" }, { type: "uint64" }], [1002507n, 1000000n, 1, 123n]));
}
function paid() {
  return log(hashes.policy, ALLOWANCE, encodeEventTopics({ abi: allowanceAbi, eventName: "Paid", args: { id: 9n, to: recipient } }) as Hex[],
    encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [1000000n, memo32("order-9")]));
}
function receipt(hash: Hex, logs: TransactionReceipt["logs"], change: Partial<TransactionReceipt> = {}): TransactionReceipt {
  return { transactionHash: hash, transactionIndex: 0, blockHash, blockNumber: 100n, from: signer.address, to: hash === hashes.policy ? ALLOWANCE : EXECUTOR,
    cumulativeGasUsed: 1n, gasUsed: 1n, effectiveGasPrice: 1n, contractAddress: null, logs, logsBloom: "0x", status: "success", type: "legacy", ...change };
}
function fixture() {
  const receipts = new Map<Hex, TransactionReceipt>();
  const state = { chainId: 42220, nonce: 0, finalized: 99n, canonical: blockHash, now: 1_999_999_999n, running: [] as ReturnType<typeof run>[], known: new Set<Hex>(),
    // The schedule as a read at `blockNumber` sees it; unset, every read sees `schedule`.
    scheduleAt: null as null | ((blockNumber: bigint | undefined) => Record<string, unknown>),
    schedule: { sender: signer.address, destination: recipient, token: asset.address, tokenOut: recipient, amountIn: 1002507n, interval: 3600n, maxRuns: 1, payoutType: 2, feeBps: 25, runsExecuted: 0, active: true, cancelled: false, expiresAt: 2_000_000_000n } };
  let receiptDelay = 0;
  let completedReads = 0;
  const pub = {
    getChainId: async () => state.chainId,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => { if (receiptDelay) await pause(receiptDelay); completedReads++; const found = receipts.get(hash); if (!found) throw new TransactionReceiptNotFoundError({ hash }); return found; },
    getTransaction: async ({ hash }: { hash: Hex }) => { if (!state.known.has(hash)) throw new TransactionNotFoundError({ hash }); return { hash }; },
    getTransactionCount: async () => state.nonce,
    getBlockNumber: async () => 100n,
    getBlock: async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint } = {}) => ({ number: blockTag === "finalized" ? state.finalized : blockNumber ?? 100n, hash: state.canonical, timestamp: state.now }),
    getContractEvents: async () => state.running,
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => functionName === "policy"
      ? { owner, agent: signer.address, token: asset.address } : state.scheduleAt?.(blockNumber) ?? state.schedule,
  } as unknown as PublicClient;
  const store = memoryStore(), walletStore = memoryRemittanceStore();
  const ctx = makeCtx({ pub, wallet: null, account: signer, store, remittanceStore: walletStore, dataSuffix: undefined, fetch,
    endpoints: { requestPayment: "", paymentEvents: "", webhooks: "" }, appOrigin: "https://remesso.test" });
  const policy = (change: Partial<PaymentRecord> = {}): PaymentRecord => ({ key: "policy-key", deployment: paymentScope(ctx), owner, policyId: "9", to: recipient,
    units: "1000000", token: asset.address, memo: memo32("order-9"), hash: hashes.policy, nonce: 3, raw: "0x03", status: "sent", at: new Date().toISOString(), ...change });
  const walletRecord = (change: Partial<RemittanceRecord> = {}): RemittanceRecord => ({ key: "wallet-key", scope: remittanceScope(ctx), payer: signer.address, to: recipient,
    token: asset.address, amount: "1000000", amountIn: "1002507", fee: "2507", feeBps: 25, firstRunAt: 1_999_996_400, expiresAt: 2_000_000_000, approvalAmount: "1002507",
    createdAt: new Date().toISOString(), creation: { hash: hashes.creation, raw: "0x01", nonce: 1 }, ...change });
  const calls: { wallet: WalletRemittanceInput[]; policy: PayInput[] } = { wallet: [], policy: [] };
  const wallet = {
    send: async () => { throw new Error("lifecycle must never start a payment"); },
    resume: async (input: WalletRemittanceInput) => { calls.wallet.push(input); return { funding: "wallet", status: "pending" }; },
  } as unknown as WalletRemittances;
  const pay = async (input: PayInput): Promise<PaymentResult> => { calls.policy.push(input); return { status: "pending", hash: hashes.policy, policyId: 9n, to: recipient, amount: 1000000n, token: asset.address, sent: "1 USDT", explorer: "" }; };
  const api = (proofs: Receipts = makeReceipts(ctx)) => makeLifecycle(ctx, { store: walletStore, wallet, pay, receipts: proofs });
  return { api, ctx, state, receipts, store, walletStore, policy, walletRecord, calls, completedReads: () => completedReads, setDelay: (ms: number) => { receiptDelay = ms; } };
}

Deno.test("lifecycle reads signed, broadcast and consumed-nonce states without side effects", async () => {
  const f = fixture(); await f.store.save(f.policy());
  assertEquals((await f.api().get("policy-key")).status, "signed");
  f.state.known.add(hashes.policy);
  assertEquals((await f.api().get("policy-key")).status, "broadcast");
  f.state.known.clear(); f.state.nonce = 4;
  const uncertain = await f.api().get("policy-key");
  assertEquals([uncertain.status, uncertain.error?.code], ["needs_reconciliation", "conflict"]);
  assertEquals((await f.api().reconcile("policy-key")).error?.reason, "nonce_consumed");
  assertEquals(f.calls, { wallet: [], policy: [] });
  assertEquals((await f.store.byKey("policy-key", paymentScope(f.ctx)))?.status, "sent");
});

Deno.test("lifecycle verifies policy inclusion and finality through independent receipt evidence", async () => {
  const f = fixture(); await f.store.save(f.policy()); f.receipts.set(hashes.policy, receipt(hashes.policy, [paid()]));
  const included = await f.api().get("policy-key");
  assertEquals([included.status, included.proof?.finality, included.payer, included.policyId], ["included", "included", owner, 9n]);
  f.state.finalized = 100n;
  assertEquals((await f.api().wait("policy-key", { finality: "finalized", timeoutMs: 1000 })).status, "finalized");
  assertEquals(await f.api().listPending(), []);
});

Deno.test("lifecycle never downgrades contradictory finality or reorganized evidence to included", async () => {
  const f = fixture(); await f.store.save(f.policy()); f.receipts.set(hashes.policy, receipt(hashes.policy, [paid()])); f.state.finalized = 100n;
  const actual = makeReceipts(f.ctx);
  const proofs: Receipts = { verify: async (input) => { if (input.finality === "finalized") throw new RemessoError("conflict", "finalized block changed"); return await actual.verify(input); } };
  assertEquals((await f.api(proofs).get("policy-key")).status, "needs_reconciliation");
  f.state.canonical = toHex(500, { size: 32 });
  assertEquals((await f.api().get("policy-key")).status, "needs_reconciliation");
});

Deno.test("lifecycle creation and approval transitions require exact matching events", async () => {
  const f = fixture(); const r = f.walletRecord(); await f.walletStore.save(r);
  f.receipts.set(hashes.creation, receipt(hashes.creation, []));
  assertEquals((await f.api().get(r.key)).status, "needs_reconciliation");
  f.receipts.set(hashes.creation, receipt(hashes.creation, [creation()]));
  const ready = await f.api().get(r.key);
  assertEquals([ready.status, ready.stage, ready.scheduleId], ["awaiting_approval", "approval", 7n]);
  await f.walletStore.save({ ...r, approval: { hash: hashes.approval, raw: "0x02", nonce: 2 } });
  f.receipts.set(hashes.approval, receipt(hashes.approval, [approval(99n)]));
  assertEquals((await f.api().get(r.key)).status, "needs_reconciliation");
  f.receipts.set(hashes.approval, receipt(hashes.approval, [approval()]));
  assertEquals([(await f.api().get(r.key)).status, (await f.api().get(r.key)).stage], ["prepared", "execution"]);
  assertEquals((await f.walletStore.get(r.key, r.scope))?.scheduleId, undefined); // get does not persist discovery
  assertEquals(f.calls, { wallet: [], policy: [] });
});

Deno.test("lifecycle discovers a regular executor's payment after sender restart", async () => {
  const f = fixture(); const r = f.walletRecord(); await f.walletStore.save(r);
  f.receipts.set(hashes.creation, receipt(hashes.creation, [creation()]));
  f.receipts.set(hashes.external, receipt(hashes.external, [run()])); f.state.running = [run()]; f.state.schedule.runsExecuted = 1; f.state.schedule.active = false;
  const operation = await f.api().get(r.key);
  assertEquals([operation.status, operation.stage, operation.hash, operation.proof?.kind], ["included", "payment", hashes.external, "run"]);
  await f.api().reconcile(r.key);
  assertEquals(f.calls.wallet.length, 0);
  assertEquals((await f.walletStore.get(r.key, r.scope))?.paymentHash, undefined);
});

Deno.test("lifecycle wallet finality contradiction cannot fall through another candidate to inclusion", async () => {
  const f = fixture(); const r = f.walletRecord({ paymentHash: hashes.external }); await f.walletStore.save(r);
  f.receipts.set(hashes.creation, receipt(hashes.creation, [creation()])); f.receipts.set(hashes.external, receipt(hashes.external, [run()]));
  f.state.running = [run()]; f.state.schedule.runsExecuted = 1; f.state.finalized = 100n;
  const actual = makeReceipts(f.ctx); let contradicted = false;
  const proofs: Receipts = { verify: async (input) => { if (input.finality === "finalized" && !contradicted) { contradicted = true; throw new RemessoError("conflict", "canonical block changed"); } return await actual.verify(input); } };
  assertEquals((await f.api(proofs).get(r.key)).status, "needs_reconciliation");
  assert(contradicted);
});

Deno.test("lifecycle reports external cancellation, pause and expiry without resuming", async () => {
  const f = fixture(); const r = f.walletRecord(); await f.walletStore.save(r); f.receipts.set(hashes.creation, receipt(hashes.creation, [creation()]));
  f.state.schedule.cancelled = true;
  assertEquals((await f.api().reconcile(r.key)).status, "cancelled");
  f.state.schedule.cancelled = false; f.state.schedule.active = false;
  assertEquals((await f.api().get(r.key)).status, "paused");
  await assertRejects(() => f.api().wait(r.key, { timeoutMs: 1000 }), RemessoError);
  // V5 still runs a schedule at exactly its expiry; only after it is final.
  f.state.schedule.active = true; f.state.now = 2_000_000_000n;
  assert((await f.api().get(r.key)).status !== "expired");
  f.state.now = 2_000_000_001n;
  assertEquals((await f.api().reconcile(r.key)).status, "expired");
  assertEquals(f.calls.wallet.length, 0);
});

Deno.test("lifecycle reconciliation requires saved keys and preserves exact funding terms and deadline", async () => {
  const f = fixture(); await assertRejects(() => f.api().reconcile("unknown"), RemessoError);
  assertEquals(f.calls, { wallet: [], policy: [] });
  const p = f.policy({ validUntil: 2_000_000_000 }); await f.store.save(p); await f.api().reconcile(p.key!, { funding: "policy", waitMs: 12 });
  assertEquals(f.calls.policy, [{ to: recipient, amount: "1", token: asset.address, policyId: "9", payer: owner, memo: "order-9", idempotencyKey: "policy-key", waitMs: 12, validUntil: 2_000_000_000 }]);
  // A payment saved but never signed is left for its own caller to start.
  const unstarted = f.walletRecord({ key: "unstarted", creation: undefined }); await f.walletStore.save(unstarted);
  assertEquals((await f.api().reconcile(unstarted.key, { funding: "wallet" })).status, "prepared");
  assertEquals(f.calls.wallet, []);
  const r = f.walletRecord({ requestId: "request-7", validUntil: 2_000_000_000 }); await f.walletStore.save(r); await f.api().reconcile(r.key, { funding: "wallet", waitMs: 13 });
  assertEquals(f.calls.wallet, [{ to: recipient, amount: "1", token: asset.address, idempotencyKey: "wallet-key", requestId: "request-7", waitMs: 13, validUntil: 2_000_000_000 }]);
});

Deno.test("lifecycle requires explicit funding for ambiguous keys and validates list network and input", async () => {
  const f = fixture(); await f.store.save(f.policy({ key: "same" })); await f.walletStore.save(f.walletRecord({ key: "same", creation: undefined }));
  assertEquals((await assertRejects(() => f.api().get("same"), RemessoError)).code, "conflict");
  assertEquals((await f.api().get("same", { funding: "wallet" })).funding, "wallet");
  await assertRejects(() => f.api().listPending({ funding: "other" as "wallet" }), RemessoError);
  f.state.chainId = 1;
  assertEquals((await assertRejects(() => f.api().listPending(), RemessoError)).code, "wrong_chain");
});

Deno.test("lifecycle finality wait honors abort and timeout during an in-flight read", async () => {
  const f = fixture(); await f.store.save(f.policy()); f.setDelay(120);
  const abort = new AbortController(); setTimeout(() => abort.abort(), 10);
  assertEquals((await assertRejects(() => f.api().wait("policy-key", { signal: abort.signal, timeoutMs: 1000 }), RemessoError)).code, "timeout");
  assertEquals(f.completedReads(), 0);
  assertEquals((await assertRejects(() => f.api().wait("policy-key", { timeoutMs: 10 }), RemessoError)).code, "timeout");
  await pause(150); // Allow uncancelable read-only RPC fixtures to settle.
  assertEquals(f.calls, { wallet: [], policy: [] });
});

Deno.test("lifecycle lists legacy pending policy keys without migrating or duplicating them", async () => {
  const f = fixture(); const legacy = f.policy({ deployment: DEPLOYMENT, owner: undefined }); await f.store.save(legacy);
  assertEquals((await f.api().listPending({ funding: "policy" })).map((r) => r.key), [legacy.key]);
  assertEquals(await f.store.byKey(legacy.key!, paymentScope(f.ctx)), undefined);
  await f.store.save(f.policy());
  assertEquals((await f.api().listPending({ funding: "policy" })).length, 1);
  assertEquals(f.calls, { wallet: [], policy: [] });
});

Deno.test("lifecycle never confirms a schedule run counter without an independently verified event", async () => {
  const f = fixture(); const r = f.walletRecord(); await f.walletStore.save(r);
  f.receipts.set(hashes.creation, receipt(hashes.creation, [creation()])); f.state.schedule.runsExecuted = 1; f.state.schedule.active = false;
  const result = await f.api().get(r.key);
  assertEquals([result.status, result.proof], ["needs_reconciliation", undefined]);
});

Deno.test("lifecycle recovery visits saved operations sequentially and respects funding and limit", async () => {
  const f = fixture(); await f.store.save(f.policy());
  await f.walletStore.save(f.walletRecord({ key: "never-signed", creation: undefined }));
  await f.walletStore.save(f.walletRecord({ key: "one" })); await f.walletStore.save(f.walletRecord({ key: "two" }));
  const recovered = await f.api().recoverPending({ funding: "wallet", limit: 1, waitMs: 1 });
  assertEquals(recovered.map((r) => [r.key, r.funding]), [["one", "wallet"]]);
  assertEquals([f.calls.wallet.length, f.calls.policy.length], [1, 0]);
  await assertRejects(() => f.api().recoverPending({ limit: 0 }), RemessoError);
  const abort = new AbortController(); abort.abort(); await assertRejects(() => f.api().recoverPending({ signal: abort.signal }), RemessoError);
});

Deno.test("lifecycle reads a schedule at the block whose time it compares, so a paid one isn't called expired", async () => {
  const f = fixture(); const r = f.walletRecord(); await f.walletStore.save(r);
  f.receipts.set(hashes.creation, receipt(hashes.creation, [creation()]));
  f.receipts.set(hashes.external, receipt(hashes.external, [run()]));
  f.state.running = [run()];
  f.state.now = 2_000_000_100n; // past the schedule's expiry
  const ran = { ...f.state.schedule, runsExecuted: 1, active: false };
  // A lagging node answers a read at no particular block with the state before the run.
  f.state.scheduleAt = (blockNumber) => blockNumber === undefined ? f.state.schedule : ran;
  assertEquals((await f.api().get(r.key)).status, "included");
});

Deno.test("listing counts how long ago a payment settled, not how long ago it was saved", async () => {
  const f = fixture(); const hoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  f.receipts.set(hashes.policy, receipt(hashes.policy, [paid()]));
  // Signed three hours ago, landed just now, not final yet: still listed.
  await f.store.save(f.policy({ at: hoursAgo, status: "confirmed", settledAt: new Date().toISOString() }));
  assertEquals((await f.api().listPending({ funding: "policy" })).map((o) => o.status), ["included"]);
  // Settled three hours ago: final, and left out without a read.
  await f.store.save(f.policy({ at: hoursAgo, status: "confirmed", settledAt: hoursAgo }));
  assertEquals(await f.api().listPending({ funding: "policy" }), []);
});
