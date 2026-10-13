/// "Please pay me." The one endpoint an agent that wants to RECEIVE needs.
///
/// Everything else here is about paying: an agent pays for a rate, pays to
/// pull a transfer forward, pays another agent. An agent that wants to be paid
/// had no move at all — its operator had to read a 42-character address to a
/// human who typed it into a phone, which is the worst possible way to move
/// the one value where a single wrong character loses the money.
///
/// So: POST an address and the terms you would like, get back a link. The
/// request appears in the payer's app, and the link opens the create form with
/// the fields already filled.
///
/// What this CANNOT do, which is the entire design:
///   - it cannot create a schedule
///   - it cannot approve an allowance or move a token
///   - it cannot tell the payer anything the payer must believe
///
/// It writes a row that prefills a form. The sender reads it, edits whatever
/// they like, and signs in their own wallet — and from that moment the
/// contract is the authority, as it is for every other payment.
///
/// Free, and unauthenticated. A fee here would be a toll on asking to be paid,
/// which is the wrong place to put one: the money is on the paying side.
/// `verify_jwt = false` for the same reason as the other agent endpoints —
/// callers have no Supabase JWT and should need no account.
import { createClient } from "npm:@supabase/supabase-js@2";
import { DIRECT_TOKENS } from "../_shared/config.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/// Where the link points. The app, not this function.
const WEB = (Deno.env.get("WEB_ORIGIN") ?? "https://remesso.crackedstudios.xyz").replace(/\/+$/, "");

/// Cadences the form can actually display. A request for a rhythm the picker
/// does not offer would arrive as a form the sender cannot read or change.
const CADENCE: Record<string, number> = {
  week: 7 * 86400,
  weekly: 7 * 86400,
  fortnight: 14 * 86400,
  fortnightly: 14 * 86400,
  month: 30 * 86400,
  monthly: 30 * 86400,
  quarter: 90 * 86400,
  quarterly: 90 * 86400,
};

/// How many pending requests one wallet may be shown before we stop accepting
/// more. Not rate limiting for its own sake: an inbox somebody can fill with
/// 500 rows is an inbox nobody opens, and the requests that matter are lost
/// among them. The cap protects the payer's attention, which is the scarce
/// thing here.
const MAX_PENDING_PER_PAYER = 10;

const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // Free description, like every other service here: an agent should be able
  // to learn how to ask without asking.
  if (req.method === "GET") {
    return json({
      name: "request-payment",
      description:
        "Ask a Remesso sender to set up a recurring payment to your address. " +
        "Advisory: it prefills their form. Only they can create the schedule.",
      method: "POST",
      input: {
        payer: "the wallet address you are asking (required)",
        to: "the address you want paid (required)",
        amount: "decimal, e.g. \"5\" (optional)",
        token: `one of ${DIRECT_TOKENS.map((t) => t.symbol).join(", ")} (optional)`,
        every: "week | fortnight | month | quarter (optional)",
        runs: "how many payments (optional)",
        from: "who is asking, max 40 chars (optional)",
        note: "why, max 120 chars (optional)",
      },
      returns: { id: "uuid", link: "a URL that opens their form prefilled" },
      payment: { protocol: "none", note: "free — the money is on the paying side" },
    });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const payer = String(body.payer ?? "");
  const to = String(body.to ?? "");
  // Both at once. Answering only about the first means a caller with two
  // typos learns about them one round trip at a time.
  const bad = [
    isAddress(payer) ? null : "payer",
    isAddress(to) ? null : "to",
  ].filter(Boolean);
  if (bad.length) {
    return json({ error: `${bad.join(" and ")} must be a wallet address`, invalid: bad }, 400);
  }

  const amount = body.amount == null ? null : String(body.amount).trim();
  if (amount !== null && !/^\d{1,12}(\.\d{1,18})?$/.test(amount)) {
    return json({ error: "amount must be a positive decimal" }, 400);
  }

  const symbol = body.token == null ? null : String(body.token).trim().toUpperCase();
  const token = symbol ? DIRECT_TOKENS.find((t) => t.symbol.toUpperCase() === symbol) : undefined;
  if (symbol && !token) {
    return json({ error: `token must be one of ${DIRECT_TOKENS.map((t) => t.symbol).join(", ")}` }, 400);
  }

  const every = body.every == null ? null : String(body.every).trim().toLowerCase();
  const intervalSeconds = every ? CADENCE[every] ?? null : null;
  if (every && !intervalSeconds) {
    return json({ error: "every must be week, fortnight, month or quarter" }, 400);
  }

  const runs = body.runs == null ? null : Number(body.runs);
  if (runs !== null && (!Number.isInteger(runs) || runs < 1 || runs > 9999)) {
    return json({ error: "runs must be a whole number of payments" }, 400);
  }

  const fromName = body.from == null ? null : String(body.from).trim().slice(0, 40) || null;
  const note = body.note == null ? null : String(body.note).trim().slice(0, 120) || null;

  const { count } = await db
    .from("payment_requests")
    .select("id", { count: "exact", head: true })
    .ilike("payer_address", payer)
    .eq("status", "pending");

  if ((count ?? 0) >= MAX_PENDING_PER_PAYER) {
    // 429, not 403: nothing is wrong with the request, there are simply too
    // many already waiting. Say which, so a caller can tell the difference
    // between "never" and "not yet".
    return json({
      error: "this wallet already has the maximum pending requests",
      pending: count,
      detail: "ask the payer to act on or dismiss the existing ones first",
    }, 429);
  }

  const { data, error } = await db
    .from("payment_requests")
    .insert({
      payer_address: payer,
      to_address: to,
      amount,
      token_symbol: token?.symbol ?? null,
      interval_seconds: intervalSeconds,
      max_runs: runs,
      from_name: fromName,
      note,
    })
    .select("id")
    .single();

  if (error) {
    console.error("request-payment: insert failed", error.message);
    return json({ error: "could not record the request" }, 500);
  }

  // The same link the app builds, returned so a caller can also send it
  // directly — by email, in a chat, however they already reach their payer.
  // A request that only exists inside our app is a request that waits for
  // somebody to open our app.
  const q = new URLSearchParams({ to });
  if (fromName) q.set("from", fromName);
  if (amount) q.set("amount", amount);
  if (token) q.set("token", token.symbol);
  if (every && intervalSeconds) q.set("every", every);
  if (runs) q.set("runs", String(runs));
  if (note) q.set("note", note);

  return json({
    ok: true,
    id: data.id,
    link: `${WEB}/schedules/new?${q.toString()}`,
    status: "pending",
    detail: "the payer decides. Nothing is authorised until they sign.",
  }, 201);
});

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
