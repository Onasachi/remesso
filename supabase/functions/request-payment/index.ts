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
///
/// The payer can answer too: `action: "decline"` with their own EIP-712
/// signature turns a request down for everyone (see `_shared/request-decline.ts`).
/// Hiding one in the app is per session and changes nothing here.
import { createClient } from "npm:@supabase/supabase-js@2";
import { getAddress, parseAbi } from "npm:viem@2";
import { publicClient } from "../_shared/celo.ts";
import { DIRECT_TOKENS } from "../_shared/config.ts";
import { ALLOWANCE, V5 } from "../_shared/deployments.ts";
import { answerWithSchedule } from "../_shared/request-binding.ts";
import {
  checkDecline,
  DECLINE_DOMAIN,
  DECLINE_TYPES,
  declineTypedData,
  MAX_DECLINE_TTL_SECS,
} from "../_shared/request-decline.ts";

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

/// How many live requests (pending, under 30 days old) one wallet may be shown
/// before we stop accepting more. Not rate limiting for its own sake: an inbox
/// somebody can fill with 500 rows is an inbox nobody opens, and the requests
/// that matter are lost among them. The cap protects the payer's attention,
/// which is the scarce thing here. `create_payment_request` applies it in the
/// same call as the insert, so requests sent together can't all get past it.
const MAX_PENDING_PER_PAYER = 10;

/// A policy on RemessoAgentAllowance, for checking an agent's decline.
const policyAbi = parseAbi([
  "function policy(uint256) view returns ((address owner, address agent, address token, uint64 expiresAt, bool allowlistOnly, bool revoked, uint128 perPayment, uint128 perDay, uint128 spentInWindow, uint64 windowStart))",
]);

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
      decline: {
        description:
          "The payer turns a request down for everyone by signing EIP-712 typed data " +
          "with the wallet the request was addressed to.",
        method: "POST",
        input: {
          action: "decline",
          id: "the request id",
          expiry: `unix seconds, in the future and at most ${MAX_DECLINE_TTL_SECS / 3600} hours ahead`,
          signature: "the payer's EIP-712 signature (ERC-1271 for a smart account)",
          agent: "optional: an agent signing for the payer, with a live RemessoAgentAllowance policy from them",
          policy_id: "optional, with agent: that policy's id",
        },
        typedData: {
          domain: DECLINE_DOMAIN,
          types: DECLINE_TYPES,
          primaryType: "PaymentRequestAction",
          message: { request: "<the request id>", action: "decline", expiry: "<unix seconds>" },
        },
      },
      list: {
        description: "The live requests addressed to a wallet: pending and under 30 days old. Each has a `reference` to put in a policy payment's memo.",
        method: "POST",
        input: { action: "list", payer: "the wallet address" },
      },
      status: {
        description:
          "Where a request stands (pending, accepted, accepted_with_changes, declined, expired) and its payments. " +
          "Accepted is not paid: only a payment with a transaction is, and that is what to check before releasing anything.",
        method: "POST",
        input: { action: "status", id: "the request id" },
      },
      answer: {
        description:
          "Report the V5 schedule that answers a request. It binds only if it is from the wallet asked, pays the address " +
          "that asked, was created after the request, and answers no other request. Changed terms read as accepted_with_changes. " +
          "A policy payment answers by carrying the request's reference in its memo instead.",
        method: "POST",
        input: { action: "answer", id: "the request id", schedule: "the on-chain schedule id", contract: `optional, default ${V5.address}` },
      },
    });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  if (body.action === "decline") return await decline(body);
  if (body.action === "list") return await list(body);
  if (body.action === "status") return await status(body);
  if (body.action === "answer") return await answer(body);
  if (body.action != null && body.action !== "request") {
    return json({ error: "action must be list, status, answer or decline, or left out to make a request" }, 400);
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

  const { data, error } = await db
    .rpc("create_payment_request", {
      p_payer: payer,
      p_to: to,
      p_amount: amount,
      p_token_symbol: token?.symbol ?? null,
      p_interval_seconds: intervalSeconds,
      p_max_runs: runs,
      p_from_name: fromName,
      p_note: note,
      p_max_live: MAX_PENDING_PER_PAYER,
    })
    .single<{ request_id: string | null; live: number }>();

  if (error || !data) {
    console.error("request-payment: insert failed", error?.message);
    return json({ error: "could not record the request" }, 500);
  }

  if (!data.request_id) {
    // 429, not 403: nothing is wrong with the request, there are simply too
    // many already waiting. Say which, so a caller can tell the difference
    // between "never" and "not yet".
    return json({
      error: "this wallet already has the maximum pending requests",
      pending: data.live,
      detail: "a request counts until the payer declines it or it is 30 days old",
    }, 429);
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
    id: data.request_id,
    link: `${WEB}/schedules/new?${q.toString()}`,
    status: "pending",
    detail: "the payer decides. Nothing is authorised until they sign.",
  }, 201);
});

