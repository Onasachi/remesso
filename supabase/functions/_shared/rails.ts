/// Which payout rails the backend will actually run.
///
/// `RemessoExecutorV5` is immutable and has all three rails compiled into it,
/// so "disable naira" cannot be a contract change — `pause()` is the only
/// lever the contract offers and it stops every rail at once. The switch has
/// to live in the two things that call the contract: the cron executor and the
/// paid trigger endpoint. Nothing else can refuse a run.
///
/// Off by default, and deliberately so. The naira rails are what carry the
/// open money-transmission question and the unverified cNGN account (see
/// CLAUDE.md); a deploy that forgets to set a flag should fail closed, toward
/// the rail that needs no payout partner.
///
/// This is the server-side twin of the frontend's
/// `NEXT_PUBLIC_ENABLE_CNGN_RAILS`. Two names rather than one because an
/// Edge Function reading a `NEXT_PUBLIC_` variable invites somebody to assume
/// the browser copy is authoritative — it hides a form, it does not refuse a
/// payment. Set both, or neither.
export const CNGN_RAILS_ENABLED = Deno.env.get("ENABLE_CNGN_RAILS") === "1";

/// `PayoutType` as the contract numbers it: 0 Wallet, 1 BankRedemption, 2
/// Direct. Both cNGN rails swap the funding asset into cNGN; Direct forwards
/// the funding asset untouched and touches no naira at any point.
export const PAYOUT_DIRECT = 2;

export const RAIL_DISABLED_DETAIL =
  "this schedule pays out in cNGN, and naira payouts are switched off pending " +
  "regulatory review. Stablecoin (Direct) schedules are unaffected.";
