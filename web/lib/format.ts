/// Formatting helpers. Every amount in this app is an integer in token base
/// units — 6dp for both USDT and cNGN — and is only ever converted to a
/// decimal string at the point of display.

/// Coerce whatever the source actually hands us into a bigint.
///
/// PostgREST serialises `numeric(78,0)` as a JSON *number*, not a string, so a
/// column typed `string` in lib/types.ts arrives as a number at runtime and
/// TypeScript cannot catch it. Getting this wrong crashed the schedule detail
/// page with "Cannot mix BigInt and other types" immediately after the first
/// live run.
///
/// Above 2^53 a JSON number has already lost precision before it reaches us;
/// nothing can be recovered here, so it is truncated rather than thrown on —
/// 9e15 base units is 9 billion tokens at 6dp, far beyond any real amount.
function toUnits(v: bigint | string | number): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(v);
}

/// Format base units for display.
///
/// `decimals` is the token's own scale and must be passed — USDT and USDC are
/// 6dp while USDm is 18dp, so a hardcoded 6 is wrong for a third of the assets
/// this app accepts.
export function formatUnits(
  v: bigint | string | number,
  decimals: number,
  dp = 2,
): string {
  const n = toUnits(v);
  const scale = 10n ** BigInt(decimals);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").slice(0, dp);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${dp > 0 ? `.${frac}` : ""}`;
}

/// Like `formatUnits`, but never rounds a small amount away: every significant
/// decimal up to `maxDp`, and at least `minDp`. For the lines a sender checks
/// before signing — the fee and what the recipient receives. At 0.10 USDT the
/// 0.25% fee is 0.00025 and the recipient gets 0.09975; two decimals showed
/// "fee 0.00 · they receive 0.09", which read as a cent going missing.
export function formatExact(v: bigint | string | number, decimals: number, minDp = 2, maxDp = 6): string {
  const full = formatUnits(v, decimals, Math.min(decimals, maxDp));
  const [whole, frac = ""] = full.split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(minDp, "0");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/// Parse a user-typed decimal into base units at the token's own scale, without
/// going through a float — "0.1" as a Number is not exact, and at scale that is
/// money quietly disappearing.
export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("enter a number");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0");
}


const INTERVALS = [
  { label: "Weekly", seconds: 7 * 24 * 3600 },
  { label: "Fortnightly", seconds: 14 * 24 * 3600 },
  { label: "Monthly", seconds: 30 * 24 * 3600 },
  { label: "Quarterly", seconds: 90 * 24 * 3600 },
] as const;

/// The real product's shortest cadence is weekly, which means a live schedule
/// yields exactly one observable run and then nothing for seven days — useless
/// for proving the agent actually repeats. This cadence exists so a test can
/// watch several runs inside a few minutes.
///
/// Gated, and deliberately not merely "unlisted": a five-minute remittance is
/// not a thing anyone wants by accident, and with `maxRuns` at its default of
/// 12 it would drain a full allowance within the hour.
export const TEST_INTERVAL = { label: "Every 5 minutes (testing)", seconds: 300 } as const;

export const TEST_INTERVALS_ENABLED =
  process.env.NEXT_PUBLIC_TEST_INTERVALS === "1";

/// What the picker offers. `INTERVALS` keeps stable indices for anything that
/// refers to it positionally; the test cadence is only ever prepended here.
export const SELECTABLE_INTERVALS: ReadonlyArray<{ label: string; seconds: number }> =
  TEST_INTERVALS_ENABLED ? [TEST_INTERVAL, ...INTERVALS] : INTERVALS;

export { INTERVALS };

export function intervalLabel(seconds: number | bigint): string {
  const s = Number(seconds);
  const known = SELECTABLE_INTERVALS.find((i) => i.seconds === s);
  if (known) return known.label;
  if (s % 86400 === 0) return `Every ${s / 86400} days`;
  if (s % 3600 === 0) return `Every ${s / 3600} hours`;
  if (s % 60 === 0) return `Every ${s / 60} minutes`;
  return `Every ${s}s`;
}

/// The cadence as a phrase: "every week", "every 5 minutes". For sentences.
export function everyLabel(seconds: number | bigint): string {
  const s = Number(seconds);
  const named: Record<number, string> = {
    [7 * 86400]: "every week",
    [14 * 86400]: "every two weeks",
    [30 * 86400]: "every month",
    [90 * 86400]: "every quarter",
  };
  return named[s] ?? intervalLabel(s).toLowerCase();
}

/// The cadence as a duration: "a week", "two weeks", "5 minutes". For "in …".
export function spanLabel(seconds: number | bigint): string {
  return everyLabel(seconds).replace(/^every /, "").replace(/^(week|month|quarter)$/, "a $1");
}

export function relativeTime(iso: string | number | null | undefined): string {
  if (!iso) return "—";
  const t = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86400_000, "day"],
    [3600_000, "hour"],
    [60_000, "minute"],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [ms, unit] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

/// The floor rate the contract stores: minimum cNGN base units out per 1e6
/// USDT base units in. With both tokens at 6dp that is just naira-per-dollar
/// scaled by 1e6, which is the only reason a "rate" and a "unit price" can be
/// the same number here.
export function rateToNairaPerUsd(rateE6: bigint | string | number): number {
  return Number(toUnits(rateE6)) / 1_000_000;
}

export function nairaPerUsdToRateE6(naira: number): bigint {
  return BigInt(Math.floor(naira * 1_000_000));
}

/// A countdown to a moment, for a clock that is ticking while someone watches.
///
/// `relativeTime` rounds to the nearest minute and reads as a statement ("in
/// 4 minutes"); this counts. Under an hour it shows seconds, because the whole
/// point is watching it move. Past the moment it stops counting up: a payment
/// that is a minute late is not interesting, it is either about to land or in
/// the checks above it.
export function countdown(msRemaining: number): string {
  if (msRemaining <= 0) return "any moment now";
  const s = Math.round(msRemaining / 1000);
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
