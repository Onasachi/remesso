/// How far behind the head do Celo's `safe` and `finalized` blocks run?
///
/// Phase 0 of the agent-to-agent plan (docs/agent-to-agent-implementation.md).
/// Phase 3 tells receivers whether a payment event is final, and that needs a
/// depth measured here. Celo is an OP Stack L2: `latest` is the sequencer's
/// head, `safe` is what has been derived from data posted to L1, `finalized`
/// is what L1 has finalised. How far each runs behind, and how much that
/// varies over a day, is what Phase 3's rule is picked from.
///
/// The cron calls this every minute (`remesso-measure-finality`) and a one-shot
/// job removes the cron after about 48 hours. `scripts/finality-report.ts`
/// reads the rows. Temporary, like the table it writes.
import { createClient } from "npm:@supabase/supabase-js@2";
import { CELO } from "../_shared/config.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TAGS = ["latest", "safe", "finalized"] as const;
type Tag = typeof TAGS[number];
type Head = { number: number; hash: string; time: string };
type Reply = {
  id: number;
  result?: { number: string; hash: string; timestamp: string } | null;
  error?: { message: string };
};

/// One batched request, so the three heads are read together rather than a
/// round trip apart: a second between reads is a second of lag that belongs
/// to us, not to the chain. viem's getBlock would take three requests.
async function heads(): Promise<Record<Tag, Head | null>> {
  const res = await fetch(CELO.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      TAGS.map((tag, id) => ({ jsonrpc: "2.0", id, method: "eth_getBlockByNumber", params: [tag, false] })),
    ),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`rpc answered ${res.status}`);
  const replies = await res.json() as Reply[];
  if (!Array.isArray(replies)) throw new Error("rpc did not answer the batch");

  const out: Record<Tag, Head | null> = { latest: null, safe: null, finalized: null };
  for (const r of replies) {
    const b = r.result;
    // A node that can't answer a tag returns an error or null for it; the row
    // keeps the other heads rather than losing the minute.
    if (!b || !TAGS[r.id]) continue;
    out[TAGS[r.id]] = {
      number: Number(BigInt(b.number)),
      hash: b.hash,
      time: new Date(Number(BigInt(b.timestamp)) * 1000).toISOString(),
    };
  }
  return out;
}

Deno.serve(async () => {
  let h: Record<Tag, Head | null>;
  try {
    h = await heads();
  } catch (e) {
    console.error("measure-finality: rpc failed", (e as Error).message);
    return json({ error: "rpc failed" }, 502);
  }
  const { latest, safe, finalized } = h;
  if (!latest) return json({ error: "no latest block" }, 502);

  const { error } = await db.from("finality_samples").insert({
    latest_number: latest.number,
    latest_hash: latest.hash,
    latest_time: latest.time,
    safe_number: safe?.number ?? null,
    safe_hash: safe?.hash ?? null,
    safe_time: safe?.time ?? null,
    finalized_number: finalized?.number ?? null,
    finalized_hash: finalized?.hash ?? null,
    finalized_time: finalized?.time ?? null,
  });
  if (error) return json({ error: error.message }, 500);

  return json({
    latest: latest.number,
    safe_behind: safe ? latest.number - safe.number : null,
    finalized_behind: finalized ? latest.number - finalized.number : null,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
