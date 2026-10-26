/// One wallet-funded remittance is one immutable V5 Direct schedule with a
/// lifetime cap of one run. The payer runs it immediately; the existing event
/// indexer, request binding and webhooks observe exactly the same contract.
import {
  type Abi, type Address, type Hex, type TransactionReceipt,
  concat, encodeFunctionData, keccak256, parseAbi, parseEventLogs, zeroAddress,
} from "viem";
import { getTransaction, getTransactionCount, getTransactionReceipt, prepareTransactionRequest, sendRawTransaction, signTransaction } from "viem/actions";
import { erc20Abi, executorAbi } from "./abi.js";
import { type Ctx, gasFor, refusal, untilVisible } from "./context.js";
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
  validUntil?: number;
};

export type WalletRemittanceResult = {
  funding: "wallet";
  status: "confirmed" | "pending";
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
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
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

  function result(record: RemittanceRecord, requestError?: string): WalletRemittanceResult {
    return {
      funding: "wallet", status: record.paymentHash ? "confirmed" : "pending",
      payer: record.payer, to: record.to, token: record.token,
      amount: BigInt(record.amount), amountIn: BigInt(record.amountIn), fee: BigInt(record.fee), feeBps: record.feeBps,
      ...(record.paymentHash ? { hash: record.paymentHash } : {}),
      ...(record.scheduleId ? { scheduleId: BigInt(record.scheduleId) } : {}),
      ...(record.approval ? { approvalHash: record.approval.hash } : {}),
      ...(record.creation ? { createHash: record.creation.hash } : {}),
      ...(record.execution ? { executionHash: record.execution.hash } : {}),
      ...(record.requestId ? { request: { id: record.requestId, bound: record.requestBound === true, ...(requestError ? { error: requestError } : {}) } } : {}),
    };
  }

  async function sign(record: RemittanceRecord, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<RemittanceStep> {
    const assertDeadline = () => { if (functionName !== "cancelSchedule" && record.validUntil !== undefined && record.validUntil <= Math.floor(Date.now() / 1000)) throw new RemessoError("refused", "this payment intent has expired"); };
    assertDeadline();
    const account = local();
    const fee = await gasFor(ctx, tokenOf(record.token));
    try {
      await ctx.pub.simulateContract({ address, abi, functionName, args, account, ...fee } as never);
    } catch (e) {
      throw new RemessoError("refused", `the contract would refuse ${functionName}: ${refusal(e)}`);
    }
    // A NEW key after a restart must respect every older signed step, even
    // when the RPC's pending count has not caught up with their broadcast.
    let nonce = await ctx.nextNonce();
    for (const prior of [...await deps.store.list(record.scope), record]) {
      journalIdentity(prior);
      for (const step of [prior.approval, prior.creation, prior.execution, prior.cancellation]) if (step) nonce = Math.max(nonce, step.nonce + 1);
    }
    const data = encodeFunctionData({ abi, functionName, args });
    const request = await prepareTransactionRequest(ctx.pub, {
      account, nonce, to: address, data: ctx.dataSuffix ? concat([data, ctx.dataSuffix]) : data, ...fee,
    } as never);
    await ctx.assertActive();
    const raw = await signTransaction(ctx.pub, { ...request, account } as never);
    assertDeadline();
    return { raw, hash: keccak256(raw), nonce: Number((request as { nonce: number }).nonce) };
  }

  async function receipt(step: RemittanceStep, deadline: number, validUntil?: number): Promise<TransactionReceipt | null> {
    let found = await getTransactionReceipt(ctx.pub, { hash: step.hash }).catch(() => null);
    if (!found) {
      const known = await getTransaction(ctx.pub, { hash: step.hash }).catch(() => null);
      if (!known) {
        const used = await getTransactionCount(ctx.pub, { address: local().address, blockTag: "latest" });
        if (used > step.nonce) throw new RemessoError("conflict", "the remittance nonce was consumed but its original receipt is unavailable; reconcile the original hash before continuing", { hash: step.hash, nonce: step.nonce });
        if (validUntil !== undefined && validUntil <= Math.floor(Date.now() / 1000)) throw new RemessoError("refused", "the saved intent expired; reconcile its original hash without another broadcast", { hash: step.hash });
        // A failed response can still mean accepted: only original bytes are
        // ever rebroadcast, never another approval or another schedule.
        await ctx.assertActive();
        await sendRawTransaction(ctx.pub, { serializedTransaction: step.raw }).catch(() => {});
      }
      if (Date.now() < deadline) found = await ctx.pub.waitForTransactionReceipt({ hash: step.hash, timeout: Math.max(1, deadline - Date.now()) }).catch(() => null);
    }
    if (found && !same(found.transactionHash, step.hash)) throw new RemessoError("conflict", "a replacement transaction is not proof this remittance step succeeded", { hash: step.hash, replacement: found.transactionHash });
    return found;
  }

  function successful(found: TransactionReceipt, step: string) {
    if (found.status !== "success") throw new RemessoError("reverted", `the remittance ${step} reverted; the same payment key will never create another schedule`, { hash: found.transactionHash });
  }

  const createArgs = (r: RemittanceRecord) => [r.to, BigInt(r.amountIn), INTERVAL, 0n, 1, BigInt(r.expiresAt), BigInt(r.firstRunAt), 2, r.token, zeroAddress, r.payer, 1] as const;

  function created(found: TransactionReceipt, r: RemittanceRecord): bigint {
    successful(found, "creation");
    const logs = parseEventLogs({ abi: executorAbi, eventName: "ScheduleCreated", logs: found.logs });
    const hit = logs.find((log) => same(log.address, EXECUTOR) && same(log.args.sender, r.payer) && same(log.args.destination, r.to) &&
      log.args.amountIn === BigInt(r.amountIn) && log.args.interval === INTERVAL && log.args.maxRuns === 1 && log.args.payoutType === 2 && log.args.expiresAt === BigInt(r.expiresAt));
    if (!hit) throw new RemessoError("conflict", "the creation receipt has no matching one-payment ScheduleCreated event", { hash: found.transactionHash });
    if (r.scheduleId && BigInt(r.scheduleId) !== hit.args.id) throw new RemessoError("conflict", "the recorded schedule does not match its original creation receipt");
    return hit.args.id;
  }

  function payment(found: TransactionReceipt, r: RemittanceRecord): boolean {
    if (found.status !== "success") return false;
    return parseEventLogs({ abi: executorAbi, eventName: "RunExecuted", logs: found.logs }).some((log) => same(log.address, EXECUTOR) &&
      log.args.id === BigInt(r.scheduleId!) && same(log.args.sender, r.payer) && same(log.args.destination, r.to) &&
      log.args.amountIn === BigInt(r.amountIn) && log.args.amountOut === BigInt(r.amount) && log.args.runsExecuted === 1);
  }

  async function schedule(r: RemittanceRecord): Promise<Schedule> {
    const s = await untilVisible(() => read<Schedule>("getSchedule", [BigInt(r.scheduleId!)]), (v) => !same(v.sender, zeroAddress));
    if (!same(s.sender, r.payer) || !same(s.destination, r.to) || !same(s.token, r.token) || s.amountIn !== BigInt(r.amountIn) ||
      s.interval !== INTERVAL || s.maxRuns !== 1 || s.payoutType !== 2) {
      throw new RemessoError("conflict", "the created schedule's immutable terms do not match this exact remittance; no payment is sent");
    }
    return s;
  }

  /// The regular executor can win the race with runNow. Find its actual
  /// event and verify the original receipt; maxRuns=1 prevents a second run.
  async function findPayment(r: RemittanceRecord, deadline: number): Promise<Hex | null> {
    if (r.paymentHash) {
      const found = await getTransactionReceipt(ctx.pub, { hash: r.paymentHash }).catch(() => null);
      if (found && same(found.transactionHash, r.paymentHash) && payment(found, r)) return r.paymentHash;
      // Do not return a stale stored confirmation after a reorg.
      delete r.paymentHash;
      await save(r);
    }
    const head = await ctx.pub.getBlockNumber();
    for (let from = BigInt(r.creationBlock!); from <= head && Date.now() < deadline; from += 5000n) {
      const to = from + 4999n > head ? head : from + 4999n;
      const logs = await ctx.pub.getContractEvents({ address: EXECUTOR, abi: executorAbi, eventName: "RunExecuted", args: { id: BigInt(r.scheduleId!) }, fromBlock: from, toBlock: to });
      for (const log of logs) {
        if (!log.transactionHash || log.removed) continue;
        const found = await getTransactionReceipt(ctx.pub, { hash: log.transactionHash }).catch(() => null);
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

  async function cancelFeeMismatch(r: RemittanceRecord, deadline: number): Promise<never> {
    let confirmed = false;
    let error: string | undefined;
    try {
      if (!r.cancellation) {
        r.cancellation = await sign(r, EXECUTOR, executorAbi, "cancelSchedule", [BigInt(r.scheduleId!)]);
        await save(r);
        await ctx.noteNonce(r.cancellation.nonce);
      }
      const cancelled = await receipt(r.cancellation, deadline);
      if (cancelled) {
        successful(cancelled, "cancellation");
        confirmed = parseEventLogs({ abi: executorAbi, eventName: "ScheduleCancelled", logs: cancelled.logs }).some((log) => same(log.address, EXECUTOR) && log.args.id === BigInt(r.scheduleId!));
        if (!confirmed) throw new Error("the cancellation receipt has no matching ScheduleCancelled event");
      }
    } catch (e) { error = String((e as Error).message); }
    throw new RemessoError("conflict", confirmed
      ? "the pinned fee differs from this remittance's quote; its one-payment schedule was cancelled"
      : "the pinned fee differs from this remittance's quote; cancellation is not confirmed, so retry this key to reconcile the same schedule", {
      scheduleId: r.scheduleId, cancellationHash: r.cancellation?.hash, cancellationConfirmed: confirmed,
      ...(error ? { cancellationError: error } : {}),
    });
  }

  return {
    async send(input: WalletRemittanceInput): Promise<WalletRemittanceResult> {
      return await ctx.serial(async () => {
        const account = local();
        await ctx.assertChain();
        if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()) throw new RemessoError("invalid", "idempotencyKey is required for a wallet remittance");
        const waitMs = input.waitMs ?? 45_000;
        if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 120_000) throw new RemessoError("invalid", "waitMs must be from 1 to 120000 milliseconds");
        const deadline = Date.now() + waitMs;
        const to = checksum(input.to);
        if (BigInt(to) < 0x10000n || same(to, EXECUTOR) || same(to, account.address)) throw new RemessoError("invalid", "to must be another wallet and a valid schedule destination");
        const t = tokenOf(input.token);
        const amount = toUnits(input.amount, t);
        if (amount <= 0n) throw new RemessoError("invalid", "amount must be above zero");
        const scope = remittanceScope(ctx);
        let r = await deps.store.get(input.idempotencyKey, scope);
        if (r) journalIdentity(r, input.idempotencyKey);
        const repeat = r != null;
        const finish = (requestError?: string): WalletRemittanceResult => ({ ...result(r!, requestError), ...(repeat ? { repeat: true } : {}) });
        if (r && (!same(r.to, to) || !same(r.token, t.address) || r.amount !== amount.toString() || (r.requestId ?? "") !== (input.requestId ?? ""))) {
          throw new RemessoError("key_reused", "this remittance key already belongs to different payment terms");
        }
        if (r && input.validUntil !== undefined && input.validUntil !== r.validUntil) throw new RemessoError("key_reused", "a retry cannot change this payment's deadline");
        if (input.validUntil !== undefined && (!Number.isSafeInteger(input.validUntil) || input.validUntil <= Math.floor(Date.now() / 1000))) throw new RemessoError("refused", "this payment intent has expired");
        if (!r) {
          if (input.requestId) {
            const req = await deps.getRequest(input.requestId);
            if (req.status !== "pending" || req.payment) throw new RemessoError("refused", "the request already has an answer, is expired or was declined");
            if (!same(req.payer, account.address) || !same(req.requested.to, to)) throw new RemessoError("refused", "the request payer or recipient does not match this remittance");
            if (req.requested.intervalSeconds != null || (req.requested.runs != null && req.requested.runs !== 1)) throw new RemessoError("refused", "wallet remittances settle one-off requests only");
            if (!req.requested.amount || !req.requested.token || !same(tokenOf(req.requested.token).address, t.address) || toUnits(req.requested.amount, t) !== amount) throw new RemessoError("refused", "the request must specify this exact amount and token");
          }
          const [allowed, feeBps, approved, balance, maxLifetime, block] = await Promise.all([
            read<boolean>("directTokenAllowed", [t.address]), read<number>("feeBps"),
            ctx.pub.readContract({ address: t.address, abi: erc20Abi, functionName: "allowance", args: [account.address, EXECUTOR] }),
            ctx.pub.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
            read<bigint>("MAX_LIFETIME"), ctx.pub.getBlock(),
          ]);
          if (!allowed) throw new RemessoError("refused", "this token is not accepted for new Direct payments");
          const amountIn = grossFor(amount, Number(feeBps));
          if (input.maxDebit !== undefined && amountIn > toUnits(input.maxDebit, t)) throw new RemessoError("refused", "the current fee would exceed maxDebit; no mandate is created");
          const { min, max } = runLimits(t);
          if (amountIn < min || amountIn > max) throw new RemessoError("refused", "the gross payment is outside this token's executor run limits");
          if (balance < amountIn) throw new RemessoError("refused", "the wallet balance cannot cover the payment and its fee");
          if (approved + amountIn >= 2n ** 256n) throw new RemessoError("invalid", "adding this payment would overflow the token approval");
          const expiresAt = Math.min(Number(block.timestamp + (maxLifetime < 86_400n ? maxLifetime : 86_400n)), input.validUntil ?? Number.MAX_SAFE_INTEGER);
          if (expiresAt <= Number(block.timestamp) + 1) throw new RemessoError("refused", "the intent expires before a mandate can be created");
          r = { key: input.idempotencyKey, scope, payer: account.address, to, token: t.address,
            amount: amount.toString(), amountIn: amountIn.toString(), fee: (amountIn - amount).toString(), feeBps: Number(feeBps),
            firstRunAt: Math.min(Number(block.timestamp + 3600n), expiresAt - 1), expiresAt, ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }), approvalAmount: (approved + amountIn).toString(),
            createdAt: new Date().toISOString(), ...(input.requestId ? { requestId: input.requestId } : {}) };
          // Validate every creation rule before increasing an approval.
          try { await ctx.pub.simulateContract({ address: EXECUTOR, abi: executorAbi, functionName: "createSchedule", args: createArgs(r), account }); }
          catch (e) { throw new RemessoError("refused", `the contract would refuse this remittance: ${refusal(e)}`); }
          await save(r);
        }
        if (input.maxDebit !== undefined && BigInt(r.amountIn) > toUnits(input.maxDebit, t)) throw new RemessoError("refused", "the recorded mandate exceeds maxDebit; reconcile its existing schedule");

        if (!r.creation) {
          if (Date.now() >= deadline) return finish();
          r.creation = await sign(r, EXECUTOR, executorAbi, "createSchedule", createArgs(r));
          await save(r);
          await ctx.noteNonce(r.creation.nonce);
        }
        const creation = await receipt(r.creation, deadline, r.validUntil);
        if (!creation) return finish();
        r.scheduleId = created(creation, r).toString();
        r.creationBlock = creation.blockNumber.toString();
        await save(r);
        const s = await schedule(r);
        if (r.cancellation || Number(s.feeBps) !== r.feeBps || netOf(s.amountIn, Number(s.feeBps)) !== BigInt(r.amount)) {
          return await cancelFeeMismatch(r, deadline);
        }
        const observed = await findPayment(r, deadline);
        if (observed) {
          r.paymentHash = observed;
          await save(r);
          return finish(await bind(r));
        }
        if (s.runsExecuted > 0) return finish(await bind(r)); // event/RPC lag: never create or run again
        if (s.cancelled || !s.active) throw new RemessoError("refused", "this remittance schedule was cancelled or paused; no replacement schedule is created");
        if (!r.approval) {
          if (Date.now() >= deadline) return finish();
          r.approval = await sign(r, t.address, erc20Abi, "approve", [EXECUTOR, BigInt(r.approvalAmount)]);
          await save(r);
          await ctx.noteNonce(r.approval.nonce);
        }
        const approved = await receipt(r.approval, deadline, r.validUntil);
        if (!approved) return finish();
        successful(approved, "approval");
        if (!parseEventLogs({ abi: APPROVAL, eventName: "Approval", logs: approved.logs }).some((log) => same(log.address, r!.token) && same(log.args.owner, r!.payer) && same(log.args.spender, EXECUTOR) && log.args.value === BigInt(r!.approvalAmount))) {
          throw new RemessoError("conflict", "the approval receipt has no matching token Approval event");
        }
        if (!r.execution) {
          if (Date.now() >= deadline) return finish(await bind(r));
          try {
            r.execution = await sign(r, EXECUTOR, executorAbi, "runNow", [BigInt(r.scheduleId), 0n]);
          } catch (e) {
            // The executor may have run after our first state read.
            const raced = await findPayment(r, deadline);
            if (!raced) throw e;
            r.paymentHash = raced;
            await save(r);
            return finish(await bind(r));
          }
          await save(r);
          await ctx.noteNonce(r.execution.nonce);
        }
        const execution = await receipt(r.execution, deadline, r.validUntil);
        if (!execution) return finish(await bind(r));
        if (payment(execution, r)) r.paymentHash = execution.transactionHash;
        else {
          const raced = await findPayment(r, deadline);
          if (raced) r.paymentHash = raced;
          else {
            successful(execution, "execution");
            throw new RemessoError("conflict", "the successful execution receipt has no matching exact RunExecuted payment");
          }
        }
        await save(r);
        return finish(await bind(r));
      });
    },
  };
}

export type WalletRemittances = ReturnType<typeof makeWalletRemittances>;
