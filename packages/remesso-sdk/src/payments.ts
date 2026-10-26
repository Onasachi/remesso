/// An agent's payment, through a policy its person set: at most once per
/// idempotency key. Extracted from the plugin wallet (`mcp/src/server.mjs`).
import {
  type Address,
  concat,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
  parseAbiItem,
  parseEventLogs,
  type TransactionReceipt,
  toHex,
} from "viem";
import {
  getBlockNumber,
  getLogs,
  getTransactionCount,
  prepareTransactionRequest,
  signTransaction,
} from "viem/actions";
import { allowanceAbi } from "./abi.js";
import { type Ctx, gasFor, type OpenTx, PAY_GAS, receiptOf, refusal } from "./context.js";
import { ALLOWANCE, CHAIN_ID, checksum, findToken, formatAmount, toUnits } from "./deployment.js";
import { RemessoError } from "./errors.js";
import type { Policies, Policy } from "./policies.js";
import type { PaymentRecord } from "./store.js";

export type PayInput = {
  to: string;
  /** Decimal, in the policy token's units: "0.10". */
  amount: string;
  /** Symbol or address. Default: the token of the policy used. */
  token?: string;
  /** Which policy to pay under. Default: an active one for the token that can cover the amount. */
  policyId?: bigint | number | string;
  /** Only use a policy owned by this payer. Requests set this automatically. */
  payer?: string;
  /** Up to 32 bytes, recorded on-chain in the Paid event. A request's reference goes here. */
  memo?: string;
  /**
   * One per payment you intend (an invoice or request id is ideal). A retry with the
   * same key reports the first payment's outcome and never pays twice.
   */
  idempotencyKey?: string;
  /** Pay even though an identical payment went out in the last ten minutes. */
  allowRepeat?: boolean;
  /** How long to wait for the receipt before answering "pending". Default 45s. */
  waitMs?: number;
  /**
   * Unix second the payment must land before. Nothing starts within a minute
   * of it, nothing is broadcast within 30 seconds of it, and bytes still
   * unsent after it are cancelled at their nonce, so it can't land late.
   */
  validUntil?: number;
  /** Don't start this payment at or after this Unix second (a quote's expiry). Ignored once its key has a saved payment. */
  startBy?: number;
};

export type PaymentResult = {
  status: "confirmed" | "pending";
  hash: Hex;
  policyId: bigint;
  to: Address;
  amount: bigint;
  token: Address;
  /** "1.5 USDT" */
  sent: string;
  explorer: string;
  /** True when this key had already paid and nothing new was sent. */
  repeat?: boolean;
  /** Its deadline passed before it went out, so this no-op was sent at its nonce. Retry the key to learn which landed. */
  cancellation?: Hex;
};

export const DEPLOYMENT = `${CHAIN_ID}:${ALLOWANCE.toLowerCase()}`;
export const paymentScope = (ctx: Ctx) => `${DEPLOYMENT}:${ctx.requireAccount().address.toLowerCase()}`;
export async function priorPayment(ctx: Ctx, key: string): Promise<PaymentRecord | undefined> {
  const scope = paymentScope(ctx);
  const scoped = await ctx.store.byKey(key, scope);
  if (scoped) return scoped;
  const legacy = await ctx.store.byKey(key, DEPLOYMENT);
  if (!legacy) return undefined;
  // The agent on a policy is immutable, even after revocation. This also
  // handles old Celo fee-currency transactions without parsing their bytes.
  const policy = await ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "policy", args: [BigInt(legacy.policyId)] });
  return policy.agent.toLowerCase() === ctx.requireAccount().address.toLowerCase()
    ? { ...legacy, deployment: scope, owner: policy.owner }
    : undefined;
}
const REPEAT_MS = 10 * 60_000;
/// A payment isn't started this close to its deadline, nor broadcast this close.
const START_MARGIN_S = 60;
const SEND_MARGIN_S = 30;
const now = () => Math.floor(Date.now() / 1000);
/// Too close to its deadline to be sent: it could land after it.
const lapsed = (rec: PaymentRecord) => rec.validUntil !== undefined && rec.validUntil - SEND_MARGIN_S <= now();
const notFound = (e: unknown) => (e as { name?: string })?.name === "TransactionNotFoundError";
const REPEAT_BLOCKS = 600n; // ten minutes of Celo blocks
const PAID = parseAbiItem("event Paid(uint256 indexed id, address indexed to, uint256 amount, bytes32 memo)");
const explorer = (h: string) => `https://celoscan.io/tx/${h}`;

