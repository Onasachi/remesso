/// Payment requests: "please pay me", with states.
///
/// A request lands in the payer's Remesso inbox and gives a link that opens
/// their form prefilled. It can't create a schedule or move a token: the payer
/// signs in their own wallet, and only a payment with a transaction counts.
/// Accepted is not paid.
import type { Address, Hex } from "viem";
import type { Ctx } from "./context.js";
import { checksum, findToken } from "./deployment.js";
import { RemessoError } from "./errors.js";
import type { PayInput, PaymentResult } from "./payments.js";
import type { Policies } from "./policies.js";
import type { Cadence } from "./schedules.js";
import { declineTypedData, MAX_DECLINE_TTL_SECS } from "./vendor/request-decline.js";

export type RequestState = "pending" | "accepted" | "accepted_with_changes" | "declined" | "expired" | "dismissed" | "used";

export type RequestStatus = {
  id: string;
  /** The id without dashes: what a policy payment carries in its memo to answer it. */
  reference: string;
  status: RequestState;
  /** The wallet asked to pay. */
  payer: Address;
  /** What was asked. The amount is what the recipient receives. */
  requested: { to: Address; amount: string | null; token: string | null; intervalSeconds: number | null; runs: number | null };
  /** What the payer signed, once answered, and which terms differ. */
  signed: unknown;
  /** Null until answered. `paid` only with transactions. */
  payment: null | {
    state: "paid" | "scheduled" | "failed";
    schedule: { contract: Address; id: string } | null;
    txs: { txHash: Hex; amount: string; final: boolean; blockTime: string }[];
    reason: string | null;
  };
};

export type RequestSummary = {
  id: string;
  reference: string;
  to: Address;
  amount: string | null;
  token: string | null;
  intervalSeconds: number | null;
  runs: number | null;
  from: string | null;
  note: string | null;
  status: RequestState;
  createdAt: string;
};

export type CreateRequestInput = {
  /** The wallet you're asking. */
  payer: string;
  /** Where you want to be paid. Default: this account. */
  to?: string;
  /** What you want to receive per payment, decimal. The payer's form adds the fee on top. */
  amount?: string;
  token?: string;
  every?: Cadence;
  runs?: number;
  /** Who is asking, up to 40 characters. */
  from?: string;
  /** Why, up to 120 characters. */
  note?: string;
};

