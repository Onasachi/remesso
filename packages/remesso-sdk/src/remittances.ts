/// The developer-facing send operation: exact recipient amounts with an
/// explicit funding model. Both routes produce indexed Remesso payments.
import type { Address } from "viem";
import type { Ctx } from "./context.js";
import { checksum, token as tokenOf, toUnits } from "./deployment.js";
import type { Lifecycle } from "./lifecycle.js";
import type { Quotes, QuoteOptions, RemittanceQuote } from "./quotes.js";
import { RemessoError } from "./errors.js";
import type { PaymentResult } from "./payments.js";
import type { Policies } from "./policies.js";
import type { Requests, RequestStatus } from "./requests.js";
import type { makeWalletRemittances } from "./wallet-remittances.js";

export type RemittanceFunding =
  | { funding: "wallet"; policyId?: never; payer?: never }
  | { funding: "policy"; policyId?: bigint | number | string; payer?: string };

export type SendRemittanceInput = RemittanceFunding & {
  to: string;
  /** Exact decimal amount the recipient should receive. */
  amount: string;
  token: string;
  /** Stable for the intended payment. Retrying must use the same key and terms. */
  idempotencyKey: string;
  /** Optional one-off invoice. It must match the recipient, amount and token. */
  requestId?: string;
  waitMs?: number;
  /** Maximum token debit including protocol fees, excluding network gas. */
  maxDebit?: string;
  /** Last Unix second at which the SDK may start/resume a send. */
  validUntil?: number;
};

export type PolicyRemittanceResult = PaymentResult & {
  funding: "policy";
  /** The policy owner whose funds moved. */
  payer: Address;
  fee: bigint;
};
export type WalletRemittances = ReturnType<typeof makeWalletRemittances>;
export type RemittanceResult = PolicyRemittanceResult | Awaited<ReturnType<WalletRemittances["send"]>>;

/** Shared exact-invoice rules. A changed-terms answer is not full settlement. */
export function exactRequest(r: RequestStatus, terms: { to: string; amount: string; token: string }): void {
  if (!["pending", "accepted", "accepted_with_changes"].includes(r.status)) throw new RemessoError("refused", `request ${r.id} is ${r.status}`);
  if (!r.requested.amount || !r.requested.token || r.requested.intervalSeconds != null || (r.requested.runs != null && r.requested.runs !== 1)) {
    throw new RemessoError("refused", "one-off remittances require a fixed amount and token without a recurring cadence; use schedules for recurring requests");
  }
  const t = tokenOf(terms.token);
  if (checksum(r.requested.to) !== checksum(terms.to) || tokenOf(r.requested.token).address.toLowerCase() !== t.address.toLowerCase() || toUnits(r.requested.amount, t) !== toUnits(terms.amount, t)) {
    throw new RemessoError("refused", "the remittance must match every invoice term exactly");
  }
}

export function makeRemittances(ctx: Ctx, deps: { pay: (input: import("./payments.js").PayInput) => Promise<PaymentResult>; policies: Policies; requests: Requests; wallet: WalletRemittances }) {
  return {
    async send(input: SendRemittanceInput): Promise<RemittanceResult> {
      if (!input || !["policy", "wallet"].includes(input.funding)) throw new RemessoError("invalid", "choose funding: wallet or policy explicitly");
      if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()) throw new RemessoError("invalid", "a remittance requires a nonempty idempotencyKey");
      const to = checksum(input.to);
      const t = tokenOf(input.token);
      const amount = toUnits(input.amount, t);
      if (amount <= 0n) throw new RemessoError("invalid", "a remittance amount must be positive");
      if (input.validUntil !== undefined && (!Number.isSafeInteger(input.validUntil) || input.validUntil <= Math.floor(Date.now() / 1000))) throw new RemessoError("refused", "this payment intent has expired; prepare and review a fresh quote");
      if (input.maxDebit !== undefined && toUnits(input.maxDebit, t) < amount) throw new RemessoError("refused", "the payment exceeds maxDebit");
      let request: RequestStatus | undefined;
      if (input.requestId) {
        request = await deps.requests.get(input.requestId);
        exactRequest(request, input);
      }
      if (input.funding === "wallet") {
        if ("policyId" in input && input.policyId != null || "payer" in input && input.payer != null) throw new RemessoError("invalid", "wallet funding spends this account's funds; do not supply a policy or another payer");
        return await deps.wallet.send(input);
      }
      if (request?.payment?.schedule) throw new RemessoError("refused", "this invoice already has a schedule; another policy payment could pay it twice");
      if (request && input.payer && checksum(input.payer) !== checksum(request.payer)) throw new RemessoError("refused", "the requested payer differs from the invoice payer");
      const paid = request
        ? await deps.requests.pay(request.id, { policyId: input.policyId, idempotencyKey: input.idempotencyKey, waitMs: input.waitMs, validUntil: input.validUntil })
        : await deps.pay({ to, amount: input.amount, token: t.address, payer: input.payer, policyId: input.policyId, idempotencyKey: input.idempotencyKey, waitMs: input.waitMs, validUntil: input.validUntil });
      const policy = await deps.policies.get(paid.policyId);
      return { ...paid, funding: "policy", payer: policy.owner, fee: 0n };
    },
  };
}

export type PreparedRemittance = { input: SendRemittanceInput; quote: RemittanceQuote };
export type Remittances = ReturnType<typeof makeRemittances> & Lifecycle & Quotes & {
  prepare(input: SendRemittanceInput, options?: QuoteOptions): Promise<PreparedRemittance>;
};
