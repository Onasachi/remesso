/// The pre-flight agent. Every half hour, for every payment due in the next
/// day, it observes, decides, acts and verifies:
///
///   observe  the sender's balance and allowance on-chain, and for a peso or
///            real payment the rate now against its own reading a day ago;
///   decide   with `_shared/preflight.ts` — will the next payment be skipped,
///            will the one after, has a peso payment's dollar worth moved;
///   act      post a notice in the sender's app, with the fix attached;
///   verify   on every pass re-check, and resolve the notice itself once the
///            sender has fixed the problem.
///
/// It never touches the money path: no executeRun, no allowance, no schedule
/// change. A notice is advice to a human; the contract still decides whether a
/// payment goes, and `execute-due-runs` still makes it.
///
/// Rates are read directly (the same sources `latam-rate` sells), not bought
/// from our own x402 endpoint: paying ourselves would put circular payments on
/// the address x402 volume is credited by.

import { createClient } from "npm:@supabase/supabase-js@2";
import { CELO, directToken } from "../_shared/config.ts";
import { getSchedule, walletPosition } from "../_shared/celo.ts";
import { corridor, makerQuotes, poolQuote } from "../_shared/latam.ts";
import { decide, dollarValueMovePct, type Notice, type NoticeKind } from "../_shared/preflight.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

/// Look a little past a day ahead, so a daily payment is always in view at
/// least once before it is due, whatever the cron phase.
const HORIZON_SECS = 26 * 3600;
const ALL_KINDS: NoticeKind[] = ["balance_short", "allowance_short", "allowance_ending", "rate_moved"];

type Row = { id: string; sender_id: string; onchain_id: string | number; next_run_at: string | null };

/// `?dry=1`: observe and decide, write nothing — for testing against real
/// schedules and showing what the agent would do. A dry run may also look
/// further ahead (`&hours=200`); a live one never does, so a notice is never
/// raised about a payment a week away.
let DRY = false;

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  DRY = q.get("dry") === "1";
  const hours = DRY ? Math.min(Number(q.get("hours")) || 0, 24 * 31) : 0;
  const now = Date.now();
  const horizon = new Date(now + (hours ? hours * 3600 : HORIZON_SECS) * 1000).toISOString();

  const { data: rows, error } = await db
    .from("schedules")
    .select("id, sender_id, onchain_id, next_run_at")
    .eq("status", "active")
    .ilike("executor_address", CELO.executor)
    .not("onchain_id", "is", null)
    .lte("next_run_at", horizon)
    .limit(200);
  if (error) return json({ error: error.message }, 500);

  const rates = new Map<string, { now: number; movePct: number | null }>();
  const decisions: Array<Record<string, unknown>> = [];
  let opened = 0, updated = 0, resolved = 0;

  for (const r of (rows ?? []) as Row[]) {
    try {
      const s = await getSchedule(BigInt(r.onchain_id));
      const token = directToken(s.token);
      // Gone, finished or paused on-chain: nothing to warn about. Close
      // anything still open so the app does not show stale advice.
      const runsLeft = s.maxRuns === 0 ? null : s.maxRuns - s.runsExecuted;
      if (!token || s.cancelled || !s.active || runsLeft === 0) {
        if (!DRY) resolved += await settle(r, [], now);
        decisions.push({ schedule: String(r.onchain_id), observed: "not active on-chain", notices: [] });
        continue;
      }

      const { balance, allowance } = await walletPosition(s.token, s.sender);

      // A peso or real payment: its dollar worth now, and against a day ago.
      let rateMovePct: number | null = null;
      let usdNow: number | null = null;
      const c = corridor(token.symbol);
      if (c && c.poolFee !== null) {
        const rate = rates.get(c.currency) ?? (await readRate(c.currency));
        rates.set(c.currency, rate);
        rateMovePct = rate.movePct;
        usdNow = rate.now > 0 ? Number(s.amountIn) / 10 ** token.decimals / rate.now : null;
      }

      const notices = decide({
        amountIn: s.amountIn,
        balance,
        allowance,
        decimals: token.decimals,
        symbol: token.symbol,
        dueInSecs: Number(s.nextRunAt) - now / 1000,
        runsLeft,
        rateMovePct,
        usdNow,
      });
      const changed = DRY ? { opened: 0, updated: 0, resolved: 0 } : await apply(r, notices, now);
      opened += changed.opened;
      updated += changed.updated;
      resolved += changed.resolved;
      decisions.push({
        schedule: String(r.onchain_id),
        observed: { balance: balance.toString(), allowance: allowance.toString(), amountIn: s.amountIn.toString(), rateMovePct },
        notices: notices.map((n) => `${n.kind}:${n.severity}`),
      });
    } catch (e) {
      // One unreadable schedule must not stop the others; it is retried next pass.
      decisions.push({ schedule: String(r.onchain_id), error: (e as Error).message });
    }
  }

  return json({ dry: DRY, checked: rows?.length ?? 0, opened, updated, resolved, decisions });
});

