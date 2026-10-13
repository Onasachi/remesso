/// The pre-flight agent's judgement, as a pure function: the facts about one
/// upcoming payment in, the notices it warrants out. No I/O, so every
/// threshold is pinned by `preflight.test.ts`.
///
/// It decides what to tell a sender and how urgently. It decides nothing
/// about the payment itself — that stays with the contract and the executor.

export type NoticeKind = "balance_short" | "allowance_short" | "allowance_ending" | "rate_moved";
export type Severity = "info" | "warn" | "urgent";
export type Notice = { kind: NoticeKind; severity: Severity; details: Record<string, string | number | null> };

export type Facts = {
  /// Per payment, in the token's base units.
  amountIn: bigint;
  balance: bigint;
  allowance: bigint;
  decimals: number;
  symbol: string;
  /// Seconds until the next payment is due (≤ 0 means due now).
  dueInSecs: number;
  /// Payments left including the next one; null when unlimited.
  runsLeft: number | null;
  /// For a peso or real payment: how far its dollar value moved since the
  /// agent's reading about a day ago, in percent. Null for dollar tokens or
  /// with no earlier reading.
  rateMovePct: number | null;
  /// The payment's dollar value now, for the rate notice. Null for dollars.
  usdNow: number | null;
};

/// Less than this long before the payment, a shortfall is urgent.
export const URGENT_WITHIN_SECS = 6 * 3600;
/// A peso/real payment's dollar value moving this much is worth a word…
export const RATE_INFO_PCT = 3;
/// …and this much, a warning.
export const RATE_WARN_PCT = 8;

const units = (v: bigint, d: number) => Number(v) / 10 ** d;

export function decide(f: Facts): Notice[] {
  const out: Notice[] = [];
  const soon = f.dueInSecs <= URGENT_WITHIN_SECS;
  const base = { symbol: f.symbol, amount: units(f.amountIn, f.decimals), dueInSecs: Math.max(0, Math.round(f.dueInSecs)) };

  // The next payment will be skipped: the contract checks the balance, and
  // the executor will not even try (`runnability().funded`).
  if (f.balance < f.amountIn) {
    out.push({
      kind: "balance_short",
      severity: soon ? "urgent" : "warn",
      details: { ...base, balance: units(f.balance, f.decimals), shortBy: units(f.amountIn - f.balance, f.decimals) },
    });
  }

  // Skipped for the other reason: Remesso may not move enough
  // (`runnability().approved`). Raised alone — a separate fix from the balance.
  if (f.allowance < f.amountIn) {
    out.push({
      kind: "allowance_short",
      severity: soon ? "urgent" : "warn",
      details: { ...base, allowance: units(f.allowance, f.decimals) },
    });
  } else if ((f.runsLeft === null || f.runsLeft > 1) && f.allowance < 2n * f.amountIn) {
    // The next one is covered; the one after will be skipped. Said a whole
    // interval early, while fixing it costs nothing.
    out.push({
      kind: "allowance_ending",
      severity: "info",
      details: { ...base, allowance: units(f.allowance, f.decimals), paymentsCovered: Number(f.allowance / f.amountIn) },
    });
  }

  // A peso or real payment's worth in dollars moved. The recipient still gets
  // exactly the pesos signed for — this is information for the sender, not a
  // problem with the payment.
  if (f.rateMovePct !== null && Math.abs(f.rateMovePct) >= RATE_INFO_PCT) {
    out.push({
      kind: "rate_moved",
      severity: Math.abs(f.rateMovePct) >= RATE_WARN_PCT ? "warn" : "info",
      details: { ...base, movePct: Math.round(f.rateMovePct * 10) / 10, usdNow: f.usdNow === null ? null : Math.round(f.usdNow * 100) / 100 },
    });
  }

  return out;
}

/// Percent change in a payment's DOLLAR value when the local-per-USD rate goes
/// from `before` to `now`. More pesos per dollar means the same pesos are worth
/// fewer dollars, so a weakening peso is a negative move.
export function dollarValueMovePct(beforeLocalPerUsd: number, nowLocalPerUsd: number): number {
  return (beforeLocalPerUsd / nowLocalPerUsd - 1) * 100;
}
