/// What Remesso is, in the form another program can read.
///
/// An agent that cannot be described cannot be called. This is the document a
/// caller needs before it does anything: who this agent is, what it will do,
/// what that costs, and — the part most capability docs leave out — what it
/// will refuse. The refusals are the interesting half, because they are the
/// reason a sender is willing to leave a mandate lying around for an agent to
/// draw on.
///
/// Public and unauthenticated (`verify_jwt = false`): a capability document
/// nobody can fetch without credentials is not discovery. It contains no
/// secret, quotes no sender, and names no schedule.
import { CELO, DIRECT_TOKENS, SELF_API } from "../_shared/config.ts";
import { ATTRIBUTION_CODE } from "../_shared/attribution.ts";
import { ASSETS, X402 } from "../_shared/x402.ts";
import { allowedDirectTokens, executorAccount, executorV4 } from "../_shared/celo.ts";
import { CNGN_RAILS_ENABLED } from "../_shared/rails.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const BASE = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");

/// The app a payer actually opens. Separate from BASE: the functions host
/// serves the API, the web origin serves the form a link has to land in.
const WEB = (Deno.env.get("WEB_ORIGIN") ?? "https://remesso.crackedstudios.xyz").replace(/\/+$/, "");

/// The address a payer grants. Undefined rather than a throw if the key is
/// missing: a capability document that 500s teaches a caller nothing.
function triggerAddress(): string | undefined {
  try {
    return executorAccount().address;
  } catch {
    return undefined;
  }
}