/// The local-per-USD rate now (pool first, makers as fallback), recorded, and
/// the move in a payment's dollar value against the agent's own reading from
/// 20–30 hours ago. No earlier reading → no claim of a move.
async function readRate(currency: string): Promise<{ now: number; movePct: number | null }> {
  const c = corridor(currency)!;
  const pool = await poolQuote(c, 100);
  let now = pool?.rate ?? 0;
  let source = "uniswap-v3";
  if (!now && c.ticker) {
    const m = (await makerQuotes()).get(c.ticker);
    now = m?.bid ?? 0;
    source = "textile-rfq";
  }
  if (!now) return { now: 0, movePct: null };

  if (!DRY) await db.from("rate_snapshots").insert({ currency, local_per_usd: now, source });
  const { data } = await db
    .from("rate_snapshots")
    .select("local_per_usd, taken_at")
    .eq("currency", currency)
    .lte("taken_at", new Date(Date.now() - 20 * 3600 * 1000).toISOString())
    .gte("taken_at", new Date(Date.now() - 30 * 3600 * 1000).toISOString())
    .order("taken_at", { ascending: false })
    .limit(1);
  const before = data?.[0] ? Number(data[0].local_per_usd) : null;
  return { now, movePct: before ? dollarValueMovePct(before, now) : null };
}

/// Make the open notices for this schedule exactly `notices`: insert new ones,
/// refresh ones that still hold, resolve ones that no longer do.
async function apply(r: Row, notices: Notice[], now: number) {
  const { data: open } = await db
    .from("schedule_notices")
    .select("id, kind")
    .eq("schedule_id", r.id)
    .is("resolved_at", null);
  const openByKind = new Map((open ?? []).map((o: { id: string; kind: string }) => [o.kind, o.id]));
  let opened = 0, updated = 0;
  const stamp = new Date(now).toISOString();

  for (const n of notices) {
    const id = openByKind.get(n.kind);
    if (id) {
      await db.from("schedule_notices").update({ severity: n.severity, details: n.details, updated_at: stamp }).eq("id", id);
      updated++;
    } else {
      await db.from("schedule_notices").insert({ schedule_id: r.id, sender_id: r.sender_id, kind: n.kind, severity: n.severity, details: n.details });
      opened++;
    }
  }
  const keep = new Set(notices.map((n) => n.kind));
  const resolved = await settle(r, ALL_KINDS.filter((k) => !keep.has(k)), now, openByKind);
  return { opened, updated, resolved };
}

/// Resolve open notices of the given kinds (all kinds when `kinds` is empty
/// and `openByKind` is not given — the schedule is no longer running).
async function settle(r: Row, kinds: NoticeKind[], now: number, openByKind?: Map<string, string>): Promise<number> {
  const stamp = new Date(now).toISOString();
  if (!openByKind) {
    const { data } = await db.from("schedule_notices").update({ resolved_at: stamp }).eq("schedule_id", r.id).is("resolved_at", null).select("id");
    return data?.length ?? 0;
  }
  const ids = kinds.map((k) => openByKind.get(k)).filter(Boolean) as string[];
  if (!ids.length) return 0;
  await db.from("schedule_notices").update({ resolved_at: stamp }).in("id", ids);
  return ids.length;
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b, null, 2), { status, headers: { "content-type": "application/json" } });