/// The payer turns a request down, with a signature from the wallet it was
/// addressed to. The only way a request's status changes for everyone: the
/// app can't sign for a MiniPay payer, so its dismissal hides a request for
/// that session alone.
///
/// Checked in order of cost: the message's shape and expiry, then the row,
/// then the signature, which may need an `eth_call` for a smart account.
async function decline(body: Record<string, unknown>) {
  const c = checkDecline(body, Math.floor(Date.now() / 1000));
  if (!c.ok) return json({ error: c.error }, 400);
  const { id, expiry, signature } = c.decline;

  const { data: row, error } = await db
    .from("payment_requests")
    .select("id, payer_address, status")
    .eq("id", id.toLowerCase())
    .maybeSingle();
  if (error) return json({ error: "could not read the request" }, 500);
  if (!row) return json({ error: "no such request" }, 404);

  // The payer signs, or an agent the payer gave a live spending policy. An
  // agent holds a key where the person may not (MiniPay can't sign), and
  // declining is less than paying, which the payer already lets it do.
  let signer = getAddress(String(row.payer_address).toLowerCase());
  if (body.agent != null || body.policy_id != null) {
    const agent = String(body.agent ?? "");
    const policyId = String(body.policy_id ?? "");
    if (!isAddress(agent) || !/^\d{1,78}$/.test(policyId)) {
      return json({ error: "agent must be an address and policy_id a policy number" }, 400);
    }
    let p;
    try {
      p = await publicClient.readContract({ address: ALLOWANCE.address, abi: policyAbi, functionName: "policy", args: [BigInt(policyId)] });
    } catch (e) {
      console.error("request-payment: policy read failed", (e as Error).message);
      return json({ error: "could not read the policy" }, 502);
    }
    const live = !p.revoked && BigInt(Math.floor(Date.now() / 1000)) < p.expiresAt;
    if (!live || p.owner.toLowerCase() !== String(row.payer_address).toLowerCase() || p.agent.toLowerCase() !== agent.toLowerCase()) {
      return json({ error: "that policy doesn't let this agent act for the wallet the request was sent to" }, 401);
    }
    signer = getAddress(agent);
  }

  let valid: boolean;
  try {
    valid = await publicClient.verifyTypedData({ address: signer, ...declineTypedData(id, expiry), signature });
  } catch (e) {
    console.error("request-payment: decline signature check failed", (e as Error).message);
    return json({ error: "could not check the signature" }, 502);
  }
  if (!valid) return json({ error: "the signature is not from the wallet this request was sent to, or its agent" }, 401);

  // Declining twice is the same answer, not an error.
  if (row.status === "declined") return json({ ok: true, id: row.id, status: "declined" });
  if (row.status !== "pending") return json({ error: `this request is already ${row.status}` }, 409);

  const { error: upErr } = await db
    .from("payment_requests")
    .update({ status: "declined", responded_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "pending");
  if (upErr) {
    console.error("request-payment: decline failed", upErr.message);
    return json({ error: "could not record the decline" }, 500);
  }
  return json({ ok: true, id: row.id, status: "declined" });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_MS = 30 * 86_400_000;

/// The live requests addressed to a wallet: pending and under 30 days old,
/// the same definition the inbox and the cap use. Public, like the inbox:
/// they are invoices addressed to that wallet.
async function list(body: Record<string, unknown>) {
  const payer = String(body.payer ?? "");
  if (!isAddress(payer)) return json({ error: "payer must be a 0x address" }, 400);
  const { data, error } = await db
    .from("payment_requests")
    .select("id, reference, to_address, amount, token_symbol, interval_seconds, max_runs, from_name, note, status, created_at")
    .ilike("payer_address", payer)
    .eq("status", "pending")
    .gt("created_at", new Date(Date.now() - LIVE_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return json({ error: "could not read requests" }, 500);
  return json({
    requests: (data ?? []).map((r) => ({
      id: r.id,
      reference: r.reference,
      to: r.to_address,
      amount: r.amount,
      token: r.token_symbol,
      intervalSeconds: r.interval_seconds,
      runs: r.max_runs,
      from: r.from_name,
      note: r.note,
      status: r.status,
      createdAt: r.created_at,
    })),
  });
}

/// Where a request stands, and its payments: accepted is not paid. A
/// payment is `paid` only with a transaction from `payment_events`, which the
/// requester can check on-chain before releasing anything.
async function status(body: Record<string, unknown>) {
  const id = String(body.id ?? "");
  if (!UUID.test(id)) return json({ error: "id must be a payment request id" }, 400);
  const { data: r, error } = await db
    .from("payment_requests")
    .select(
      "id, reference, payer_address, to_address, amount, token_symbol, interval_seconds, max_runs, status, created_at, " +
        "bound_contract, bound_schedule_id::text, bound_tx_hash, signed_terms",
    )
    .eq("id", id.toLowerCase())
    .maybeSingle();
  if (error) return json({ error: "could not read the request" }, 500);
  if (!r) return json({ error: "no such request" }, 404);
  const row = r as unknown as Record<string, string | number | null | Record<string, unknown>>;

  const expired = row.status === "pending" && Date.parse(String(row.created_at)) < Date.now() - LIVE_MS;
  let payment = null;
  if (row.bound_schedule_id) {
    const { data: runs } = await db
      .from("payment_events")
      .select("tx_hash, amount::text, final, block_time")
      .eq("kind", "run")
      .eq("contract", row.bound_contract)
      .eq("ref_id", row.bound_schedule_id)
      .eq("removed", false)
      .order("seq");
    const txs = ((runs ?? []) as unknown as Record<string, unknown>[]).map((e) => ({
      txHash: e.tx_hash,
      amount: e.amount,
      final: e.final,
      blockTime: e.block_time,
    }));
    let state = txs.length ? "paid" : "scheduled";
    let reason: string | null = null;
    if (!txs.length) {
      // Nothing paid yet: the backend's own last attempt says whether it is
      // waiting for its date or failing. "Not due" is waiting.
      const attempt = await lastAttempt(String(row.bound_contract), String(row.bound_schedule_id));
      if (attempt && (attempt.status === "failed" || attempt.status === "skipped") && !/not due/i.test(attempt.failure_reason ?? "")) {
        state = "failed";
        reason = attempt.failure_reason;
      }
    }
    payment = { state, schedule: { contract: row.bound_contract, id: row.bound_schedule_id }, txs, reason };
  } else if (row.bound_tx_hash) {
    const { data: ev } = await db
      .from("payment_events")
      .select("tx_hash, amount::text, final, block_time")
      .eq("kind", "policy_payment")
      .eq("tx_hash", row.bound_tx_hash)
      .eq("removed", false)
      .maybeSingle();
    const e = ev as unknown as Record<string, unknown> | null;
    payment = {
      state: e ? "paid" : "scheduled",
      schedule: null,
      txs: e ? [{ txHash: e.tx_hash, amount: e.amount, final: e.final, blockTime: e.block_time }] : [],
      reason: null,
    };
  }

  return json({
    id: row.id,
    reference: row.reference,
    status: expired ? "expired" : row.status,
    // Who was asked: a paying agent checks this is its own human's wallet.
    payer: String(row.payer_address).toLowerCase(),
    requested: {
      to: row.to_address,
      amount: row.amount,
      token: row.token_symbol,
      intervalSeconds: row.interval_seconds,
      runs: row.max_runs,
    },
    signed: row.signed_terms ?? null,
    payment,
  });
}

/// The latest attempt the executor made at a schedule, from the `runs` table.
async function lastAttempt(contract: string, onchainId: string) {
  const { data: s } = await db
    .from("schedules")
    .select("id")
    .eq("onchain_id", onchainId)
    .ilike("executor_address", contract)
    .maybeSingle();
  if (!s) return null;
  const { data } = await db
    .from("runs")
    .select("status, failure_reason")
    .eq("schedule_id", s.id)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { status: string; failure_reason: string | null } | null;
}

/// Bind a V5 schedule to a request: the payer's app or agent reporting what
/// answered it. The evidence rules are in `_shared/request-binding.ts`.
async function answer(body: Record<string, unknown>) {
  const id = String(body.id ?? "");
  if (!UUID.test(id)) return json({ error: "id must be a payment request id" }, 400);
  const schedule = String(body.schedule ?? "");
  if (!/^\d{1,78}$/.test(schedule)) return json({ error: "schedule must be an on-chain schedule id" }, 400);
  const contract = body.contract == null ? V5.address : String(body.contract).toLowerCase();
  if (!isAddress(contract)) return json({ error: "contract must be a 0x address" }, 400);
  try {
    const r = await answerWithSchedule(db, id, contract, schedule);
    if (!r.ok) return json({ error: r.reason }, r.code);
    return json({ ok: true, id, status: r.status, signed: r.terms });
  } catch (e) {
    console.error("request-payment: answer failed", (e as Error).message);
    return json({ error: "could not record the answer" }, 500);
  }
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
