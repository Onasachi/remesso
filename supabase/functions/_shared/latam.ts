/// Pesos and reais on Celo: where their dollar price comes from, and how
/// money gets in and out. Shared by `latam-rate` and `latam-route`.
///
/// Two independent on-chain sources, read side by side rather than blended:
///   - Textile's RFQ makers (the same public ticker feed `rate-service` reads
///     for naira) — top-of-book bid and ask, indicative, not a firm quote;
///   - the Uniswap v3 pool on Celo — what the pool would actually return at
///     the caller's size, price impact included.
/// When they disagree by more than `DISAGREE_BPS` the response says so. An
/// agent pricing a corridor should hear that the market is split, not get a
/// silent average of two numbers that do not agree.
///
/// wCOP has neither a pool nor a maker on Celo (checked 2026-10-11), so it is
/// answered as "no on-chain market", never with a number from somewhere else.
import { quoteExactIn } from "./celo.ts";
import { CELO } from "./config.ts";

export const FEED = "https://api.textilecredit.com/tickers";
const APP = "https://remesso-3q67.vercel.app";

/// Above this, two sources quoting the same pair are reported as disagreeing.
const DISAGREE_BPS = 100;

export type Corridor = {
  country: "AR" | "BR" | "CO";
  currency: "ARS" | "BRL" | "COP";
  symbol: "wARS" | "wBRL" | "wCOP";
  address: `0x${string}`;
  decimals: 18;
  /// Textile ticker id, or null where no maker quotes it.
  ticker: string | null;
  /// Uniswap fee tier of the USDT pool, or null where there is no pool.
  poolFee: number | null;
};

/// Addresses verified on-chain 2026-10-06; pools and tickers 2026-10-11.
export const CORRIDORS: Corridor[] = [
  { country: "AR", currency: "ARS", symbol: "wARS", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", decimals: 18, ticker: "USDT_WARS", poolFee: 100 },
  { country: "BR", currency: "BRL", symbol: "wBRL", address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0", decimals: 18, ticker: "USDT_WBRL", poolFee: 100 },
  { country: "CO", currency: "COP", symbol: "wCOP", address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76", decimals: 18, ticker: null, poolFee: null },
];

export function corridor(key: string | undefined): Corridor | undefined {
  const k = (key ?? "").trim().toUpperCase();
  return CORRIDORS.find((c) => c.country === k || c.currency === k || c.symbol.toUpperCase() === k);
}

export type MakerQuote = {
  source: "textile-rfq";
  /// Local units a maker pays for 1 USDT (what you get selling dollars).
  bid: number | null;
  /// Local units a maker asks for 1 USDT (what you pay buying dollars back).
  ask: number | null;
  last: number | null;
  indicative: true;
};

/// Top of book for every corridor that has a ticker, in one fetch. A zero side
/// in the feed means nobody is quoting it, and is returned as null — the same
/// rule `rate-service` follows, for the same reason.
export async function makerQuotes(): Promise<Map<string, MakerQuote>> {
  const res = await fetch(FEED, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const rows = await res.json() as Array<Record<string, string>>;
  const out = new Map<string, MakerQuote>();
  for (const r of rows) {
    const pos = (v: string | undefined) => (Number(v) > 0 ? Number(v) : null);
    out.set(r.ticker_id, { source: "textile-rfq", bid: pos(r.bid), ask: pos(r.ask), last: pos(r.last_price), indicative: true });
  }
  return out;
}

export type PoolQuote = {
  source: "uniswap-v3";
  pool: { fee: number; tokenIn: "USDT" };
  /// USDT sold.
  usdIn: number;
  /// Local units the pool returns for `usdIn`, after its fee.
  out: number;
  /// out / usdIn.
  rate: number;
  /// How much worse `rate` is than a 1-dollar trade, in basis points.
  impactBps: number;
};

/// What the pool returns for `usd` dollars right now, and how much the size
/// itself moves the price. `null` if the corridor has no pool or the pool
/// cannot fill — never a guess.
export async function poolQuote(c: Corridor, usd: number): Promise<PoolQuote | null> {
  if (c.poolFee === null) return null;
  const units = (n: number) => BigInt(Math.round(n * 1e6)); // USDT is 6dp
  try {
    const [small, sized] = await Promise.all([
      quoteExactIn(CELO.usdt, c.address, units(1), c.poolFee),
      quoteExactIn(CELO.usdt, c.address, units(usd), c.poolFee),
    ]);
    const out = Number(sized) / 10 ** c.decimals;
    const rate = out / usd;
    const ref = Number(small) / 10 ** c.decimals;
    return {
      source: "uniswap-v3",
      pool: { fee: c.poolFee, tokenIn: "USDT" },
      usdIn: usd,
      out: round(out, 2),
      rate: round(rate, 4),
      impactBps: ref > 0 ? Math.max(0, Math.round((1 - rate / ref) * 10_000)) : 0,
    };
  } catch {
    return null;
  }
}

/// Basis points between two prices of the same pair, or null if either is
/// missing.
export function gapBps(a: number | null, b: number | null): number | null {
  if (!a || !b) return null;
  return Math.round((Math.abs(a - b) / ((a + b) / 2)) * 10_000);
}
export const disagrees = (bps: number | null) => bps !== null && bps > DISAGREE_BPS;

/// Ripio's public hosted ramp. A link and nothing more — no credentials, no
/// callback; the person does Ripio's own checks there. Same rules as the web
/// app's `web/lib/ripio.ts` (duplicated, not imported: Edge Functions deploy
/// only what is under supabase/functions): uppercase token, Celo 42220,
/// `/off-ramp` because `/offramp` 308s to it, an invalid address left out.
export function ripioLink(side: "buy" | "cashout", c: Corridor, opts: { amount?: number; address?: string } = {}) {
  const q = new URLSearchParams({ country: c.country, chain: "42220", token: c.symbol.toUpperCase() });
  if (opts.amount && opts.amount > 0) q.set("amount", String(Math.round(opts.amount)));
  if (opts.address && /^0x[0-9a-fA-F]{40}$/.test(opts.address)) q.set("address", opts.address);
  return `https://ramp.ripio.com/${side === "cashout" ? "off-ramp" : ""}?${q}`;
}

/// A Remesso send form, prefilled. The payer still reviews and signs every
/// field; a link can fill a form, never pay.
export function scheduleLink(c: Corridor, amount: number, every: string, to?: string) {
  const q = new URLSearchParams({ token: c.symbol.toUpperCase(), amount: String(Math.round(amount)), every });
  if (to && /^0x[0-9a-fA-F]{40}$/.test(to)) q.set("to", to);
  return `${APP}/schedules/new?${q}`;
}

export const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
