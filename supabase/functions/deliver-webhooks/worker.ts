/// One pass of webhook delivery: queue what changed since each subscription's
/// cursor, then send what is due. `index.ts` runs it from the cron with
/// `safe-fetch` as the sender; a local test can pass its own.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { signedHeaders } from "../_shared/standard-webhooks.ts";
import { type EventRow, nextAttempt, payloadFor, plan, type WebhookType } from "./plan.ts";

export type Send = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number }>;

/// Bounds per pass. A busy minute leaves the rest to the next one: cursors and
/// leases make a pass safe to stop anywhere.
const SUBSCRIPTIONS_PER_PASS = 100;
const EVENTS_PER_SUBSCRIPTION = 200;
const SENDS_PER_PASS = 50;
/// How long a claimed delivery is held from other passes while it is sent.
const LEASE_SECS = 120;

/// numeric(78,0) as text: see `EventRow`.
const EVENT_COLUMNS = "chain_id,tx_hash,log_index,contract,kind,ref_id::text,from_address,to_address,token," +
  "amount::text,amount_in::text,memo,memo_text,run_number,early,block_number,block_hash,block_time,final,removed,seq";

export async function runDeliveries(db: SupabaseClient, send: Send, deadline = Date.now() + 40_000) {
  const queued = await queueAll(db, deadline);
  const { delivered, retrying, failed } = await sendDue(db, send, deadline);
  return { queued, delivered, retrying, failed };
}

async function queueAll(db: SupabaseClient, deadline: number): Promise<number> {
  const { data: subs, error } = await db
    .from("webhook_subscriptions")
    .select("id, address, cursor_seq")
    .eq("state", "active")
    .order("updated_at")
    .limit(SUBSCRIPTIONS_PER_PASS);
  if (error) throw new Error(`webhook_subscriptions: ${error.message}`);
  let queued = 0;
  for (const s of subs ?? []) {
    if (Date.now() > deadline) break;
    try {
      queued += await queueOne(db, s as { id: string; address: string; cursor_seq: number });
    } catch (e) {
      // One subscription's trouble doesn't hold up the others.
      console.error(`deliver-webhooks: queueing for ${s.id} failed`, (e as Error).message);
    }
  }
  return queued;
}

async function queueOne(db: SupabaseClient, s: { id: string; address: string; cursor_seq: number }): Promise<number> {
  const { data, error } = await db
    .from("payment_events")
    .select(EVENT_COLUMNS)
    .eq("to_address", s.address)
    .in("kind", ["run", "policy_payment"])
    .gt("seq", s.cursor_seq)
    .order("seq")
    .limit(EVENTS_PER_SUBSCRIPTION);
  if (error) throw new Error(`payment_events: ${error.message}`);
  const events = (data ?? []) as unknown as EventRow[];
  if (!events.length) return 0;

  // A removal is only news to a subscription that heard about the event.
  const removed = events.filter((e) => e.removed);
  const known = removed.length ? await deliveriesFor(db, s.id, removed) : [];

  const now = new Date();
  const rows: Record<string, unknown>[] = [];
  const cancel: string[] = [];
  for (const e of events) {
    const mine = known.filter((d) => d.tx_hash === e.tx_hash && d.log_index === e.log_index && d.block_hash === e.block_hash);
    const p = plan(
      e,
      new Set(mine.filter((d) => d.delivered_at).map((d) => d.type)),
      mine.filter((d) => !d.delivered_at && !d.failed_at).map((d) => ({ id: d.id, type: d.type })),
    );
    cancel.push(...p.cancel);
    if (p.queue) {
      rows.push({
        chain_id: e.chain_id,
        tx_hash: e.tx_hash,
        log_index: e.log_index,
        block_hash: e.block_hash,
        type: p.queue,
        payload: payloadFor(e, p.queue, now),
      });
    }
  }

  const { data: n, error: qErr } = await db.rpc("queue_webhook_deliveries", {
    p_subscription: s.id,
    p_from_seq: s.cursor_seq,
    p_to_seq: events[events.length - 1].seq,
    p_rows: rows,
    p_cancel: cancel,
  });
  if (qErr) throw new Error(`queue_webhook_deliveries: ${qErr.message}`);
  return Number(n ?? 0);
}

type Known = {
  id: string;
  tx_hash: string;
  log_index: number;
  block_hash: string;
  type: WebhookType;
  delivered_at: string | null;
  failed_at: string | null;
};

async function deliveriesFor(db: SupabaseClient, subscription: string, events: EventRow[]): Promise<Known[]> {
  const { data, error } = await db
    .from("webhook_deliveries")
    .select("id, tx_hash, log_index, block_hash, type, delivered_at, failed_at")
    .eq("subscription_id", subscription)
    .in("tx_hash", [...new Set(events.map((e) => e.tx_hash))]);
  if (error) throw new Error(`webhook_deliveries: ${error.message}`);
  return (data ?? []) as Known[];
}

type Due = {
  id: string;
  url: string;
  secrets: string[] | null;
  payload: unknown;
  attempts: number;
  window_started_at: string;
};

async function sendDue(db: SupabaseClient, send: Send, deadline: number) {
  const { data, error } = await db.rpc("claim_webhook_deliveries", { p_limit: SENDS_PER_PASS, p_lease_seconds: LEASE_SECS });
  if (error) throw new Error(`claim_webhook_deliveries: ${error.message}`);
  let delivered = 0, retrying = 0, failed = 0;
  for (const d of (data ?? []) as Due[]) {
    // Past the deadline the lease simply runs out, and a later pass takes it.
    if (Date.now() > deadline) break;
    const body = JSON.stringify(d.payload);
    let ok = false;
    let problem = "";
    if (!d.secrets?.length) {
      problem = "no signing secret";
    } else {
      try {
        // A new timestamp and signature on every attempt; the id never changes.
        const headers = { "content-type": "application/json", ...(await signedHeaders(d.secrets, d.id, body)) };
        const res = await send(d.url, headers, body);
        ok = res.status >= 200 && res.status < 300;
        if (!ok) problem = `the endpoint answered ${res.status}`;
      } catch (e) {
        problem = (e as Error).message;
      }
    }
    const next = ok ? null : nextAttempt(d.attempts + 1, new Date(d.window_started_at), new Date());
    const { error: fErr } = await db.rpc("finish_webhook_delivery", {
      p_id: d.id,
      p_delivered: ok,
      p_next_attempt_at: next ? next.toISOString() : null,
      p_error: ok ? null : problem,
    });
    if (fErr) console.error(`deliver-webhooks: recording ${d.id} failed`, fErr.message);
    if (ok) delivered++;
    else if (next) retrying++;
    else failed++;
  }
  return { delivered, retrying, failed };
}
