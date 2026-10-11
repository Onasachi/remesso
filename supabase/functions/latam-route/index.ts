/// `latam-route` — how to get a given amount of pesos or reais to someone in
/// Argentina, Brazil or Colombia on Celo, sold over x402.
///
/// One call returns what a remittance agent needs to act: which token, how
/// many dollars it takes at this size and from which venue (with price impact),
/// Ripio's public buy and cash-out links prefilled, and a Remesso schedule
/// link prefilled. It moves nothing and signs nothing — every step it names is
/// one the payer takes in their own wallet or at Ripio.
///
/// Input: `{"country":"AR","amount":20000}` (local currency) or
/// `{"country":"BR","amount":20,"currency":"USD"}`; optional `"recipient":
/// "0x…"` and `"every": "week" | "month"`.
///
/// Ripio is linked, not integrated: no credentials, no partnership — the
/// person completes Ripio's own checks there.
///
/// `verify_jwt = false`: the payment is the authentication.
import { type PaidService, servePaid } from "../_shared/x402-serve.ts";
import { corridor, type Corridor, makerQuotes, poolQuote, ripioLink, round, scheduleLink } from "../_shared/latam.ts";

/// Remesso's commission on a scheduled payment, in basis points. Pinned per
/// schedule at signing (MAX_FEE_BPS 50 in the contract); 25 is what a schedule
/// created today takes.
const REMESSO_FEE_BPS = 25;

type In = { c: Corridor; amount: number; currency: "LOCAL" | "USD"; recipient?: string; every: string };

export const service = {
  path: "latam-route",
  name: "latam-route",
  description:
    "A route to deliver pesos or reais on Celo: token, dollars needed at your size and from which venue, Ripio buy/cash-out links and a prefilled Remesso schedule link. Argentina (wARS) and Brazil (wBRL) are priced on-chain; Colombia (wCOP) has no on-chain market on Celo and gets the Ripio route only.",
  priceUnits: Deno.env.get("LATAM_ROUTE_PRICE_UNITS") ?? "2000",
  input: {
    country: "AR | BR | CO (or ARS/BRL/COP, wARS/wBRL/wCOP)",
    amount: "number — how much the recipient should get, in local currency unless currency is USD",
    currency: "optional, LOCAL (default) or USD",
    recipient: "optional 0x address, prefilled into the links",
    every: "optional, week | fortnight | month (default month), for the schedule link",
  },
  parse: (b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    const c = corridor(typeof o.country === "string" ? o.country : undefined);
    if (!c) return { error: "country must be AR, BR or CO" };
    if (typeof o.amount !== "number" || !(o.amount > 0)) return { error: "amount must be a positive number" };
    const currency = String(o.currency ?? "LOCAL").toUpperCase() === "USD" ? "USD" : "LOCAL";
    if (currency === "USD" && o.amount > 100_000) return { error: "amount above 100000 USD" };
    const every = ["week", "fortnight", "month"].includes(String(o.every)) ? String(o.every) : "month";
    const recipient = typeof o.recipient === "string" && /^0x[0-9a-fA-F]{40}$/.test(o.recipient) ? o.recipient : undefined;
    if (o.recipient !== undefined && !recipient) return { error: "recipient must be a 0x address" };
    return { c, amount: o.amount, currency, recipient, every };
  },
  serve: async ({ c, amount, currency, recipient, every }) => {
    const ripio = {
      note: "Ripio's public ramp — the person completes Ripio's own checks there. Links only; no partnership.",
      buy: ripioLink("buy", c, { amount: currency === "LOCAL" ? amount : undefined }),
      cashOut: ripioLink("cashout", c, { address: recipient }),
    };

    // No on-chain market (wCOP): the route is Ripio alone, said plainly.
    if (c.ticker === null && c.poolFee === null) {
      return {
        country: c.country,
        token: { symbol: c.symbol, address: c.address, decimals: c.decimals },
        onChainMarket: false,
        route: [
          `Buy ${c.symbol} with ${c.currency} at Ripio (Ripio may not offer ${c.symbol} on Celo; check before relying on it).`,
          `Create a Remesso schedule paying ${c.symbol}; the recipient receives ${c.symbol} with no conversion.`,
          `The recipient cashes out at Ripio.`,
        ],
        ripio,
        schedule: currency === "LOCAL" ? scheduleLink(c, amount, every, recipient) : null,
      };
    }

    // Price at the right size. For a local amount, size the pool quote from
    // the maker's rate first, then re-derive dollars from the pool itself.
    const maker = c.ticker ? (await makerQuotes()).get(c.ticker) ?? null : null;
    const firstGuessRate = maker?.bid ?? maker?.last ?? null;
    let usd = currency === "USD" ? amount : firstGuessRate ? amount / firstGuessRate : 100;
    let pool = await poolQuote(c, Math.max(usd, 1));
    if (currency === "LOCAL" && pool) {
      usd = amount / pool.rate;
      pool = await poolQuote(c, Math.max(usd, 1));
    }

    const options = [
      pool && {
        venue: "uniswap-v3 (Celo)",
        rate: pool.rate,
        usdNeeded: round(currency === "USD" ? amount : amount / pool.rate, 2),
        localOut: round(currency === "USD" ? pool.out : amount, 2),
        impactBps: pool.impactBps,
        firm: "executes at the pool's price when you swap; set a slippage bound",
      },
      maker?.bid && {
        venue: "textile-rfq (Celo)",
        rate: maker.bid,
        usdNeeded: round(currency === "USD" ? amount : amount / maker.bid, 2),
        localOut: round(currency === "USD" ? amount * maker.bid : amount, 2),
        impactBps: null,
        firm: "indicative top of book; request a firm quote before trading (minimum $1)",
      },
    ].filter(Boolean) as Array<{ venue: string; rate: number; usdNeeded: number; localOut: number }>;
    // Best = most local currency per dollar at this size.
    options.sort((a, b) => b.rate - a.rate);
    const best = options[0] ?? null;

    const localAmount = currency === "LOCAL" ? amount : best ? best.localOut : null;
    const afterFee = localAmount !== null ? round(localAmount * (1 - REMESSO_FEE_BPS / 10_000), 2) : null;

    return {
      country: c.country,
      token: { symbol: c.symbol, address: c.address, decimals: c.decimals },
      onChainMarket: true,
      request: { amount, currency: currency === "USD" ? "USD" : c.currency, every },
      best,
      options,
      remessoFee: { bps: REMESSO_FEE_BPS, recipientReceives: afterFee, note: "taken from each scheduled payment, pinned at signing" },
      route: [
        best
          ? `Get ~${localAmount?.toLocaleString("en-US")} ${c.symbol}: ${
            best.venue.startsWith("uniswap")
              ? `swap ~$${best.usdNeeded} USDT in the Uniswap pool on Celo`
              : `trade ~$${best.usdNeeded} USDT with Textile's makers on Celo (request a firm quote first)`
          }, or buy with ${c.currency} at Ripio.`
          : `Buy ${c.symbol} with ${c.currency} at Ripio.`,
        `Create a Remesso schedule paying ${c.symbol} ${every === "month" ? "monthly" : `every ${every}`}; the recipient receives ${c.symbol} with no conversion.`,
        `The recipient cashes out ${c.symbol} to ${c.currency} at Ripio.`,
      ],
      ripio,
      schedule: localAmount ? scheduleLink(c, localAmount, every, recipient) : null,
    };
  },
} satisfies PaidService<In>;

servePaid(service);
