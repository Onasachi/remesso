/// Sends the webhooks: payments to an address, announced to the server its
/// owner subscribed (docs/agent-to-agent.md, 3c).
///
/// pg_cron calls this every minute (`remesso-deliver-webhooks`). Each pass
/// queues what changed in `payment_events` since every subscription's cursor,
/// then sends what is due, signed the Standard Webhooks way. A failed attempt
/// is retried with the same id for 24 hours, then held as failed until the
/// owner asks for a replay. Every request goes through `safe-fetch`: a
/// webhook URL is chosen by a stranger, and must never reach inside our
/// network.
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeFetch } from "../_shared/safe-fetch.ts";
import { runDeliveries } from "./worker.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

/// A receiver's answer is read only for its status, so it needn't be large.
const SEND_TIMEOUT_MS = 10_000;
const SEND_MAX_BYTES = 16 * 1024;

Deno.serve(async () => {
  try {
    const out = await runDeliveries(db, async (url, headers, body) => {
      const res = await safeFetch(url, { method: "POST", headers, body }, { timeoutMs: SEND_TIMEOUT_MS, maxBytes: SEND_MAX_BYTES });
      return { status: res.status };
    });
    return json(out);
  } catch (e) {
    console.error("deliver-webhooks:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