export function makeRequests(ctx: Ctx, deps: { pay(input: PayInput): Promise<PaymentResult>; policies: Policies }) {
  const call = <T>(body: Record<string, unknown>) => ctx.post<T>(ctx.endpoints.requestPayment, body);

  async function get(id: string): Promise<RequestStatus> {
    return await call<RequestStatus>({ action: "status", id: uuid(id) });
  }

  return {
    get,

    /// Ask `payer` to pay you. Free. Returns the request and the link that
    /// opens their form prefilled.
    async create(input: CreateRequestInput): Promise<{ id: string; reference: string; link: string; status: RequestState }> {
      const to = input.to ? checksum(input.to) : ctx.account?.address;
      if (!to) throw new RemessoError("invalid", "to is required without an account: where you want to be paid");
      if (input.token && !findToken(input.token)) throw new RemessoError("invalid", `unknown token ${input.token}`);
      const out = await call<{ id: string; link: string; status: RequestState }>({
        payer: checksum(input.payer),
        to,
        amount: input.amount,
        token: input.token ? findToken(input.token)!.symbol : undefined,
        every: input.every,
        runs: input.runs,
        from: input.from,
        note: input.note,
      });
      return { ...out, reference: out.id.replace(/-/g, "") };
    },

    /// The live requests addressed to `payer` (default: this account):
    /// pending and under 30 days old.
    async list(payer?: string): Promise<RequestSummary[]> {
      const who = payer ? checksum(payer) : ctx.requireAccount().address;
      return (await call<{ requests: RequestSummary[] }>({ action: "list", payer: who })).requests;
    },

    /// Report the schedule that answers a request. It binds only if it is
    /// from the wallet asked, pays the address that asked, was created after
    /// the request, and answers no other request.
    async answer(id: string, scheduleId: bigint | number | string, contract?: string) {
      const out = await call<{ ok: boolean; status: RequestState; signed: unknown }>({
        action: "answer",
        id: uuid(id),
        schedule: String(scheduleId),
        ...(contract ? { contract: checksum(contract) } : {}),
      });
      return { status: out.status, signed: out.signed };
    },

    /// Turn a request down, for everyone: signed by the wallet it was sent
    /// to, or by an agent under a live policy from that wallet (`policyId`).
    async decline(id: string, opts: { policyId?: bigint | number | string; ttlSeconds?: number } = {}) {
      const account = ctx.requireAccount();
      if (!ctx.wallet) throw new RemessoError("no_account", "declining needs an account that can sign");
      const rid = uuid(id);
      const ttl = Math.min(Math.max(opts.ttlSeconds ?? 600, 60), MAX_DECLINE_TTL_SECS);
      const expiry = Math.floor(Date.now() / 1000) + ttl;
      const signature = await ctx.wallet.signTypedData({ account, ...declineTypedData(rid, expiry) } as never);
      return await call<{ ok: boolean; id: string; status: RequestState }>({
        action: "decline",
        id: rid,
        expiry,
        signature,
        ...(opts.policyId != null ? { agent: account.address, policy_id: String(opts.policyId) } : {}),
      });
    },

    /// Pay a request through a policy, as an agent. The payment carries the
    /// request's reference, so the requester sees it answered, and the
    /// request id is the default idempotency key: one payment per request.
    async pay(id: string, opts: Omit<PayInput, "to" | "memo" | "amount" | "token"> & { amount?: string } = {}): Promise<PaymentResult> {
      const r = await get(id);
      if (!["pending", "accepted", "accepted_with_changes"].includes(r.status)) {
        throw new RemessoError("refused", `request ${r.id} is ${r.status}, so it isn't paid`);
      }
      const amount = opts.amount ?? r.requested.amount;
      if (!amount) throw new RemessoError("invalid", `request ${r.id} names no amount, so pass one`);
      const token = r.requested.token ?? "USDT";
      // A request is addressed to one wallet. Paying someone else's from this
      // person's wallet answers nothing.
      const policyIds = opts.policyId != null ? [BigInt(opts.policyId)] : await deps.policies.find();
      const mine = [];
      for (const pid of policyIds) {
        const p = await deps.policies.get(pid);
        if (p.active && p.owner.toLowerCase() === r.payer.toLowerCase() && p.symbol === findToken(token)?.symbol) mine.push(p);
      }
      if (!mine.length) {
        throw new RemessoError("refused", `request ${r.id} was sent to ${r.payer}, and no active ${token} policy from that wallet names this agent`);
      }
      return await deps.pay({
        ...opts,
        to: r.requested.to,
        amount,
        token,
        memo: r.reference,
        policyId: opts.policyId ?? mine[0].id,
        idempotencyKey: opts.idempotencyKey ?? `request:${r.id}`,
      });
    },

    /// Wait until a request is paid: a payment with a transaction, not an
    /// answer. Polls `status`.
    async waitUntilPaid(id: string, opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<RequestStatus> {
      const until = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
      for (;;) {
        const r = await get(id);
        if (r.payment?.state === "paid") return r;
        if (r.status === "declined" || r.status === "expired") throw new RemessoError("refused", `request ${r.id} is ${r.status}`);
        if (Date.now() > until) throw new RemessoError("timeout", `request ${r.id} isn't paid yet (${r.status})`);
        if (opts.signal?.aborted) throw new RemessoError("timeout", "stopped");
        await new Promise((res) => setTimeout(res, opts.intervalMs ?? 15_000));
      }
    },
  };
}

export type Requests = ReturnType<typeof makeRequests>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(id: string): string {
  const s = String(id).trim().toLowerCase();
  if (!UUID.test(s)) throw new RemessoError("invalid", `not a payment request id: ${id}`);
  return s;
}
