/// One wallet-funded remittance is one immutable V5 Direct schedule with a
/// lifetime cap of one run. The payer runs it immediately; the existing event
/// indexer, request binding and webhooks observe exactly the same contract.
///
/// Once its schedule exists, "nothing was paid" has to stay true: a live,
/// approved schedule is still paid by Remesso's executor at its first run
/// time. So a payment that can't be completed is cancelled first, and only a
/// schedule that is cancelled or expired and never ran counts as not paid.
/// Every other outcome is pending, and a retry of the same key continues it.
import {
  type Abi, type Address, type Hex, type TransactionReceipt,
  concat, encodeFunctionData, keccak256, parseAbi, parseEventLogs, zeroAddress,
} from "viem";
import { getTransactionCount, prepareTransactionRequest, signTransaction } from "viem/actions";
import { erc20Abi, executorAbi } from "./abi.js";
import { type Ctx, gasFor, type OpenTx, receiptOf, refusal, untilVisible } from "./context.js";
import { CHAIN_ID, EXECUTOR, checksum, runLimits, token as tokenOf, toUnits } from "./deployment.js";
import { RemessoError } from "./errors.js";
import type { RequestStatus } from "./requests.js";
import type { RemittanceRecord, RemittanceStep, RemittanceStore } from "./remittance-store.js";
import { grossFor, netOf } from "./vendor/fee.js";

export type WalletRemittanceInput = {
  to: string;
  /** Exact amount the recipient receives, as a decimal string. */
  amount: string;
  token: string;
  /** Stable identifier for this intended payment, required for restart recovery. */
  idempotencyKey: string;
  /** A fixed, one-off request, addressed to this wallet. */
  requestId?: string;
  /** Whole-call receipt wait budget, 1–120000 ms. Default 45000. */
  waitMs?: number;
  maxDebit?: string;
  /**
   * Unix second the payment must land before: the schedule expires a second
   * earlier, so the contract refuses a late run. Nothing starts within three
   * minutes of it. A retry can't change it.
   */
  validUntil?: number;
  /** Don't start at or after this Unix second (a quote's expiry). Ignored once the key has a saved payment. */
  startBy?: number;
};

export type WalletRemittanceStage = "creation" | "approval" | "execution" | "payment" | "cancellation";

export type WalletRemittanceResult = {
  funding: "wallet";
  /** Pending may still be paid: retry the same key, never a new one. */
  status: "confirmed" | "pending";
  /** The step a pending payment is at. */
  stage: WalletRemittanceStage;
  payer: Address;
  to: Address;
  token: Address;
  amount: bigint;
  amountIn: bigint;
  fee: bigint;
  feeBps: number;
  /** The RunExecuted transaction, present only after payment evidence exists. */
  hash?: Hex;
  scheduleId?: bigint;
  approvalHash?: Hex;
  createHash?: Hex;
  executionHash?: Hex;
  /** Signed because the payment couldn't be completed; until it lands the payment is still pending. */
  cancellationHash?: Hex;
  /** This key already had a saved remittance; no second schedule is created. */
  repeat?: boolean;
  request?: { id: string; bound: boolean; error?: string };
};

type Deps = {
  store: RemittanceStore;
  getRequest(id: string): Promise<RequestStatus>;
  answer(id: string, scheduleId: bigint): Promise<{ status: string; signed: unknown }>;
};
type Schedule = {
  sender: Address; destination: Address; token: Address; amountIn: bigint;
  interval: bigint; maxRuns: number; payoutType: number; feeBps: number;
  runsExecuted: number; cancelled: boolean; active: boolean; expiresAt: bigint;
};

