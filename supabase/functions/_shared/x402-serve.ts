/// One paid endpoint, the way `rate-service` does it, so new services cannot
/// get the order wrong:
///
///   input checked → 402 quoted → payment verified → answer produced → settled
///   → answer released
///
/// - Bad input is a 400 BEFORE any price is quoted: nobody should pay to learn
///   their request could not be served.
/// - The answer is produced before settlement. If it fails, the caller gets a
///   503 and is not charged; a caller who paid and got nothing is worse than
///   one who got nothing and paid nothing.
/// - It is RELEASED only after settlement. An unsettled signature can be
///   replayed or cancelled, so an answer handed over first is free.
/// - Settlement reuses the exact entry that verified: the payer signed for one
///   asset, and settling another would ask the facilitator to move a token the
///   signature does not authorise.
///
/// `rate-service` and `trigger-run` predate this and follow the same order by hand.
import {
  ASSETS,
  decodePayment,
  paymentRequired,
  priced,
  requirements,
  settle,
  settlementHeaders,
  verify,
  X402,
  X402_CORS,
} from "./x402.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  ...X402_CORS,
};

export type PaidService<I> = {
  /// Path under /functions/v1.
  path: string;
  name: string;
  description: string;
  /// Base units, 6dp — the same number in every accepted asset.
  priceUnits: string;
  /// Shown free on GET, so discovery never costs money.
  input: Record<string, string>;
  /// Parse the POST body, or return the reason it cannot be served.
  parse: (body: unknown) => I | { error: string };
  /// The answer. Throwing means "unavailable": 503, not charged.
  serve: (input: I) => Promise<unknown>;
};

export function servePaid<I>(svc: PaidService<I>) {
  // The description rides in the base64 PAYMENT-REQUIRED header, and the
  // encoder takes Latin-1 only: one "→" in it and every paid request is a 500
  // (found locally 2026-10-11, before it shipped). Refuse at boot instead.
  if (/[^\x00-\xff]/.test(svc.description)) {
    throw new Error(`${svc.path}: description must be Latin-1 — it is sent in the 402 header`);
  }
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const resource = `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1/${svc.path}`;

    if (req.method === "GET") {
      return json({
        name: svc.name,
        description: svc.description,
        input: svc.input,
        price: {
          amount: svc.priceUnits,
          decimals: 6,
          assets: ASSETS.map((a) => ({ symbol: a.symbol, address: a.address })),
          protocol: "x402",
          network: "celo",
        },
        call: "POST with a PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) header; POST without one to see the 402.",
      });
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!X402.isConfigured) return json({ error: "this service is not configured to take payment" }, 503);

    const raw = await req.text();
    let body: unknown = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
    }
    const input = svc.parse(body);
    if (input && typeof input === "object" && "error" in input) {
      return json({ error: (input as { error: string }).error, input: svc.input }, 400);
    }

    const accepts = priced(requirements(), svc.priceUnits);
    const what = { url: resource, description: svc.description, mimeType: "application/json" };

    const payment = decodePayment(req);
    if (!payment) {
      const q = paymentRequired(accepts, what);
      return json(q.body, 402, q.headers);
    }

    const check = await verify(payment, accepts, what);
    if (!check.ok || !check.matched) {
      const q = paymentRequired(accepts, what, check.reason ?? "payment invalid");
      return json(q.body, 402, q.headers);
    }

    let answer: unknown;
    try {
      answer = await svc.serve(input as I);
    } catch (e) {
      console.error(`${svc.path}: unavailable`, (e as Error).message);
      return json({ error: "unavailable right now — you were not charged" }, 503);
    }

    // The answer is produced first and released only once settlement lands.
    // Settling consumes the payer's EIP-3009 nonce on-chain; handing the
    // answer over before that let one signature be replayed, or cancelled,
    // for free answers (solidity-auditor scan 2026-10-16).
    const paid = await settle(payment, check.matched, what);
    if (!paid.ok) {
      console.error(`${svc.path}: settlement failed; answer withheld`, check.payer);
      const q = paymentRequired(accepts, what, "payment could not be settled");
      return json(q.body, 402, q.headers);
    }

    return new Response(
      JSON.stringify({ ...(answer as object), asOf: new Date().toISOString(), payer: check.payer ?? null }, null, 2),
      {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json", ...settlementHeaders(paid.txHash, check.version) },
      },
    );
  });
}

const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
