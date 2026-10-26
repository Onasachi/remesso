/// Operational views use canonical payment evidence; reconciliation resumes only
/// existing durable keys. Reads never sign, broadcast or change the journals.
import { formatUnits, hexToString, parseAbi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { allowanceAbi, executorAbi } from "./abi.js";
import { type Ctx, receiptOf } from "./context.js";
import { ALLOWANCE, EXECUTOR, token as tokenOf } from "./deployment.js";
import { RemessoError } from "./errors.js";
import { DEPLOYMENT, memo32, paymentScope, priorPayment, type PayInput, type PaymentResult } from "./payments.js";
import type { Receipts, PaymentProof, VerifyPaymentInput } from "./receipts.js";
import type { RemittanceRecord, RemittanceStep, RemittanceStore } from "./remittance-store.js";
import type { PaymentRecord } from "./store.js";
import { remittanceScope, type WalletRemittances } from "./wallet-remittances.js";

export type PaymentStage = "creation" | "approval" | "execution" | "payment" | "cancellation";
export type PaymentStatus = "prepared" | "awaiting_approval" | "signed" | "broadcast" | "included" | "finalized" | "failed" | "cancelled" | "paused" | "expired" | "needs_reconciliation";
export type PaymentOperation = {
  key: string; funding: "wallet" | "policy"; status: PaymentStatus; stage: PaymentStage;
  payer: Address; to: Address; token: Address; amount: bigint; createdAt: string;
  hash?: Hex; scheduleId?: bigint; policyId?: bigint; requestId?: string;
  proof?: PaymentProof; error?: { code: string; message: string; reason?: "nonce_consumed" };
};
export type LifecycleOptions = { funding?: "wallet" | "policy" };
export type WaitPaymentOptions = LifecycleOptions & { finality?: "included" | "finalized"; timeoutMs?: number; intervalMs?: number; signal?: AbortSignal };
/** Signal stops before the next saved payment; a transaction already signed or
 * broadcast must finish its durable recovery rather than be abandoned. */
export type RecoverPendingOptions = LifecycleOptions & { limit?: number; waitMs?: number; signal?: AbortSignal };
type Stored = { funding: "wallet"; record: RemittanceRecord } | { funding: "policy"; record: PaymentRecord };
type Schedule = { sender: Address; destination: Address; token: Address; amountIn: bigint; interval: bigint; maxRuns: number; payoutType: number; feeBps: number; runsExecuted: number; active: boolean; cancelled: boolean; expiresAt: bigint };
const APPROVAL = parseAbi(["event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const conflict = (message: string) => new RemessoError("conflict", message);
const errorOf = (e: unknown) => ({ code: e instanceof RemessoError ? e.code : "rpc", message: String((e as Error)?.message ?? e) });
const finalityError = (e: unknown) => new RemessoError(e instanceof RemessoError ? e.code : "conflict", String((e as Error)?.message ?? e), { lifecycleFinality: true });
const stopped = new Set<PaymentStatus>(["failed", "cancelled", "expired"]);
/// Older than this and settled, a saved payment is final: listing and
/// recovery skip it rather than read the chain for it again.
const SETTLED_MS = 2 * 3_600_000;
function validate(options: LifecycleOptions) {
  if (options.funding !== undefined && options.funding !== "wallet" && options.funding !== "policy") throw new RemessoError("invalid", "funding must be wallet or policy");
}
function waitBudget(value?: number) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 120_000)) throw new RemessoError("invalid", "waitMs must be from 1 to 120000 milliseconds");
}
const aborted = () => new RemessoError("timeout", "payment wait was aborted");
function timed<T>(read: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(aborted());
  if (Date.now() >= deadline) return Promise.reject(new RemessoError("timeout", "payment has not reached the requested finality"));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(aborted()); };
    const timer = setTimeout(() => { cleanup(); reject(new RemessoError("timeout", "payment has not reached the requested finality")); }, deadline - Date.now());
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    Promise.resolve().then(read).then((result) => { cleanup(); resolve(result); }, (e) => { cleanup(); reject(e); });
  });
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(aborted()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export function makeLifecycle(ctx: Ctx, deps: { store: RemittanceStore; wallet: WalletRemittances; receipts: Receipts; pay(input: PayInput): Promise<PaymentResult> }) {
  function walletIdentity(r: RemittanceRecord, key = r.key) {
    if (r.key !== key || r.scope !== remittanceScope(ctx) || !same(r.payer, ctx.requireAccount().address)) throw conflict("the wallet journal returned another payment's identity");
  }
  function policyIdentity(r: PaymentRecord, key = r.key) {
    if (!key || r.key !== key || r.deployment !== paymentScope(ctx)) throw conflict("the policy journal returned another payment's identity");
  }
  async function load(key: string, options: LifecycleOptions = {}): Promise<Stored> {
    if (typeof key !== "string" || !key.trim()) throw new RemessoError("invalid", "an existing payment key is required");
    validate(options);
    const wallet = options.funding !== "policy" ? await deps.store.get(key, remittanceScope(ctx)) : undefined;
    const policy = options.funding !== "wallet" ? await priorPayment(ctx, key) : undefined;
    if (wallet) walletIdentity(wallet, key);
    if (policy) policyIdentity(policy, key);
    if (wallet && policy) throw conflict("this key exists in both funding journals; choose funding explicitly");
    if (wallet) return { funding: "wallet", record: wallet };
    if (policy) return { funding: "policy", record: policy };
    throw new RemessoError("not_found", "no saved payment owns this key; reconciliation never creates a new payment");
  }
  async function receipt(hash: Hex): Promise<TransactionReceipt | null> {
    const found = await receiptOf(ctx.pub, hash);
    if (!found) return null;
    if (!same(found.transactionHash, hash)) throw conflict("a replacement receipt is not proof this operation succeeded");
    const block = await ctx.pub.getBlock({ blockNumber: found.blockNumber });
    if (block.number !== found.blockNumber || !block.hash || !same(block.hash, found.blockHash)) throw conflict("the saved transaction's block was reorganized");
    return found;
  }
  function logs(found: TransactionReceipt) {
    return found.logs.filter((log) => !log.removed && log.transactionHash && same(log.transactionHash, found.transactionHash) &&
      log.blockHash && same(log.blockHash, found.blockHash) && log.blockNumber === found.blockNumber && Number.isSafeInteger(log.logIndex) && log.logIndex! >= 0);
  }
  async function pending(base: PaymentOperation, step: RemittanceStep): Promise<PaymentOperation> {
    const known = await ctx.pub.getTransaction({ hash: step.hash }).catch((e: unknown) => {
      if ((e as { name?: string }).name === "TransactionNotFoundError") return null;
      throw e;
    });
    if (known) {
      if (!same(known.hash, step.hash)) throw conflict("the RPC returned another transaction for this signed step");
      return { ...base, hash: step.hash, status: "broadcast" };
    }
    const used = await ctx.pub.getTransactionCount({ address: ctx.requireAccount().address, blockTag: "latest" });
    return used > step.nonce ? { ...base, hash: step.hash, status: "needs_reconciliation", error: { code: "conflict", reason: "nonce_consumed", message: "the original receipt is unavailable and its nonce was consumed" } }
      : { ...base, hash: step.hash, status: "signed" };
  }
  async function proof(base: PaymentOperation, hash: Hex, memo?: string): Promise<PaymentOperation> {
    const input: VerifyPaymentInput = { txHash: hash, from: base.payer, to: base.to, token: base.token,
      amount: formatUnits(base.amount, tokenOf(base.token).decimals), ...(base.policyId ? { policyId: base.policyId, memo } : { scheduleId: base.scheduleId }) };
    const included = await deps.receipts.verify({ ...input, finality: "included" });
    let finalized;
    try { finalized = await ctx.pub.getBlock({ blockTag: "finalized" }); }
    catch (e) {
      // No finalized-head information is different from a contradictory proof.
      // Recheck inclusion because the first proof may have raced this RPC call.
      if (e instanceof RemessoError && ["conflict", "reverted", "not_found", "wrong_chain"].includes(e.code)) throw finalityError(e);
      const checked = await deps.receipts.verify({ ...input, finality: "included" });
      return { ...base, hash, stage: "payment", status: "included", proof: checked };
    }
    if (typeof finalized.number === "bigint" && finalized.number >= included.blockNumber) {
      // A conflicting second verification must never fall back to inclusion.
      let final: PaymentProof;
      try { final = await deps.receipts.verify({ ...input, finality: "finalized" }); }
      catch (e) { throw finalityError(e); }
      return { ...base, hash, stage: "payment", status: "finalized", proof: final };
    }
    return { ...base, hash, stage: "payment", status: "included", proof: included };
  }
  function originalMemo(r: PaymentRecord): string {
    const memo = hexToString(r.memo).replace(/\0+$/, "");
    if (!same(memo32(memo), r.memo)) throw conflict("the saved payment memo cannot be round-tripped without changing its original bytes");
    return memo;
  }
  async function walletDescription(r: RemittanceRecord, base: PaymentOperation): Promise<PaymentOperation> {
    if (!r.creation) {
      if (r.scheduleId || r.approval || r.execution || r.paymentHash || r.cancellation) throw conflict("the wallet journal is missing its original signed creation step");
      return base;
    }
    base.hash = r.creation.hash;
    const created = await receipt(r.creation.hash);
    if (!created) return await pending(base, r.creation);
    if (created.status !== "success") return { ...base, status: "failed" };
    if (!same(created.from, r.payer) || !created.to || !same(created.to, EXECUTOR)) throw conflict("the creation transaction does not belong to this wallet and executor");
    const event = parseEventLogs({ abi: executorAbi, eventName: "ScheduleCreated", logs: logs(created) }).find((e) => same(e.address, EXECUTOR) &&
      same(e.args.sender, r.payer) && same(e.args.destination, r.to) && e.args.amountIn === BigInt(r.amountIn) &&
      e.args.interval === 3600n && e.args.maxRuns === 1 && e.args.payoutType === 2 && e.args.expiresAt === BigInt(r.expiresAt));
    if (!event || r.scheduleId && BigInt(r.scheduleId) !== event.args.id) throw conflict("the creation receipt has no matching original one-payment schedule event");
    base.scheduleId = event.args.id;
    base.stage = r.execution ? "execution" : "approval";
    base.hash = r.execution?.hash ?? r.approval?.hash ?? r.creation.hash;
    // Read at the block whose time it is compared with. A lagging node's
    // "never ran" next to another node's later clock reads a paid schedule
    // as expired.
    const now = await ctx.pub.getBlock();
    if (now.number === null || now.number < created.blockNumber) throw conflict("the RPC hasn't reached the payment's creation block yet; read it again");
    const s = await ctx.pub.readContract({ address: EXECUTOR, abi: executorAbi, functionName: "getSchedule", args: [event.args.id], blockNumber: now.number }) as unknown as Schedule;
    if (!same(s.sender, r.payer) || !same(s.destination, r.to) || !same(s.token, r.token) || s.amountIn !== BigInt(r.amountIn) || s.interval !== 3600n || s.maxRuns !== 1 || s.payoutType !== 2) throw conflict("the schedule's immutable terms differ from this wallet remittance");
    let candidateError: unknown;
    for (const hash of [...new Set([r.paymentHash, r.execution?.hash].filter((v): v is Hex => v != null))]) {
      try { return await proof(base, hash); }
      catch (e) {
        if (e instanceof RemessoError && e.details?.lifecycleFinality) throw e;
        // An executor can win the race with our failed runNow. A stale stored
        // payment hash can also be replaced by a newly canonical observed run.
        candidateError = e;
      }
    }
    if (s.runsExecuted > 0 || r.paymentHash) {
      const head = await ctx.pub.getBlockNumber();
      for (let from = created.blockNumber; from <= head; from += 5000n) {
        const found = await ctx.pub.getContractEvents({ address: EXECUTOR, abi: executorAbi, eventName: "RunExecuted", args: { id: event.args.id }, fromBlock: from, toBlock: from + 4999n > head ? head : from + 4999n });
        for (const log of found) {
          if (!log.transactionHash || log.removed) continue;
          try { return await proof(base, log.transactionHash); }
          catch (e) {
            if (e instanceof RemessoError && e.details?.lifecycleFinality) throw e;
            candidateError = e;
          }
        }
      }
      throw candidateError ?? conflict("the schedule reports a run but its exact canonical payment event is unavailable");
    }
    if (r.paymentHash) throw candidateError ?? conflict("the stored payment is no longer canonical");
    // Cancelled, or past its expiry, and never run: it never will be.
    if (s.cancelled) return { ...base, stage: "cancellation", status: "cancelled", ...(r.cancellation ? { hash: r.cancellation.hash } : {}) };
    if (s.expiresAt !== 0n && now.timestamp > s.expiresAt) return { ...base, status: "expired" };
    // A live schedule can still be paid, so a failed step is not a failed payment.
    const live = (stage: PaymentStage, hash: Hex, message: string): PaymentOperation =>
      ({ ...base, stage, hash, status: "needs_reconciliation", error: { code: "reverted", message } });
    if (r.cancellation) {
      base = { ...base, stage: "cancellation", hash: r.cancellation.hash };
      const cancelled = await receipt(r.cancellation.hash);
      if (!cancelled) return await pending(base, r.cancellation);
      if (cancelled.status !== "success") return live("cancellation", r.cancellation.hash, "the cancellation reverted while the schedule is live; reconcile this key");
      const matching = parseEventLogs({ abi: executorAbi, eventName: "ScheduleCancelled", logs: logs(cancelled) }).some((e) => same(e.address, EXECUTOR) && e.args.id === base.scheduleId);
      if (!matching) throw conflict("the cancellation receipt has no matching schedule event");
      return { ...base, status: "cancelled" };
    }
    if (!s.active) return { ...base, status: "paused" };
    if (Number(s.feeBps) !== r.feeBps) throw conflict("the schedule fee differs from the original remittance quote; reconcile to cancel safely");
    if (r.execution) {
      base = { ...base, stage: "execution", hash: r.execution.hash };
      const execution = await receipt(r.execution.hash);
      if (!execution) return await pending(base, r.execution);
      if (execution.status !== "success") return live("execution", r.execution.hash, "running the payment reverted while its schedule is live; reconcile this key to cancel it");
      throw candidateError ?? conflict("the execution receipt has no matching payment event");
    }
    if (r.approvalSkipped) return { ...base, stage: "execution", status: "prepared" };
    base = { ...base, stage: "approval", status: "awaiting_approval" };
    if (!r.approval) return base;
    base.hash = r.approval.hash;
    const approved = await receipt(r.approval.hash);
    if (!approved) return await pending(base, r.approval);
    if (approved.status !== "success") return live("approval", r.approval.hash, "the approval reverted while the schedule is live; reconcile this key to cancel it");
    const matching = parseEventLogs({ abi: APPROVAL, eventName: "Approval", logs: logs(approved) }).some((e) => same(e.address, r.token) && same(e.args.owner, r.payer) && same(e.args.spender, EXECUTOR) && e.args.value === BigInt(r.approvalAmount ?? -1));
    if (!matching) throw conflict("the approval receipt has no matching token, owner, spender and amount event");
    return { ...base, stage: "execution", status: "prepared" };
  }
  async function describe(stored: Stored): Promise<PaymentOperation> {
    if (stored.funding === "wallet") {
      const r = stored.record;
      walletIdentity(r);
      const base: PaymentOperation = { key: r.key, funding: "wallet", status: "prepared", stage: "creation", payer: r.payer, to: r.to, token: r.token, amount: BigInt(r.amount), createdAt: r.createdAt,
        ...(r.scheduleId ? { scheduleId: BigInt(r.scheduleId) } : {}), ...(r.requestId ? { requestId: r.requestId } : {}) };
      try { return await walletDescription(r, base); }
      catch (e) { return { ...base, status: "needs_reconciliation", error: errorOf(e) }; }
    }
    const r = stored.record;
    policyIdentity(r);
    const owner = r.owner ?? (await ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "policy", args: [BigInt(r.policyId)] })).owner;
    const base: PaymentOperation = { key: r.key!, funding: "policy", status: "signed", stage: "payment", payer: owner, to: r.to, token: r.token, amount: BigInt(r.units), createdAt: r.at, policyId: BigInt(r.policyId), hash: r.hash };
    try {
      const found = await receipt(r.hash);
      if (!found) {
        // Its deadline passed unsent and the no-op at its nonce landed.
        if (r.cancel && await receipt(r.cancel.hash)) return { ...base, status: "expired" };
        return await pending(base, r);
      }
      if (found.status !== "success") return { ...base, status: "failed" };
      return await proof(base, r.hash, originalMemo(r));
    } catch (e) { return { ...base, status: "needs_reconciliation", error: errorOf(e) }; }
  }
  async function get(key: string, options: LifecycleOptions = {}): Promise<PaymentOperation> {
    validate(options); await ctx.assertChain(); return await describe(await load(key, options));
  }
  /// Saved payments that may still be unsettled, without reading the chain:
  /// old ones that paid, or whose schedule expired long ago, are left out.
  async function saved(options: LifecycleOptions): Promise<Stored[]> {
    const out: Stored[] = [], now = Date.now();
    if (options.funding !== "policy") {
      for (const r of await deps.store.list(remittanceScope(ctx))) {
        // Settled long enough ago to be final. A payment can land hours after
        // it was saved, so its own settle time counts, not its creation; with
        // none recorded, a schedule expired long ago can't have paid since.
        if (r.settledAt ? now - Date.parse(r.settledAt) > SETTLED_MS : r.expiresAt * 1000 < now - SETTLED_MS) continue;
        out.push({ funding: "wallet", record: r });
      }
    }
    if (options.funding !== "wallet") {
      const records = await ctx.store.since(0);
      const policies = new Map<string, PaymentRecord>();
      for (const r of records) if (r.key && r.deployment === paymentScope(ctx)) policies.set(r.key, r);
      for (const r of records) if (r.key && r.deployment === DEPLOYMENT && !policies.has(r.key)) {
        const owned = await priorPayment(ctx, r.key);
        if (owned) policies.set(r.key, owned);
      }
      for (const record of policies.values()) {
        // Older records carry no settle time: a week since signing stands in.
        const settled = record.settledAt ? now - Date.parse(record.settledAt) > SETTLED_MS : now - Date.parse(record.at) > 7 * 86_400_000;
        if (["confirmed", "reverted", "expired"].includes(record.status) && settled) continue;
        out.push({ funding: "policy", record });
      }
    }
    return out;
  }
  async function listPending(options: LifecycleOptions = {}): Promise<PaymentOperation[]> {
    validate(options); await ctx.assertChain();
    const result: PaymentOperation[] = [];
    for (const stored of await saved(options)) result.push(await describe(stored));
    return result.filter((r) => r.status !== "finalized" && !stopped.has(r.status));
  }
  async function reconcile(key: string, options: LifecycleOptions & { waitMs?: number } = {}): Promise<PaymentOperation> {
    validate(options); waitBudget(options.waitMs); await ctx.assertChain();
    const stored = await load(key, options);
    const before = await describe(stored);
    if (["included", "finalized", "failed", "cancelled", "paused", "expired"].includes(before.status)) return before;
    if (before.error?.reason === "nonce_consumed") return before;
    // A payment saved but never signed is started only by its own caller's
    // retry: someone may have seen it fail and moved on.
    if (stored.funding === "wallet" && !stored.record.creation) return before;
    try {
      if (stored.funding === "wallet") {
        const r = stored.record;
        await deps.wallet.resume({ to: r.to, amount: formatUnits(BigInt(r.amount), tokenOf(r.token).decimals), token: r.token, idempotencyKey: r.key, requestId: r.requestId, waitMs: options.waitMs, validUntil: r.validUntil });
      } else {
        const r = stored.record;
        await deps.pay({ to: r.to, amount: formatUnits(BigInt(r.units), tokenOf(r.token).decimals), token: r.token, policyId: r.policyId, payer: before.payer,
          memo: originalMemo(r), idempotencyKey: r.key!, waitMs: options.waitMs, validUntil: r.validUntil });
      }
    } catch (e) { return { ...await get(key, { funding: stored.funding }), error: errorOf(e) }; }
    return await get(key, { funding: stored.funding });
  }
  async function wait(key: string, options: WaitPaymentOptions = {}): Promise<PaymentOperation> {
    validate(options);
    const timeout = options.timeoutMs ?? 20 * 60_000, interval = options.intervalMs ?? 1500;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000 || !Number.isSafeInteger(interval) || interval < 1 || interval > 60_000) throw new RemessoError("invalid", "timeoutMs must be 1–86400000 and intervalMs 1–60000");
    if (options.finality && !["included", "finalized"].includes(options.finality)) throw new RemessoError("invalid", "finality must be included or finalized");
    const deadline = Date.now() + timeout;
    for (;;) {
      const operation = await timed(() => get(key, options), deadline, options.signal);
      if (options.signal?.aborted) throw aborted();
      if (Date.now() >= deadline) throw new RemessoError("timeout", "payment has not reached the requested finality", { key, operation });
      if (operation.status === "finalized" || options.finality !== "finalized" && operation.status === "included") return operation;
      if (stopped.has(operation.status) || operation.status === "paused") throw new RemessoError(operation.status === "failed" ? "reverted" : "refused", `payment ${operation.status}`, { key, operation });
      await sleep(Math.min(interval, deadline - Date.now()), options.signal);
    }
  }
  async function recoverPending(options: RecoverPendingOptions = {}): Promise<PaymentOperation[]> {
    validate(options); waitBudget(options.waitMs);
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RemessoError("invalid", "limit must be from 1 to 1000");
    if (options.signal?.aborted) throw aborted();
    await ctx.assertChain();
    // Started payments only, chosen without reading the chain, so `limit`
    // bounds the work as well as the result.
    const started = (await saved(options)).filter((s) => s.funding === "policy" ? s.record.status === "sent" || s.record.status === "unsent" : s.record.creation && !s.record.paymentHash);
    const recovered: PaymentOperation[] = [];
    for (const stored of started.slice(0, limit)) {
      if (options.signal?.aborted) throw aborted();
      const key = stored.funding === "wallet" ? stored.record.key : stored.record.key!;
      recovered.push(await reconcile(key, { funding: stored.funding, waitMs: options.waitMs }));
    }
    return recovered;
  }
  return { get, listPending, reconcile, wait, recoverPending };
}
export type Lifecycle = ReturnType<typeof makeLifecycle>;