/// The payment block for a paid service, shaped exactly like the hand-written
/// ones above it: several currencies, one price, every asset 6dp.
function paid(amount: string) {
  return X402.isConfigured
    ? {
      protocol: "x402",
      version: 2,
      network: "celo",
      assets: ASSETS.map((a) => ({ symbol: a.symbol, address: a.address, eip712: { name: a.name, version: a.version } })),
      amount,
      decimals: 6,
      facilitator: X402.base,
      discover: "POST without a payment header: the price list is in the PAYMENT-REQUIRED header (v2) and the 402 body (v1)",
    }
    : { protocol: "none", note: "not configured to take payment" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  // What a payer can actually use, from the contract's allowlist — not every
  // asset we know how to handle. A token this document names but the contract
  // refuses is a schedule that reverts at signing, after an agent has built
  // for it. If the read fails, the three dollar stablecoins: allowed since
  // deploy, so the fallback can understate the list but never overstate it.
  const assets = (await allowedDirectTokens()) ??
    DIRECT_TOKENS.filter((t) => t.unitsPerUsd === 1);
  const symbols = assets.map((t) => t.symbol);

  return json({
    name: "Remesso",
    description:
      "Recurring stablecoin payments on Celo, bound by a mandate the payer signs " +
      "on-chain. Another agent can bring a payment forward; nothing can redirect, " +
      "resize or extend one.",

    // Identity, so a caller can check who they are dealing with rather than
    // trusting this document. The agent id is soulbound to a human who proved
    // themselves with a passport.
    identity: {
      /// ERC-8004, so an agent can find this one through the registry rather
      /// than because somebody handed over a URL. The metadata there is a
      /// `data:` URI inside the token: what was registered cannot be changed
      /// afterwards by whoever still controls a server.
      erc8004: {
        agentId: 9867,
        registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
        chainId: 42220,
      },
      selfAgentId: Deno.env.get("SELF_AGENT_ID") ?? "191",
      agentAddress: Deno.env.get("SELF_AGENT_ADDRESS") ??
        "0x5C3EBb0084233156ba51a5C2dfD42d88d5a74CA6",
      registry: "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944",
      proof: "self-agent-id",
      humanVerified: true,
    },

    chain: {
      network: "celo",
      chainId: CELO.chainId,
      executor: executorV4 || CELO.executor,
      /// The address a payer names as `trigger` if they want Remesso able to
      /// collect on their behalf — which is what makes `trigger-run` usable
      /// for their schedule at all.
      // Derived from the signing key, not configured: an address is public
      // and a second copy of it is a second thing to keep in step.
      trigger: triggerAddress(),
      attributionCode: ATTRIBUTION_CODE,
    },

    /// How to be paid, stated plainly because it is the half agents keep
    /// getting wrong. Receiving takes an address and nothing else — no gas,
    /// no balance, no account, no software, not even a call to us. The payer
    /// and the executor carry every cost, which is what makes an address a
    /// complete answer.
    receiving: {
      needs: ["an address on Celo"],
      doesNotNeed: ["gas", "a token balance", "an account with us", "our software"],
      assets: symbols,
      /// Four ways to get an address to a payer, easiest first. They differ
      /// only in who does the typing.
      howToHandOverYourAddress: [
        {
          how: "ask directly",
          what: `POST ${BASE}/functions/v1/request-payment`,
          detail: "free; returns a link and puts the request in the payer's app",
        },
        {
          how: "send a link",
          what: `${WEB}/schedules/new?to=0xYourAddress&amount=5&every=week`,
          detail: "opens their form already filled in; they review and sign",
        },
        {
          how: "tell them the address",
          what: "any channel you already use",
          detail: "they type it into the recipient field themselves",
        },
      ],
      /// The part no endpoint can do for you.
      thePayerDecides:
        "every route above ends with the payer signing createSchedule in their " +
        "own wallet. Nothing here obliges anyone to pay you.",
      verify:
        "read getSchedule(id) on the executor — the recipient, amount and cadence " +
        "are fixed there, and nobody can change them, including us",
    },

    services: [
      {
        name: "naira-rate",
        description:
          "Live USDT/NGN and USDC/NGN from on-chain RFQ makers: bid, ask and " +
          "last, with mid and spread when both sides are quoted and null for " +
          "both when they are not. What Remesso prices a naira corridor from.",
        endpoint: `${BASE}/functions/v1/rate-service`,
        method: "POST",
        input: {},
        payment: X402.isConfigured
          ? {
            protocol: "x402",
            // v2 on the wire (PAYMENT-REQUIRED header); v1 still accepted.
            version: 2,
            network: "celo",
            // Several currencies, one price: every accepted asset is 6dp.
            assets: ASSETS.map((a) => ({ symbol: a.symbol, address: a.address, eip712: { name: a.name, version: a.version } })),
            amount: Deno.env.get("RATE_SERVICE_PRICE_UNITS") ?? "1000",
            decimals: 6,
            facilitator: X402.base,
            discover: "POST without a payment header: the price list is in the PAYMENT-REQUIRED header (v2) and the 402 body (v1)",
          }
          : { protocol: "none", note: "not configured to take payment" },
        refusals: [
          "503 if the upstream rate feed is unreachable — you are not charged",
        ],
      },
      {
        name: "latam-rate",
        description:
          "Live USD-to-wARS and USD-to-wBRL on Celo from two independent on-chain " +
          "sources side by side — Textile's RFQ makers and the Uniswap pool at your " +
          "size — with a flag when they disagree. wCOP has no on-chain market on " +
          "Celo and is reported as such, never priced from elsewhere.",
        endpoint: `${BASE}/functions/v1/latam-rate`,
        method: "POST",
        input: { usd: "optional trade size to price the pool at (default 100, max 100000)" },
        payment: paid(Deno.env.get("LATAM_RATE_PRICE_UNITS") ?? "1000"),
        refusals: [
          "400 for an invalid size, before any price is quoted",
          "503 if the sources are unreachable — you are not charged",
        ],
      },
      {
        name: "latam-route",
        description:
          "How to deliver an amount of pesos or reais on Celo: the token, the " +
          "dollars it takes at your size and from which venue (with price impact), " +
          "Ripio's public buy and cash-out links and a prefilled Remesso schedule " +
          "link. Moves nothing and signs nothing. Argentina and Brazil are priced " +
          "on-chain; Colombia gets the Ripio route only.",
        endpoint: `${BASE}/functions/v1/latam-route`,
        method: "POST",
        input: {
          country: "AR | BR | CO",
          amount: "number, in local currency unless currency is USD",
          currency: "optional LOCAL (default) | USD",
          recipient: "optional 0x address to prefill",
          every: "optional week | fortnight | month (default month)",
        },
        payment: paid(Deno.env.get("LATAM_ROUTE_PRICE_UNITS") ?? "2000"),
        refusals: [
          "400 for an unknown country or a bad amount, before any price is quoted",
          "503 if the sources are unreachable — you are not charged",
        ],
      },
      {
        name: "capabilities",
        description: "This document. Free, because discovery that costs money is discovery nobody does.",
        endpoint: `${BASE}/functions/v1/agent`,
        method: "GET",
        payment: { protocol: "none" },
      },
      {
        name: "request-payment",
        description:
          "Ask a Remesso sender to pay you on a schedule. Free. Advisory only: " +
          "it prefills their form and returns a link — it cannot create a " +
          "schedule, approve an allowance or move a token. Only the payer can, " +
          "and only by signing in their own wallet.",
        endpoint: `${BASE}/functions/v1/request-payment`,
        method: "POST",
        input: {
          payer: "the wallet address you are asking",
          to: "the address you want paid",
          amount: "optional, e.g. \"5\"",
          token: `optional: ${symbols.join(", ")}`,
          every: "optional: week | fortnight | month | quarter",
          runs: "optional: how many payments",
          from: "optional: who is asking",
          note: "optional: why",
        },
        payment: { protocol: "none" },
        refusals: [
          "400 if either address is not a wallet address",
          "429 once a payer has 10 requests waiting — an inbox anyone can fill is an inbox nobody reads",
        ],
      },
      {
        name: "trigger-run",
        description:
          "Bring one payment of an existing schedule forward. The caller buys " +
          "timing and nothing else. Stablecoin payouts only: naira schedules " +
          "are refused before a price is quoted.",
        endpoint: `${BASE}/functions/v1/trigger-run`,
        method: "POST",
        input: { schedule: "on-chain schedule id, as a decimal string" },
        payment: X402.isConfigured
          ? {
            protocol: "x402",
            // v2 on the wire (PAYMENT-REQUIRED header); v1 still accepted.
            version: 2,
            network: "celo",
            // Several currencies, one price: every accepted asset is 6dp.
            // The address is the identity — USAT's 18dp fee adapter reports
            // the same symbol, and paying against it is a 10^12 error.
            assets: ASSETS.map((a) => ({ symbol: a.symbol, address: a.address, eip712: { name: a.name, version: a.version } })),
            amount: X402.priceUnits,
            decimals: 6,
            facilitator: X402.base,
            /// Unpaid calls answer 402 with the exact requirements, so a
            /// caller never has to take this document's word for the price.
            discover: "POST without a payment header: the price list is in the PAYMENT-REQUIRED header (v2) and the 402 body (v1)",
          }
          : { protocol: "none", note: "paid triggering is not configured" },
        refusals: [
          "403 if the schedule's payer did not grant this executor the right to collect",
          "403 once the granted collections are used up",
          "403 within 60 seconds of the previous collection",
          ...(CNGN_RAILS_ENABLED ? [] : [
            "403 for any schedule paying out in cNGN — naira payouts are switched off",
          ]),
          "409 if the payment itself reverts — the caller is not charged",
        ],
      },
    ],

    /// What a payer's mandate can never be made to do, whoever is asking.
    guarantees: [
      "The recipient is fixed when the payer signs and cannot be changed by anyone.",
      "The amount per payment is fixed at the same moment.",
      "A collection consumes one scheduled payment; it never adds one.",
      "Collections stop at the count the payer granted, and at their end date.",
      "The payer can withdraw the grant at any time, without our cooperation.",
      "Revoking the token allowance stops everything, also without our cooperation.",
    ],

    verification: {
      contract: `https://celoscan.io/address/${executorV4 || CELO.executor}`,
      source: "https://github.com/crackedstudio/Remesso",
      /// Anyone can read the mandate themselves instead of believing this.
      reads: {
        triggerability: "triggerability(uint256 id, address caller) view",
        schedule: "getSchedule(uint256 id) view",
      },
    },

    identityChecksAvailable: SELF_API.isConfigured,
  });
});

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      // A capability document changes rarely and is polled by machines.
      "Cache-Control": "public, max-age=300",
    },
  });