/// A memo is bytes32 on-chain, so it is measured in bytes: an accented letter
/// is two and an emoji four. Refused rather than cut, because a cut reference
/// no longer matches what it refers to.
export function memo32(memo?: string): Hex {
  if (!memo) return `0x${"0".repeat(64)}`;
  const bytes = new TextEncoder().encode(memo);
  if (bytes.length > 32) {
    throw new RemessoError("invalid", `the memo is ${bytes.length} bytes and the limit is 32 (a plain letter is 1 byte, an accented letter 2, an emoji 4)`);
  }
  return toHex(bytes, { size: 32 }); // bytes pad on the right, as the contract reads a string
}

export function makePay(ctx: Ctx, policies: Policies) {
  const save = async (record: PaymentRecord) => { await ctx.assertActive(); await ctx.store.save(record); };
  const local = () => {
    const account = ctx.requireAccount();
    if (ctx.pub.chain?.id !== CHAIN_ID) throw new RemessoError("invalid", "agent payments need publicClient configured with chain: celo so Celo fee-currency transactions are signed correctly");
    if (account.type !== "local") {
      throw new RemessoError("no_account", "agent payments are signed before they're sent, which needs a local account (privateKeyToAccount)");
    }
    return account;
  };

  /// Sign a no-op at a lapsed payment's nonce and save it before sending it.
  async function cancel(rec: PaymentRecord): Promise<PaymentRecord> {
    if (rec.cancel) {
      await ctx.resend(rec.cancel.raw);
      return rec;
    }
    const signed = await ctx.signCancel(rec.nonce, findToken(rec.token) ?? null, rec.raw);
    const next: PaymentRecord = { ...rec, cancel: signed };
    await save(next);
    await ctx.resend(signed.raw);
    return next;
  }

  // Payments saved but not yet seen on-chain, for the next nonce to respect.
  // Records written by 0.2.0 carry no agent, so the policy says whose they are.
  if (ctx.account) {
    ctx.addJournal(async (fromNonce) => {
      const scope = paymentScope(ctx), agent = ctx.requireAccount().address.toLowerCase();
      const agents = new Map<string, Promise<string>>();
      const open: OpenTx[] = [], hashes = new Set<string>();
      for (const rec of await ctx.store.since(0)) {
        if (rec.nonce < fromNonce || !["sent", "unsent"].includes(rec.status) || hashes.has(rec.hash.toLowerCase())) continue;
        // Bytes that don't hash to the recorded payment are never sent.
        if (keccak256(rec.raw).toLowerCase() !== rec.hash.toLowerCase()) continue;
        if (rec.deployment !== scope) {
          if (rec.deployment !== DEPLOYMENT) continue;
          if (!agents.has(rec.policyId)) {
            agents.set(rec.policyId, ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "policy", args: [BigInt(rec.policyId)] }).then((p) => p.agent.toLowerCase()));
          }
          if (await agents.get(rec.policyId) !== agent) continue;
        }
        hashes.add(rec.hash.toLowerCase());
        open.push({
          nonce: rec.nonce, hash: rec.hash, raw: rec.raw, savedAt: Date.parse(rec.at), resend: !lapsed(rec),
          ...(rec.cancel ? { cancel: rec.cancel } : {}),
          cancelNow: async () => { await cancel(rec); },
        });
      }
      return open;
    });
  }

  /// Simulate, then sign without sending. Throws the contract's refusal
  /// before anything is signed.
  async function sign(p: Policy, to: Address, units: bigint, memo: Hex) {
    const account = local();
    const fee = await gasFor(ctx, findToken(p.token) ?? null, PAY_GAS, "payment");
    const args = [p.id, to, units, memo] as const;
    try {
      await ctx.pub.simulateContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "pay", args, account, ...fee } as never);
    } catch (e) {
      throw new RemessoError("refused", `the policy refuses this payment: ${refusal(e)}`);
    }
    const data = encodeFunctionData({ abi: allowanceAbi, functionName: "pay", args });
    const nonce = await ctx.nextNonce();
    const request = await prepareTransactionRequest(ctx.pub, {
      account,
      nonce,
      to: ALLOWANCE,
      data: ctx.dataSuffix ? concat([data, ctx.dataSuffix]) : data,
      ...fee,
    } as never);
    await ctx.assertActive();
    const raw = await signTransaction(ctx.pub, { ...request, account } as never);
    return { hash: keccak256(raw), raw, nonce: Number((request as { nonce: number }).nonce) };
  }

  function outcome(rec: PaymentRecord, receipt: TransactionReceipt): PaymentRecord {
    if (receipt.transactionHash.toLowerCase() !== rec.hash.toLowerCase()) {
      throw new RemessoError("conflict", "the payment transaction was replaced; its replacement is not proof this invoice was paid", { hash: rec.hash, replacement: receipt.transactionHash });
    }
    const settledAt = rec.settledAt ?? new Date().toISOString();
    if (receipt.status !== "success") return { ...rec, status: "reverted", settledAt };
    const paid = parseEventLogs({ abi: allowanceAbi, eventName: "Paid", logs: receipt.logs }).some((log) =>
      log.address.toLowerCase() === ALLOWANCE.toLowerCase() && log.args.id === BigInt(rec.policyId) &&
      log.args.to.toLowerCase() === rec.to.toLowerCase() && log.args.amount === BigInt(rec.units) && log.args.memo === rec.memo
    );
    if (!paid) throw new RemessoError("conflict", "the transaction succeeded without this payment's Paid event; nothing is reported as paid", { hash: rec.hash });
    return { ...rec, status: "confirmed", settledAt };
  }

  /// Broadcast a recorded payment and wait for its receipt. A failed
  /// broadcast may still have gone out, and a slow receipt isn't a failure:
  /// the record keeps the hash either way.
  async function broadcast(rec: PaymentRecord, waitMs: number): Promise<PaymentRecord> {
    await ctx.assertActive();
    // Saving can be slow: checked again here, so bytes never first go out late.
    if (rec.cancel || lapsed(rec)) return await settled(await cancel(rec), waitMs);
    // Anything stuck below it would hold it up: fill that gap first.
    await ctx.unblock(rec.nonce);
    await ctx.resend(rec.raw);
    const receipt = await ctx.pub.waitForTransactionReceipt({ hash: rec.hash, timeout: waitMs }).catch(() => null);
    if (!receipt) return rec;
    const done = outcome(rec, receipt);
    await save(done);
    return done;
  }

  /// What became of a recorded payment whose outcome is unknown.
  async function reconcile(rec: PaymentRecord): Promise<PaymentRecord> {
    // Inclusion isn't finality. Re-read even a previously confirmed receipt:
    // a reorg may have removed it since the last call.
    const receipt = await receiptOf(ctx.pub, rec.hash);
    if (receipt) return outcome(rec, receipt);
    // Its cancellation landed instead, so the payment never can.
    if (rec.cancel && await receiptOf(ctx.pub, rec.cancel.hash)) return { ...rec, status: "expired", settledAt: rec.settledAt ?? new Date().toISOString() };
    const known = (hash: Hex) => ctx.pub.getTransaction({ hash }).then(() => true, (e: unknown) => {
      if (notFound(e)) return false;
      throw e;
    });
    if (await known(rec.hash) || (rec.cancel && await known(rec.cancel.hash))) return { ...rec, status: "sent" }; // in a mempool
    const used = await getTransactionCount(ctx.pub, { address: local().address, blockTag: "latest" });
    // Its nonce is still free, so the signed bytes never went out and still can.
    if (used <= rec.nonce) return { ...rec, status: "unsent" };
    // A missing receipt and a consumed nonce cannot prove a payment never
    // happened: it may be older than an RPC's log window. Never sign it again.
    throw new RemessoError("conflict", "the payment's nonce was consumed but its receipt is unavailable; reconcile its original hash before paying again", { hash: rec.hash, nonce: rec.nonce });
  }

  /// Wait for whichever of a lapsed payment and its cancellation lands.
  async function settled(rec: PaymentRecord, waitMs: number): Promise<PaymentRecord> {
    const until = Date.now() + waitMs;
    for (;;) {
      const next = await reconcile(rec);
      if (next.status !== "sent" && next.status !== "unsent") {
        await save(next);
        return next;
      }
      if (Date.now() >= until) return next;
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }

  /// The same payment in the last ten minutes, recorded here or on-chain:
  /// the usual sign of a timed-out call being retried.
  async function recentRepeat(policyId: bigint, to: Address, units: bigint, memo: Hex): Promise<{ hash: Hex } | null> {
    const mine = (await ctx.store.since(Date.now() - REPEAT_MS)).find((p) =>
      (p.deployment === paymentScope(ctx) || p.deployment === DEPLOYMENT) && p.policyId === policyId.toString() && p.to === to && p.units === units.toString() &&
      p.memo === memo && (p.status === "sent" || p.status === "confirmed")
    );
    if (mine) return { hash: mine.hash };
    const head = await getBlockNumber(ctx.pub);
    const logs = await getLogs(ctx.pub, {
      address: ALLOWANCE, event: PAID, args: { id: policyId, to },
      fromBlock: head > REPEAT_BLOCKS ? head - REPEAT_BLOCKS : 0n, toBlock: head,
    });
    const hit = logs.find((l) => l.args.amount === units && l.args.memo === memo);
    return hit ? { hash: hit.transactionHash } : null;
  }

  const result = (rec: PaymentRecord, extra: Partial<PaymentResult> = {}): PaymentResult => ({
    status: rec.status === "confirmed" ? "confirmed" : "pending",
    hash: rec.hash,
    policyId: BigInt(rec.policyId),
    to: rec.to,
    amount: BigInt(rec.units),
    token: rec.token,
    sent: formatAmount(rec.units, rec.token),
    explorer: explorer(rec.hash),
    ...(rec.cancel && rec.status !== "confirmed" ? { cancellation: rec.cancel.hash } : {}),
    ...extra,
  });

  /// The policy to pay under: the one named, or an active one for the token
  /// that can cover the amount right now.
  async function choose(input: PayInput, units: (p: Policy) => bigint): Promise<Policy> {
    const agent = local().address.toLowerCase();
    const payer = input.payer ? checksum(input.payer).toLowerCase() : null;
    if (input.policyId != null) {
      const p = await policies.get(input.policyId);
      if (p.agent.toLowerCase() !== agent) throw new RemessoError("refused", `policy ${p.id} names ${p.agent}, not this agent`);
      if (payer && p.owner.toLowerCase() !== payer) throw new RemessoError("refused", `policy ${p.id} isn't owned by the requested payer`);
      return p;
    }
    const want = input.token ? findToken(input.token) : undefined;
    if (input.token && !want) throw new RemessoError("invalid", `unknown token ${input.token}`);
    let fallback: Policy | null = null;
    for (const id of await policies.find()) {
      const p = await policies.get(id);
      if (!p.active || p.agent.toLowerCase() !== agent || (payer && p.owner.toLowerCase() !== payer) || (want && p.token.toLowerCase() !== want.address.toLowerCase())) continue;
      if (p.allowlistOnly && !await ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "allowed", args: [p.id, checksum(input.to)] })) continue;
      if (p.spendable >= units(p)) return p;
      fallback ??= p;
    }
    if (fallback) return fallback; // refused below with its real limit
    throw new RemessoError("refused", `no active policy names this agent${want ? ` for ${want.symbol}` : ""}: its person sets one up first`);
  }

  return async function pay(input: PayInput): Promise<PaymentResult> {
    return await ctx.serial(async () => {
      await ctx.assertChain();
      const to = checksum(input.to);
      const memo = memo32(input.memo);
      const key = input.idempotencyKey;
      if (key != null && (typeof key !== "string" || key.length === 0)) throw new RemessoError("invalid", "idempotencyKey must be a nonempty string: leave it out, or give one per payment");
      const waitMs = input.waitMs ?? 45_000;
      if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 120_000) throw new RemessoError("invalid", "waitMs must be from 1 to 120000 milliseconds");
      for (const [name, value] of [["validUntil", input.validUntil], ["startBy", input.startBy]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new RemessoError("invalid", `${name} must be a Unix time in seconds`);
      }
      const unitsFor = (p: Policy) => {
        const t = findToken(p.token);
        if (!t) throw new RemessoError("refused", `policy ${p.id} spends a token Remesso doesn't know (${p.token})`);
        return toUnits(input.amount, t);
      };

      // A key seen before: report what became of that payment.
      const scope = paymentScope(ctx);
      let prior = key ? await priorPayment(ctx, key) : undefined;
      if (prior) {
        const t = findToken(prior.token);
        const units = t ? toUnits(input.amount, t) : null;
        const tokenChanged = input.token != null && findToken(input.token)?.address.toLowerCase() !== prior.token.toLowerCase();
        const policyChanged = input.policyId != null && BigInt(input.policyId).toString() !== prior.policyId;
        const payerChanged = input.payer != null && (prior.owner ?? (await policies.get(prior.policyId)).owner).toLowerCase() !== checksum(input.payer).toLowerCase();
        if (prior.to !== to || prior.units !== units?.toString() || prior.memo !== memo || tokenChanged || policyChanged || payerChanged || (input.validUntil !== undefined && input.validUntil !== prior.validUntil)) {
          throw new RemessoError("key_reused", `idempotency key "${key}" was already used for a different payment (${formatAmount(prior.units, prior.token)} to ${prior.to})`);
        }
        // A saved payment is answered from the chain whatever its deadline: a
        // late retry must learn that its payment landed, not be told to quote
        // again and pay twice.
        prior = await reconcile(prior);
        await save(prior);
        if (prior.status === "unsent") {
          // Signed and recorded, never sent. Before its deadline its own bytes
          // go now: same payment, same nonce, so still at most once. After it,
          // a no-op takes the nonce, so it can never land late.
          prior = await broadcast(prior, waitMs);
        }
        if (prior.status === "confirmed") return result(prior, { repeat: true });
        if (prior.status === "reverted") {
          throw new RemessoError("reverted", `this key's payment reverted on-chain, so nothing was paid: ${explorer(prior.hash)}. Use a new key to try again.`, { hash: prior.hash });
        }
        if (prior.status === "expired") {
          throw new RemessoError("refused", `this key's payment was cancelled before it went out, because its deadline passed, so nothing was paid. Use a new key to try again.`, { hash: prior.hash, cancellation: prior.cancel?.hash, expired: true });
        }
        if (prior.status === "sent" || prior.status === "unsent") return result(prior);
        throw new RemessoError("conflict", "this key has an unresolved payment; reconcile its original transaction before paying again", { hash: prior.hash });
      }

      if (input.startBy !== undefined && now() >= input.startBy) throw new RemessoError("refused", "this payment's quote has expired, so nothing was signed: prepare it again");
      if (input.validUntil !== undefined && input.validUntil - START_MARGIN_S <= now()) {
        throw new RemessoError("refused", "this payment's deadline is less than a minute away, so it isn't started and nothing was signed");
      }
      const p = await choose(input, unitsFor);
      if (!p.active) throw new RemessoError("refused", `policy ${p.id} ${p.revoked ? "was revoked by its owner" : "has expired"}`);
      const units = unitsFor(p);
      if (input.token && findToken(input.token)?.address.toLowerCase() !== p.token.toLowerCase()) {
        throw new RemessoError("refused", `policy ${p.id} spends ${p.symbol ?? p.token}, not ${input.token}`);
      }
      if (!key && !input.allowRepeat) {
        const dup = await recentRepeat(p.id, to, units, memo);
        if (dup) {
          throw new RemessoError(
            "repeat",
            `an identical payment went out in the last 10 minutes: ${explorer(dup.hash)}. Pass allowRepeat to pay again, or an idempotencyKey to make retries safe.`,
            { hash: dup.hash },
          );
        }
      }
      if (units > p.spendable) {
        throw new RemessoError("refused", `${formatAmount(units, p.token)} is over what policy ${p.id} allows right now (${formatAmount(p.spendable, p.token)})`);
      }

      const signed = await sign(p, to, units, memo);
      if (input.validUntil !== undefined && input.validUntil - SEND_MARGIN_S <= now()) throw new RemessoError("refused", "the payment's deadline came too close while signing, so nothing was saved or broadcast");
      const rec: PaymentRecord = {
        key: key ?? null,
        deployment: scope,
        owner: p.owner,
        ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
        policyId: p.id.toString(),
        to,
        units: units.toString(),
        token: getAddress(p.token),
        memo,
        hash: signed.hash,
        nonce: signed.nonce,
        raw: signed.raw,
        status: "sent",
        at: new Date().toISOString(),
      };
      // Recorded before it is broadcast: a record with no payment is a
      // question, a payment with no record is a second payment on retry.
      await save(rec);
      await ctx.noteNonce(rec.nonce);
      const done = await broadcast(rec, waitMs);
      if (done.status === "reverted") {
        throw new RemessoError("reverted", `the payment reverted on-chain, so nothing was paid: ${explorer(done.hash)}`, { hash: done.hash });
      }
      if (done.status === "expired") {
        throw new RemessoError("refused", "the payment's deadline passed before it went out, so it was cancelled and nothing was paid. Use a new key to try again.", { hash: done.hash, cancellation: done.cancel?.hash, expired: true });
      }
      return result(done);
    });
  };
}