const APPROVAL = parseAbi(["event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const INTERVAL = 3600n;
/// A mandate lives a day at most: long enough for a slow retry, short enough
/// that an abandoned one stops mattering soon.
const LIFETIME = 86_400n;
/// Three transactions have to fit before a deadline.
const START_MARGIN_S = 180;
/// Right after an approval lands, a node a block behind still refuses runNow.
const RUN_RETRY_MS = 8_000;
/// An allowance this large is unlimited for every practical purpose.
const UNLIMITED = 2n ** 255n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const notFound = (e: unknown) => (e as { name?: string })?.name === "TransactionNotFoundError";
const conflict = (message: string, details?: Record<string, unknown>) => new RemessoError("conflict", message, details);
export const remittanceScope = (ctx: Ctx) => `${CHAIN_ID}:${EXECUTOR.toLowerCase()}:${ctx.requireAccount().address.toLowerCase()}`;

export function makeWalletRemittances(ctx: Ctx, deps: Deps) {
  const save = async (record: RemittanceRecord) => { await ctx.assertActive(); await deps.store.save(record); };
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.pub.readContract({ address: EXECUTOR, abi: executorAbi, functionName, args } as never) as Promise<T>;

  function local() {
    const account = ctx.requireAccount();
    if (account.type !== "local") throw new RemessoError("no_account", "wallet remittances need a local account so each transaction can be saved before broadcasting");
    if (ctx.pub.chain?.id !== CHAIN_ID) throw new RemessoError("invalid", "wallet remittances need publicClient configured with chain: celo");
    return account;
  }

  function journalIdentity(record: RemittanceRecord, key?: string): void {
    if (record.scope !== remittanceScope(ctx) || typeof record.payer !== "string" || !same(record.payer, local().address) || typeof record.key !== "string" || !record.key.trim() || (key != null && record.key !== key)) {
      throw new RemessoError("conflict", "the remittance store returned a record for another key, signer or deployment; restore the correct journal before sending");
    }
    for (const step of [record.approval, record.creation, record.execution, record.cancellation]) {
      if (step && (!Number.isSafeInteger(step.nonce) || step.nonce < 0 || step.nonce >= Number.MAX_SAFE_INTEGER)) throw new RemessoError("conflict", "the remittance store contains an invalid transaction nonce");
    }
  }

  // Every saved step not yet seen on-chain, for the next nonce to respect. Each
  // is safe to send again: the contract holds the schedule to its own expiry.
  if (ctx.account) {
    ctx.addJournal(async (fromNonce) => {
      const open: OpenTx[] = [];
      for (const r of await deps.store.list(remittanceScope(ctx))) {
        journalIdentity(r);
        for (const step of [r.creation, r.approval, r.execution, r.cancellation]) {
          if (step && step.nonce >= fromNonce) open.push({ nonce: step.nonce, hash: step.hash, raw: step.raw, savedAt: Date.parse(r.createdAt), resend: true });
        }
      }
      return open;
    });
  }

  function result(record: RemittanceRecord, stage: WalletRemittanceStage, requestError?: string): WalletRemittanceResult {
    return {
      funding: "wallet", status: record.paymentHash ? "confirmed" : "pending", stage: record.paymentHash ? "payment" : stage,
      payer: record.payer, to: record.to, token: record.token,
      amount: BigInt(record.amount), amountIn: BigInt(record.amountIn), fee: BigInt(record.fee), feeBps: record.feeBps,
      ...(record.paymentHash ? { hash: record.paymentHash } : {}),
      ...(record.scheduleId ? { scheduleId: BigInt(record.scheduleId) } : {}),
      ...(record.approval ? { approvalHash: record.approval.hash } : {}),
      ...(record.creation ? { createHash: record.creation.hash } : {}),
      ...(record.execution ? { executionHash: record.execution.hash } : {}),
      ...(record.cancellation ? { cancellationHash: record.cancellation.hash } : {}),
      ...(record.requestId ? { request: { id: record.requestId, bound: record.requestBound === true, ...(requestError ? { error: requestError } : {}) } } : {}),
    };
  }

  /// Sign one step at the next nonce. Nothing is sent here.
  async function signStep(record: RemittanceRecord, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<RemittanceStep> {
    const account = local();
    const fee = await gasFor(ctx, tokenOf(record.token));
    const nonce = await ctx.nextNonce();
    const data = encodeFunctionData({ abi, functionName, args });
    const request = await prepareTransactionRequest(ctx.pub, {
      account, nonce, to: address, data: ctx.dataSuffix ? concat([data, ctx.dataSuffix]) : data, ...fee,
    } as never);
    await ctx.assertActive();
    const raw = await signTransaction(ctx.pub, { ...request, account } as never);
    return { raw, hash: keccak256(raw), nonce: Number((request as { nonce: number }).nonce) };
  }

  /// After the schedule exists, a step that can't even be prepared leaves the
  /// payment pending, never refused: the schedule could still be paid.
  async function signLater(record: RemittanceRecord, what: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<RemittanceStep> {
    try {
      return await signStep(record, address, abi, functionName, args);
    } catch (e) {
      if (e instanceof RemessoError && ["no_gas", "wrong_chain", "no_account", "conflict", "invalid"].includes(e.code)) throw e;
      throw conflict(`couldn't prepare the ${what}: ${refusal(e)}. The payment's schedule exists, so it may still be paid: retry this key`, { scheduleId: record.scheduleId });
    }
  }

  /// Saved before it is broadcast: a step that went out is never signed twice.
  async function sendStep(record: RemittanceRecord, step: "creation" | "approval" | "execution" | "cancellation", signed: RemittanceStep, extra: Partial<RemittanceRecord> = {}) {
    Object.assign(record, extra, { [step]: signed });
    await save(record);
    await ctx.noteNonce(signed.nonce);
    await ctx.resend(signed.raw);
  }

  /// A step's receipt. Bytes no node has are sent again: only original bytes
  /// are ever rebroadcast, never another approval or another schedule.
  async function stepReceipt(step: RemittanceStep, deadline: number): Promise<TransactionReceipt | null> {
    let found = await receiptOf(ctx.pub, step.hash);
    if (!found) {
      const known = await ctx.pub.getTransaction({ hash: step.hash }).catch((e: unknown) => {
        if (notFound(e)) return null;
        throw e;
      });
      if (!known) {
        const used = await getTransactionCount(ctx.pub, { address: local().address, blockTag: "latest" });
        if (used > step.nonce) throw conflict("the remittance nonce was consumed but its original receipt is unavailable; reconcile the original hash before continuing", { hash: step.hash, nonce: step.nonce });
        // A lost transaction below it would hold it up: fill that gap first.
        await ctx.unblock(step.nonce);
        await ctx.resend(step.raw);
      }
      if (Date.now() < deadline) found = await ctx.pub.waitForTransactionReceipt({ hash: step.hash, timeout: Math.max(1, deadline - Date.now()) }).catch(() => null);
    }
    if (found && !same(found.transactionHash, step.hash)) throw conflict("a replacement transaction is not proof this remittance step succeeded", { hash: step.hash, replacement: found.transactionHash });
    return found;
  }

  const createArgs = (r: RemittanceRecord) => [r.to, BigInt(r.amountIn), INTERVAL, 0n, 1, BigInt(r.expiresAt), BigInt(r.firstRunAt), 2, r.token, zeroAddress, r.payer, 1] as const;

  function created(found: TransactionReceipt, r: RemittanceRecord): bigint {
    const logs = parseEventLogs({ abi: executorAbi, eventName: "ScheduleCreated", logs: found.logs });
    const hit = logs.find((log) => same(log.address, EXECUTOR) && same(log.args.sender, r.payer) && same(log.args.destination, r.to) &&
      log.args.amountIn === BigInt(r.amountIn) && log.args.interval === INTERVAL && log.args.maxRuns === 1 && log.args.payoutType === 2 && log.args.expiresAt === BigInt(r.expiresAt));
    if (!hit) throw conflict("the creation receipt has no matching one-payment ScheduleCreated event", { hash: found.transactionHash });
    if (r.scheduleId && BigInt(r.scheduleId) !== hit.args.id) throw conflict("the recorded schedule does not match its original creation receipt");
    return hit.args.id;
  }

  function payment(found: TransactionReceipt, r: RemittanceRecord): boolean {
    if (found.status !== "success") return false;
    return parseEventLogs({ abi: executorAbi, eventName: "RunExecuted", logs: found.logs }).some((log) => same(log.address, EXECUTOR) &&
      log.args.id === BigInt(r.scheduleId!) && same(log.args.sender, r.payer) && same(log.args.destination, r.to) &&
      log.args.amountIn === BigInt(r.amountIn) && log.args.amountOut === BigInt(r.amount) && log.args.runsExecuted === 1);
  }

  /// The schedule as of one block, with that block's time, at or after
  /// `atLeast`. Null while the RPC can't show that block: a state from before a
  /// receipt we hold is no basis for any decision, so the payment stays pending.
  async function state(r: RemittanceRecord, atLeast = 0n): Promise<{ s: Schedule; at: bigint } | null> {
    const { s, at, fresh } = await untilVisible(async () => {
      const head = await ctx.pub.getBlock();
      // A receipt can come from a node ahead of the one answering now.
      const block = head.number !== null && head.number >= atLeast ? head : await ctx.pub.getBlock({ blockNumber: atLeast }).catch(() => head);
      const s = await ctx.pub.readContract({ address: EXECUTOR, abi: executorAbi, functionName: "getSchedule", args: [BigInt(r.scheduleId!)], blockNumber: block.number! }) as unknown as Schedule;
      return { s, at: block.timestamp, fresh: block.number !== null && block.number >= atLeast };
    }, (v) => v.fresh && !same(v.s.sender, zeroAddress));
    if (!fresh || same(s.sender, zeroAddress)) return null;
    if (!same(s.sender, r.payer) || !same(s.destination, r.to) || !same(s.token, r.token) || s.amountIn !== BigInt(r.amountIn) ||
      s.interval !== INTERVAL || s.maxRuns !== 1 || s.payoutType !== 2) {
      throw conflict("the created schedule's immutable terms do not match this exact remittance; no payment is sent");
    }
    return { s, at };
  }

  /// The run that paid this schedule: ours, or Remesso's executor if it won
  /// the race. Searched from the schedule's creation; maxRuns=1 means one.
  async function paidHash(r: RemittanceRecord): Promise<Hex | null> {
    if (r.paymentHash) {
      const found = await receiptOf(ctx.pub, r.paymentHash);
      if (found && same(found.transactionHash, r.paymentHash) && payment(found, r)) return r.paymentHash;
      // Do not return a stale stored confirmation after a reorg.
      delete r.paymentHash;
      await save(r);
    }
    const head = await ctx.pub.getBlockNumber();
    for (let from = BigInt(r.creationBlock!); from <= head; from += 5000n) {
      const to = from + 4999n > head ? head : from + 4999n;
      let logs;
      try {
        logs = await ctx.pub.getContractEvents({ address: EXECUTOR, abi: executorAbi, eventName: "RunExecuted", args: { id: BigInt(r.scheduleId!) }, fromBlock: from, toBlock: to });
      } catch (e) {
        // A node a block behind answers "block is out of range": not yet.
        if (/out of range/i.test(String((e as Error)?.message ?? e))) return null;
        throw e;
      }
      for (const log of logs) {
        if (!log.transactionHash || log.removed) continue;
        const found = await receiptOf(ctx.pub, log.transactionHash);
        if (found && same(found.transactionHash, log.transactionHash) && payment(found, r)) return found.transactionHash;
      }
    }
    return null;
  }

  async function bind(r: RemittanceRecord): Promise<string | undefined> {
    if (!r.requestId || r.requestBound || !r.scheduleId) return;
    try {
      const answer = await deps.answer(r.requestId, BigInt(r.scheduleId));
      if (answer.status !== "accepted") throw new Error(`the request was answered as ${answer.status}`);
      r.requestBound = true;
      await save(r);
    } catch (e) { return String((e as Error).message); }
  }

  /// Whether this schedule may still pay its request: bound to it now, waiting
  /// on the backend, or never (declined, expired, or answered by another).
  async function requestStanding(r: RemittanceRecord): Promise<"bound" | "waiting" | string> {
    const req = await deps.getRequest(r.requestId!).catch(() => null);
    if (!req) return "waiting";
    const answered = req.payment?.schedule;
    if (answered && same(answered.contract, EXECUTOR) && answered.id === r.scheduleId) {
      r.requestBound = true;
      await save(r);
      return "bound";
    }
    if (answered) return "another payment answers it";
    return req.status === "pending" ? "waiting" : `it is ${req.status}`;
  }

  /// runNow simulates cleanly, or why not after a few seconds of retries.
  async function runnable(r: RemittanceRecord, deadline: number): Promise<string | null> {
    const until = Math.min(deadline, Date.now() + RUN_RETRY_MS);
    for (;;) {
      try {
        await ctx.pub.simulateContract({ address: EXECUTOR, abi: executorAbi, functionName: "runNow", args: [BigInt(r.scheduleId!), 0n], account: local() });
        return null;
      } catch (e) {
        if (Date.now() >= until) return refusal(e);
        await new Promise((res) => setTimeout(res, 1_500));
      }
    }
  }

  /// Another payment's approval not yet mined: approving on top of an
  /// allowance read now would undo it.
  async function approvalInFlight(r: RemittanceRecord): Promise<boolean> {
    // If its broadcast was lost, waiting on it would wait forever: send it again.
    await ctx.unblock(Number.MAX_SAFE_INTEGER);
    const used = await getTransactionCount(ctx.pub, { address: local().address, blockTag: "latest" });
    return (await deps.store.list(r.scope)).some((other) => other.key !== r.key && other.approval && other.approval.nonce >= used);
  }

  return {
    send: (input: WalletRemittanceInput) => ctx.serial(() => proceed(input, true)),
    /** Continue a saved payment that has started. Never starts one. */
    resume: (input: WalletRemittanceInput) => ctx.serial(() => proceed(input, false)),
  };

  async function proceed(input: WalletRemittanceInput, mayStart: boolean): Promise<WalletRemittanceResult> {
    const account = local();
    await ctx.assertChain();
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()) throw new RemessoError("invalid", "idempotencyKey is required for a wallet remittance");
    const waitMs = input.waitMs ?? 45_000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 120_000) throw new RemessoError("invalid", "waitMs must be from 1 to 120000 milliseconds");
    for (const [name, value] of [["validUntil", input.validUntil], ["startBy", input.startBy]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new RemessoError("invalid", `${name} must be a Unix time in seconds`);
    }
    const deadline = Date.now() + waitMs;
    const to = checksum(input.to);
    if (BigInt(to) < 0x10000n || same(to, EXECUTOR) || same(to, account.address)) throw new RemessoError("invalid", "to must be another wallet and a valid schedule destination");
    const t = tokenOf(input.token);
    const amount = toUnits(input.amount, t);
    if (amount <= 0n) throw new RemessoError("invalid", "amount must be above zero");
    const scope = remittanceScope(ctx);
    let r = await deps.store.get(input.idempotencyKey, scope);
    if (r) {
      journalIdentity(r, input.idempotencyKey);
      if (!same(r.to, to) || !same(r.token, t.address) || r.amount !== amount.toString() || (r.requestId ?? "") !== (input.requestId ?? "")) {
        throw new RemessoError("key_reused", "this remittance key already belongs to different payment terms");
      }
      if (input.validUntil !== undefined && input.validUntil !== r.validUntil) throw new RemessoError("key_reused", "a retry cannot change this payment's deadline");
      if (input.maxDebit !== undefined && BigInt(r.amountIn) > toUnits(input.maxDebit, t)) throw new RemessoError("key_reused", "this key's payment already debits more than this maxDebit; retry it without lowering maxDebit");
    }
    const repeat = r != null;
    const finish = (stage: WalletRemittanceStage, requestError?: string): WalletRemittanceResult => ({ ...result(r!, stage, requestError), ...(repeat ? { repeat: true } : {}) });

    if (!r?.creation) {
      if (!mayStart) {
        if (!r) throw new RemessoError("not_found", "no saved payment owns this key; reconciliation never creates a new payment");
        return finish("creation");
      }
      const now = Math.floor(Date.now() / 1000);
      if (input.startBy !== undefined && now >= input.startBy) throw new RemessoError("refused", "this payment's quote has expired, so nothing was signed: prepare it again");
      if (input.validUntil !== undefined && input.validUntil - START_MARGIN_S <= now) {
        throw new RemessoError("refused", "this payment's deadline is less than three minutes away, so it isn't started and nothing was signed");
      }
      if (!r) {
        if (input.requestId) {
          const req = await deps.getRequest(input.requestId);
          if (req.status !== "pending" || req.payment) throw new RemessoError("refused", "the request already has an answer, is expired or was declined");
          if (!same(req.payer, account.address) || !same(req.requested.to, to)) throw new RemessoError("refused", "the request payer or recipient does not match this remittance");
          if (req.requested.intervalSeconds != null || (req.requested.runs != null && req.requested.runs !== 1)) throw new RemessoError("refused", "wallet remittances settle one-off requests only");
          if (!req.requested.amount || !req.requested.token || !same(tokenOf(req.requested.token).address, t.address) || toUnits(req.requested.amount, t) !== amount) throw new RemessoError("refused", "the request must specify this exact amount and token");
        }
        const [allowed, feeBps, balance, maxLifetime, block] = await Promise.all([
          read<boolean>("directTokenAllowed", [t.address]), read<number>("feeBps"),
          ctx.pub.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
          read<bigint>("MAX_LIFETIME"), ctx.pub.getBlock(),
        ]);
        if (!allowed) throw new RemessoError("refused", "this token is not accepted for new Direct payments");
        const amountIn = grossFor(amount, Number(feeBps));
        if (input.maxDebit !== undefined && amountIn > toUnits(input.maxDebit, t)) throw new RemessoError("refused", "the current fee would exceed maxDebit; no mandate is created");
        const { min, max } = runLimits(t);
        if (amountIn < min || amountIn > max) throw new RemessoError("refused", "the gross payment is outside this token's executor run limits");
        if (balance < amountIn) throw new RemessoError("refused", "the wallet balance cannot cover the payment and its fee");
        const life = maxLifetime < LIFETIME ? maxLifetime : LIFETIME;
        // A second before the deadline: V5 still runs a schedule at exactly its
        // expiry, and a payment at the deadline would be late.
        const expiresAt = Math.min(Number(block.timestamp + life), input.validUntil !== undefined ? input.validUntil - 1 : Number.MAX_SAFE_INTEGER);
        if (expiresAt - Number(block.timestamp) < START_MARGIN_S) throw new RemessoError("refused", "the payment would expire before it could be made, so nothing was signed");
        r = { key: input.idempotencyKey, scope, payer: account.address, to, token: t.address,
          amount: amount.toString(), amountIn: amountIn.toString(), fee: (amountIn - amount).toString(), feeBps: Number(feeBps),
          firstRunAt: Math.min(Number(block.timestamp + INTERVAL), expiresAt), expiresAt,
          ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
          createdAt: new Date().toISOString(), ...(input.requestId ? { requestId: input.requestId } : {}) };
        // Validate every creation rule before anything is signed.
        try { await ctx.pub.simulateContract({ address: EXECUTOR, abi: executorAbi, functionName: "createSchedule", args: createArgs(r), account }); }
        catch (e) { throw new RemessoError("refused", `the contract would refuse this remittance: ${refusal(e)}`); }
        await save(r);
      } else {
        // Saved but never signed: it still hasn't started.
        if (r.expiresAt - now < START_MARGIN_S) throw new RemessoError("refused", "this payment was saved but never started, and its schedule would now expire too soon; nothing was signed. Use a new key");
        if (Number(await read<number>("feeBps")) !== r.feeBps) throw new RemessoError("refused", "the contract's fee changed since this payment was saved, and nothing was signed. Use a new key for a fresh quote");
      }
      if (Date.now() >= deadline) return finish("creation");
      await sendStep(r, "creation", await signStep(r, EXECUTOR, executorAbi, "createSchedule", createArgs(r)));
    }
    if (!r?.creation) throw conflict("the payment's creation step was not saved");

    const creation = await stepReceipt(r.creation, deadline);
    if (!creation) return finish("creation");
    if (creation.status !== "success") {
      throw new RemessoError("reverted", "the payment's schedule couldn't be created, so nothing was paid. This key won't create another; use a new key to try again", { hash: creation.transactionHash, stage: "creation" });
    }
    // Checked on every resume: the receipt must name this exact schedule.
    const id = created(creation, r);
    if (!r.scheduleId) {
      r.scheduleId = id.toString();
      r.creationBlock = creation.blockNumber.toString();
      await save(r);
    }
    // Bound now, not after payment: the executor may pay it later, and the
    // recipient checks a payment against the schedule its request names.
    const requestError = await bind(r);

    const current = await state(r, creation.blockNumber);
    if (!current) return finish("approval", requestError);
    const { s, at } = current;
    if (s.runsExecuted > 0) return await paid(r, requestError);
    if (s.cancelled || at > s.expiresAt) throw await unpaid(r, s);
    const stop = (reason: string) => abandon(r!, reason, deadline, (stage) => finish(stage, requestError));
    if (r.cancellation) return await stop(r.cancelReason ?? "the payment couldn't be completed");
    if (Number(s.feeBps) !== r.feeBps || netOf(s.amountIn, Number(s.feeBps)) !== BigInt(r.amount)) {
      return await stop("the contract's fee changed after this payment was quoted");
    }
    if (!s.active) {
      throw conflict("the payer paused this payment's schedule, so it isn't run now. Resume it with schedules.setActive, or cancel it with schedules.cancel", { scheduleId: r.scheduleId, paused: true });
    }
    // A request-bound payment is approved and run only once its request names
    // this schedule: the recipient checks the payment against that binding, so
    // paying one it can't bind would pay an invoice that never settles.
    if (r.requestId && !r.requestBound) {
      const standing = await requestStanding(r);
      if (standing === "waiting") return finish("approval", requestError);
      if (standing !== "bound") return await stop(`its request can't be answered by this payment any more: ${standing}`);
    }

    if (!r.approval && !r.approvalSkipped) {
      if (Date.now() >= deadline || await approvalInFlight(r)) return finish("approval", requestError);
      // Read when signed, not when quoted: another schedule may have been
      // approved since, and an approval sets the allowance outright.
      const current = await ctx.pub.readContract({ address: r.token, abi: erc20Abi, functionName: "allowance", args: [r.payer, EXECUTOR] });
      if (current >= UNLIMITED) {
        r.approvalSkipped = true;
        await save(r);
      } else {
        const approvalAmount = current + BigInt(r.amountIn);
        await sendStep(r, "approval", await signLater(r, "approval", r.token, erc20Abi, "approve", [EXECUTOR, approvalAmount]), { approvalAmount: approvalAmount.toString() });
      }
    }
    if (r.approval) {
      const approved = await stepReceipt(r.approval, deadline);
      if (!approved) return finish("approval", requestError);
      if (approved.status !== "success") return await stop("the token approval reverted");
      if (!parseEventLogs({ abi: APPROVAL, eventName: "Approval", logs: approved.logs }).some((log) => same(log.address, r!.token) && same(log.args.owner, r!.payer) && same(log.args.spender, EXECUTOR) && log.args.value === BigInt(r!.approvalAmount ?? -1))) {
        throw conflict("the approval receipt has no matching token Approval event");
      }
    }

    if (!r.execution) {
      if (Date.now() >= deadline) return finish("execution", requestError);
      const refused = await runnable(r, deadline);
      if (refused !== null) {
        const now = await state(r);
        if (!now) return finish("execution", requestError);
        if (now.s.runsExecuted > 0) return await paid(r, requestError);
        return await stop(`the contract wouldn't run the payment now (${refused})`);
      }
      await sendStep(r, "execution", await signLater(r, "payment", EXECUTOR, executorAbi, "runNow", [BigInt(r.scheduleId), 0n]));
    }
    const execution = await stepReceipt(r.execution!, deadline);
    if (!execution) return finish("execution", requestError);
    if (payment(execution, r)) {
      r.paymentHash = execution.transactionHash;
      r.settledAt ??= new Date().toISOString();
      await save(r);
      return finish("payment", requestError);
    }
    // The executor's regular run can win the race with runNow.
    const after = await state(r, execution.blockNumber);
    if (!after) return finish("execution", requestError);
    if (after.s.runsExecuted > 0) return await paid(r, requestError);
    if (execution.status !== "success") return await stop("running the payment reverted");
    throw conflict("the successful execution receipt has no matching exact RunExecuted payment");

    /// The schedule ran: report its payment once the event can be read.
    async function paid(record: RemittanceRecord, error?: string): Promise<WalletRemittanceResult> {
      const hash = await paidHash(record);
      if (hash && hash !== record.paymentHash) {
        record.paymentHash = hash;
        record.settledAt ??= new Date().toISOString();
        await save(record);
      }
      return finish("payment", error);
    }
  }

  /// Not paid, for good: noted as settled, then reported.
  async function unpaid(r: RemittanceRecord, s: Schedule): Promise<RemessoError> {
    if (!r.settledAt) {
      r.settledAt = new Date().toISOString();
      await save(r);
    }
    return notPaid(r, s);
  }

  /// A schedule that is cancelled or expired and never ran: true for good.
  function notPaid(r: RemittanceRecord, s: Schedule): RemessoError {
    const why = r.cancellation && s.cancelled ? `${r.cancelReason ?? "the payment couldn't be completed"}, so its schedule was cancelled`
      : s.cancelled ? "the payer cancelled this payment's schedule before it ran" : "this payment's schedule expired before it ran";
    return new RemessoError("refused", `${why}, and nothing was paid. Use a new key to try again`, {
      scheduleId: r.scheduleId, cancelled: s.cancelled, expired: !s.cancelled,
      ...(r.cancellation ? { cancellationHash: r.cancellation.hash } : {}),
    });
  }

  /// Cancel the schedule so the payment can't happen later, then say so.
  async function abandon(r: RemittanceRecord, reason: string, deadline: number, finish: (stage: WalletRemittanceStage) => WalletRemittanceResult): Promise<WalletRemittanceResult> {
    if (!r.cancellation) {
      await sendStep(r, "cancellation", await signLater(r, "cancellation", EXECUTOR, executorAbi, "cancelSchedule", [BigInt(r.scheduleId!)]), { cancelReason: reason });
    }
    const landed = await stepReceipt(r.cancellation!, deadline);
    if (!landed) return finish("cancellation");
    const after = await state(r, landed.blockNumber);
    if (!after) return finish("cancellation");
    const { s, at } = after;
    if (s.runsExecuted > 0) {
      // Remesso's executor ran it before the cancellation landed.
      const hash = await paidHash(r);
      if (hash) {
        r.paymentHash = hash;
        r.settledAt ??= new Date().toISOString();
        await save(r);
      }
      return finish("payment");
    }
    if (s.cancelled || at > s.expiresAt) throw await unpaid(r, s);
    throw conflict("the cancellation landed but the schedule is still live; retry this key", { scheduleId: r.scheduleId, cancellationHash: r.cancellation!.hash });
  }
}

export type WalletRemittances = ReturnType<typeof makeWalletRemittances>;
