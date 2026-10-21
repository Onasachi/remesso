/// How much of a schedule one approval should cover.
///
/// Only the sender's own wallet can grant permission to spend their USDT, and
/// MiniPay cannot sign messages, so signature-based approvals (EIP-2612 permit,
/// ERC-3009) are unavailable to this audience. One approval transaction is
/// therefore unavoidable — the only thing we control is how rarely it comes
/// back. Sizing it to the schedule's committed life is what turns "approve
/// again every few runs" into "approve once".
///
/// The cap is the other half. An approval is the ceiling on everything Remesso
/// can ever move, and the whole safety story rests on it being finite, so an
/// unlimited approval is not on the table however convenient it would be.

/// Ceiling on runs one approval may cover. An open-ended schedule at a short
/// interval would otherwise ask for a lifetime of transfers in one go — a
/// 5-minute test schedule is 105,000 runs a year.
export const MAX_RUNS_PER_APPROVAL = 52;

/// A year, for schedules that would otherwise run forever.
const HORIZON_SECONDS = 365 * 24 * 60 * 60;

/// Runs to cover for one schedule: whichever of its own limits comes first.
///
/// `maxRuns` and the expiry are the sender's own envelope — covering beyond
/// either would approve for runs the contract will never make.
export function runsToCover(s: {
  intervalSeconds: number;
  maxRuns: number;
  expiresAtMs: number | null;
  /// A transfer goes at `fromMs` itself, as it does for a schedule that
  /// starts now. Required so no caller can forget it: the count is one
  /// transfer short without it.
  startNow: boolean;
  fromMs?: number;
}): number {
  const interval = Math.max(1, s.intervalSeconds);

  const limits = [MAX_RUNS_PER_APPROVAL, Math.ceil(HORIZON_SECONDS / interval)];
  if (s.maxRuns > 0) limits.push(s.maxRuns);
  // Shrinks as the expiry nears, which also keeps a re-approval from
  // covering runs the schedule no longer has time to make. Counted in
  // transfers, not whole intervals: the form ends a schedule on the day of
  // its last transfer, so one that starts now has one more transfer than
  // intervals, and counting intervals approved 11 of the default 12. The
  // 12th was then skipped for want of allowance.
  const fits = transfersBeforeExpiry(s);
  if (fits !== null) limits.push(fits);
  return Math.max(1, Math.min(...limits));
}

/// How many transfers can actually happen before a schedule expires.
///
/// The contract caps a schedule's life at 365 days but never checks the
/// transfer count against the expiry, so "8 quarterly transfers, expires in
/// 330 days" is accepted and then silently makes three. The sender finds out
/// by the schedule ending with most of its transfers unmade.
export function transfersBeforeExpiry(s: {
  intervalSeconds: number;
  expiresAtMs: number | null;
  startNow: boolean;
  fromMs?: number;
}): number | null {
  if (!s.expiresAtMs) return null;
  const interval = Math.max(1, s.intervalSeconds);
  const seconds = (s.expiresAtMs - (s.fromMs ?? Date.now())) / 1000;
  if (seconds <= 0) return 0;
  // A schedule that starts now gets one transfer on the spot; one that waits
  // gets its first only after a full interval has passed.
  return Math.floor(seconds / interval) + (s.startNow ? 1 : 0);
}
