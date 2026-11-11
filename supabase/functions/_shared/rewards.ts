/// Who earns a first-payment reward. Pure: `pay-rewards` gathers the facts
/// (the payment from `payment_events`, each side's identity from the chain and
/// from Self), and this decides. Pinned by rewards.test.ts.
///
/// The reward is small, and $1 sent between two of your own wallets costs
/// about half a cent, so every rule here is about one thing: the reward goes
/// once to a real person who paid somebody else.
import { directToken, runLimits } from "./config.ts";

export type RewardPayment = {
  kind: string; // payment_events.kind
  from: string; // lowercased payer
  to: string | null; // lowercased recipient
  token: string | null;
  /// What the recipient received.
  amount: bigint | null;
  /// A run's gross, before the commission. Null for a policy payment, which
  /// carries no fee.
  amountIn: bigint | null;
  blockTime: Date;
  final: boolean;
  removed: boolean;
};

export type RewardFacts = {
  payment: RewardPayment;
  campaign: { startsAt: Date; endsAt: Date | null };
  /// Our own wallets: never rewarded, and never the other side of a payment
  /// that is.
  excluded: ReadonlySet<string>;
  /// The payer as a person: 'phone:<id>' or 'self:<nullifier>', or null.
  payerPerson: string | null;
  /// Every person key the recipient's wallet resolves to. One overlapping the
  /// payer's means it paid itself.
  recipientPersons: readonly string[];
  /// The recipient has paid this payer back, at any time. Two wallets passing
  /// the same dollar between them is the cheapest farm there is.
  paidBack: boolean;
};

export type RewardDecision =
  | { ok: true; personKey: string }
  | { ok: false; reason: RewardRefusal };

export type RewardRefusal =
  | "not_a_payment"
  | "not_final"
  | "outside_campaign"
  | "excluded"
  | "self_payment"
  | "unknown_token"
  | "too_small"
  | "no_identity"
  | "same_person"
  | "paid_back";

const PAYMENT_KINDS = new Set(["run", "policy_payment"]);

/// The least a payment must move to count: the executor's own per-run
/// minimum ($1 at its rough rate, rounded down) in the token's units. The same
/// floor a schedule must clear to run at all.
export function minimumFor(token: string): bigint | null {
  const t = directToken(token);
  if (!t) return null;
  return runLimits(t).min;
}

export function decideReward(f: RewardFacts): RewardDecision {
  const p = f.payment;
  const no = (reason: RewardRefusal): RewardDecision => ({ ok: false, reason });

  if (!PAYMENT_KINDS.has(p.kind) || !p.to) return no("not_a_payment");
  // Only what can't be reorged away: a reward paid for a payment that later
  // disappears can't be taken back.
  if (p.removed || !p.final) return no("not_final");
  if (p.blockTime < f.campaign.startsAt) return no("outside_campaign");
  if (f.campaign.endsAt && p.blockTime >= f.campaign.endsAt) return no("outside_campaign");

  const from = p.from.toLowerCase();
  const to = p.to.toLowerCase();
  if (f.excluded.has(from) || f.excluded.has(to)) return no("excluded");
  if (from === to) return no("self_payment");

  if (!p.token) return no("unknown_token");
  const min = minimumFor(p.token);
  if (min === null) return no("unknown_token");
  const moved = p.amountIn ?? p.amount;
  if (moved === null || moved < min) return no("too_small");

  if (!f.payerPerson) return no("no_identity");
  if (f.recipientPersons.includes(f.payerPerson)) return no("same_person");
  if (f.paidBack) return no("paid_back");

  return { ok: true, personKey: f.payerPerson };
}

/// The person behind a MiniPay wallet: the identifier MiniPay's issuer
/// attested for it. A wallet with several (a number moved here) uses the
/// first, and the others count as the same person for `same_person`.
export function phonePersons(identifiers: readonly string[]): string[] {
  return identifiers.map((i) => `phone:${i.toLowerCase()}`);
}
