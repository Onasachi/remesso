/// `latam-rate` — the dollar price of pesos and reais on Celo, sold over x402.
///
/// USD → wARS and USD → wBRL from two independent on-chain sources, side by
/// side: Textile's RFQ makers (bid/ask, indicative) and the Uniswap v3 pool
/// (what it returns at the caller's size, with price impact). A flag says when
/// they disagree. wCOP is answered honestly: no on-chain market on Celo.
///
/// Input (all optional): `{"usd": 100}` — the size to price the pool at,
/// default 100, capped at 100,000 so nobody prices a pool at a size it
/// cannot hold.
///
/// `verify_jwt = false`: the payment is the authentication.
import { type PaidService, servePaid } from "../_shared/x402-serve.ts";
import { CORRIDORS, disagrees, gapBps, makerQuotes, poolQuote, round } from "../_shared/latam.ts";

export const service = {
  path: "latam-rate",
  name: "latam-rate",
  description:
    "Live USD-to-wARS and USD-to-wBRL on Celo from Textile's RFQ makers and the Uniswap pool, side by side, with a flag when they disagree. wCOP has no on-chain market on Celo and is reported as such.",
  priceUnits: Deno.env.get("LATAM_RATE_PRICE_UNITS") ?? "1000",
  input: { usd: "optional number, the trade size to price the pool at (default 100, max 100000)" },
  parse: (b) => {
    const usd = (b as { usd?: unknown })?.usd ?? 100;
    if (typeof usd !== "number" || !(usd > 0) || usd > 100_000) return { error: "usd must be a number between 0 and 100000" };
    return { usd };
  },
  serve: async ({ usd }) => {
    const makers = await makerQuotes();
    const rates = await Promise.all(CORRIDORS.map(async (c) => {
      const maker = c.ticker ? makers.get(c.ticker) ?? null : null;
      const pool = await poolQuote(c, usd);
      if (!maker && !pool) {
        // Same shape as a priced row, so a reader indexing `bestRate` gets null
        // rather than undefined.
        return {
          pair: `USD/${c.symbol}`, currency: c.currency, token: c.address, market: "none on Celo",
          bestRate: null, maker: null, pool: null, sourcesGapBps: null, sourcesDisagree: false,
        };
      }
      // Compare like with like: the maker's bid (what a maker pays in local
      // units for a dollar) against what the pool pays for a dollar.
      const gap = gapBps(maker?.bid ?? null, pool?.rate ?? null);
      const best = Math.max(maker?.bid ?? 0, pool?.rate ?? 0);
      return {
        pair: `USD/${c.symbol}`,
        currency: c.currency,
        token: c.address,
        // Local units per dollar when selling dollars, from whichever source
        // pays more at this size. Null only if neither side is quoted.
        bestRate: best > 0 ? round(best, 4) : null,
        maker,
        pool,
        sourcesGapBps: gap,
        sourcesDisagree: disagrees(gap),
      };
    }));
    return { sizeUsd: usd, rates };
  },
} satisfies PaidService<{ usd: number }>;

servePaid(service);
