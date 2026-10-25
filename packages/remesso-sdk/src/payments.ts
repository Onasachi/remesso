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
  toHex,
} from "viem";
import {
  getBlockNumber,
  getLogs,
  getTransaction,
  getTransactionCount,
  getTransactionReceipt,
  prepareTransactionRequest,
  sendRawTransaction,
  signTransaction,
} from "viem/actions";
import { allowanceAbi } from "./abi.js";
import { type Ctx, gasFor, refusal } from "./context.js";
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
};

export const DEPLOYMENT = `${CHAIN_ID}:${ALLOWANCE.toLowerCase()}`;
const REPEAT_MS = 10 * 60_000;
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
  const local = () => {
    const account = ctx.requireAccount();
    if (account.type !== "local") {
      throw new RemessoError("no_account", "agent payments are signed before they're sent, which needs a local account (privateKeyToAccount)");
    }
    return account;
  };

  /// Simulate, then sign without sending. Throws the contract's refusal
  /// before anything is signed.
  async function sign(p: Policy, to: Address, units: bigint, memo: Hex) {
    const account = local();
    const fee = await gasFor(ctx, findToken(p.token) ?? null, 120_000n);
    const args = [p.id, to, units, memo] as const;
    try {
      await ctx.pub.simulateContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "pay", args, account, ...fee } as never);
    } catch (e) {
      throw new RemessoError("refused", `the policy refuses this payment: ${refusal(e)}`);
    }
    const data = encodeFunctionData({ abi: allowanceAbi, functionName: "pay", args });
    const request = await prepareTransactionRequest(ctx.pub, {
      account,
      to: ALLOWANCE,
      data: ctx.dataSuffix ? concat([data, ctx.dataSuffix]) : data,
      ...fee,
    } as never);
    const raw = await signTransaction(ctx.pub, { ...request, account } as never);
    return { hash: keccak256(raw), raw, nonce: Number((request as { nonce: number }).nonce) };
  }

  /// Broadcast a recorded payment and wait for its receipt. A failed
  /// broadcast may still have gone out, and a slow receipt isn't a failure:
  /// the record keeps the hash either way.
  async function broadcast(rec: PaymentRecord, waitMs: number): Promise<PaymentRecord> {
    try {
      await sendRawTransaction(ctx.pub, { serializedTransaction: rec.raw });
    } catch { /* already known, or accepted and unanswered: the receipt decides */ }
    try {
      const r = await ctx.pub.waitForTransactionReceipt({ hash: rec.hash, timeout: waitMs });
      const done: PaymentRecord = { ...rec, status: r.status === "success" ? "confirmed" : "reverted" };
      await ctx.store.save(done);
      return done;
    } catch {
      return rec;
    }
  }

  /// What became of a recorded payment whose outcome is unknown.
  async function reconcile(rec: PaymentRecord): Promise<PaymentRecord> {
    try {
      const r = await getTransactionReceipt(ctx.pub, { hash: rec.hash });
      return { ...rec, status: r.status === "success" ? "confirmed" : "reverted" };
    } catch { /* not mined, or this node hasn't seen it */ }
    try {
      await getTransaction(ctx.pub, { hash: rec.hash });
      return { ...rec, status: "sent" }; // in the mempool
    } catch { /* unknown to the node */ }
    const used = await getTransactionCount(ctx.pub, { address: local().address, blockTag: "latest" });
    // Its nonce is still free, so the signed bytes never went out and still can.
    if (used <= rec.nonce) return { ...rec, status: "unsent" };
    // The nonce went to another transaction, so this one never lands. A last
    // look for its Paid event, in case a node lost track of the receipt.
    const head = await getBlockNumber(ctx.pub);
    const logs = await getLogs(ctx.pub, {
      address: ALLOWANCE, event: PAID, args: { id: BigInt(rec.policyId), to: rec.to },
      fromBlock: head > 4_999n ? head - 4_999n : 0n, toBlock: head,
    });
    const hit = logs.find((l) => l.args.amount === BigInt(rec.units) && l.args.memo === rec.memo);
    return hit ? { ...rec, status: "confirmed", hash: hit.transactionHash } : { ...rec, status: "dropped" };
  }

  /// The same payment in the last ten minutes, recorded here or on-chain:
  /// the usual sign of a timed-out call being retried.
  async function recentRepeat(policyId: bigint, to: Address, units: bigint, memo: Hex): Promise<{ hash: Hex } | null> {
    const mine = (await ctx.store.since(Date.now() - REPEAT_MS)).find((p) =>
      p.deployment === DEPLOYMENT && p.policyId === policyId.toString() && p.to === to && p.units === units.toString() &&
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
    ...extra,
  });

  /// The policy to pay under: the one named, or an active one for the token
  /// that can cover the amount right now.
  async function choose(input: PayInput, units: (p: Policy) => bigint): Promise<Policy> {
    const agent = local().address.toLowerCase();
    if (input.policyId != null) {
      const p = await policies.get(input.policyId);
      if (p.agent.toLowerCase() !== agent) throw new RemessoError("refused", `policy ${p.id} names ${p.agent}, not this agent`);
      return p;
    }
    const want = input.token ? findToken(input.token) : undefined;
    if (input.token && !want) throw new RemessoError("invalid", `unknown token ${input.token}`);
    let fallback: Policy | null = null;
    for (const id of await policies.find()) {
      const p = await policies.get(id);
      if (!p.active || (want && p.token.toLowerCase() !== want.address.toLowerCase())) continue;
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
      if (key === "") throw new RemessoError("invalid", "idempotencyKey can't be empty: leave it out, or give one per payment");
      const waitMs = input.waitMs ?? 45_000;
      const unitsFor = (p: Policy) => {
        const t = findToken(p.token);
        if (!t) throw new RemessoError("refused", `policy ${p.id} spends a token Remesso doesn't know (${p.token})`);
        return toUnits(input.amount, t);
      };

      // A key seen before: report what became of that payment.
      let prior = key ? await ctx.store.byKey(key, DEPLOYMENT) : undefined;
      if (prior) {
        const t = findToken(prior.token);
        const units = t ? toUnits(input.amount, t) : null;
        if (prior.to !== to || prior.units !== units?.toString() || prior.memo !== memo) {
          throw new RemessoError("key_reused", `idempotency key "${key}" was already used for a different payment (${formatAmount(prior.units, prior.token)} to ${prior.to})`);
        }
        prior = await reconcile(prior);
        await ctx.store.save(prior);
        if (prior.status === "unsent") {
          // Signed and recorded, never sent: its own bytes go now. Same
          // payment, same nonce, so still at most once.
          prior = await broadcast(prior, waitMs);
        }
        if (prior.status === "confirmed") return result(prior, { repeat: true });
        if (prior.status === "reverted") {
          throw new RemessoError("reverted", `this key's payment reverted on-chain, so nothing was paid: ${explorer(prior.hash)}. Use a new key to try again.`, { hash: prior.hash });
        }
        if (prior.status === "sent" || prior.status === "unsent") return result(prior);
        // "dropped": it never landed and never can. Pay now, under the same key.
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
      const rec: PaymentRecord = {
        key: key ?? null,
        deployment: DEPLOYMENT,
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
      await ctx.store.save(rec);
      const done = await broadcast(rec, waitMs);
      if (done.status === "reverted") {
        throw new RemessoError("reverted", `the payment reverted on-chain, so nothing was paid: ${explorer(done.hash)}`, { hash: done.hash });
      }
      return result(done);
    });
  };
}
