/// Free reads of payment events by address (docs/agent-to-agent.md, 3b).
///
/// For a receiver that was down, an agent checking whether it was paid, or a
/// screen listing someone's policies. The events are what `index-events`
/// read from the chain; this only filters them. Public and unauthenticated,
/// like the other agent endpoints: it serves what anyone can read on-chain.
///
///   GET ?address=0x…        required
///       &role=to|from|agent|any   which side of the event the address is on (any)
///       &kind=run,policy_payment  run | schedule_created | policy_payment |
///                                 policy_created | policy_revoked (all)
///       &after=<seq>              the `next` of the previous page (0)
///       &limit=<1–500>            (100)
///
/// `seq` moves whenever an event changes: recorded, final, or removed by a
/// reorg. So a reader that passes back `next` sees every change, not only new
/// events, and an event it saw as not final comes round again once it is.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const KINDS = ["run", "schedule_created", "policy_payment", "policy_created", "policy_revoked"];
const ROLES = ["to", "from", "agent", "any"];

// Numbers wider than a double travel as text: an 18dp amount as a JSON number
// loses its last digits on the way.
const COLUMNS =
  "seq, chain_id, contract, kind, ref_id::text, from_address, to_address, agent, token, amount::text, amount_in::text, " +
  "memo, memo_text, run_number, early, details, tx_hash, log_index, block_number, block_hash, block_time, final, removed";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const q = new URL(req.url).searchParams;
  const address = (q.get("address") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return json({ error: "address must be a 0x address" }, 400);
  const role = q.get("role") ?? "any";
  if (!ROLES.includes(role)) return json({ error: `role must be one of ${ROLES.join(", ")}` }, 400);
  const kinds = q.get("kind") ? q.get("kind")!.split(",").map((k) => k.trim()) : [];
  const unknown = kinds.filter((k) => !KINDS.includes(k));
  if (unknown.length) return json({ error: `unknown kind: ${unknown.join(", ")}` }, 400);
  const after = Number(q.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return json({ error: "after must be a seq from a previous page" }, 400);
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 100) || 100, 1), 500);

  let query = db.from("payment_events").select(COLUMNS).gt("seq", after).order("seq").limit(limit);
  if (role === "any") query = query.or(`to_address.eq.${address},from_address.eq.${address},agent.eq.${address}`);
  else query = query.eq(role === "to" ? "to_address" : role === "from" ? "from_address" : "agent", address);
  if (kinds.length) query = query.in("kind", kinds);

  const { data, error } = await query;
  if (error) {
    console.error("payment-events:", error.message);
    return json({ error: "could not read events" }, 500);
  }
  const events = ((data ?? []) as unknown as Record<string, unknown>[]).map((e) => ({
    seq: e.seq,
    chainId: e.chain_id,
    contract: e.contract,
    kind: e.kind,
    refId: e.ref_id,
    from: e.from_address,
    to: e.to_address,
    agent: e.agent,
    token: e.token,
    amount: e.amount,
    amountIn: e.amount_in,
    memo: e.memo,
    memoText: e.memo_text,
    runNumber: e.run_number,
    early: e.early,
    details: e.details,
    txHash: e.tx_hash,
    logIndex: e.log_index,
    blockNumber: e.block_number,
    blockHash: e.block_hash,
    blockTime: e.block_time,
    final: e.final,
    removed: e.removed,
  }));
  return json({ events, next: events.length ? events[events.length - 1].seq : after });
});

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
