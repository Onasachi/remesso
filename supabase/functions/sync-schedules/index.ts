/// Mirror schedules created straight on the contract into this database.
///
/// `execute-due-runs` takes its work from `due_schedules`, which reads
/// Postgres. That was complete while the app was the only way to create a
/// schedule. It stopped being complete when an agent could call
/// `createSchedule` itself: the mandate is real, the allowance is real,
/// `runNow` moves it — and the cron has never heard of it, so its cadence
/// never fires. A valid schedule that silently never runs.
///
/// Found live on 2026-09-30 with schedule #7, created by an agent. It was paid
/// only because somebody paid `trigger-run` to pull it.
///
/// The chain stays the authority. This writes a mirror so the executor can
/// find the work; every value it acts on is still read from the contract at
/// run time, and a row here can no more move money than any other row.
///
/// Not from the subgraph, deliberately. `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL` is
/// a UI accelerant and an invariant says the money path must not read it — a
/// dead subgraph should mean a slower history, never a missed payment. This
/// reads the contract.
///
/// Scanning by id rather than by log range: `nextScheduleId` gives the upper
/// bound, the database gives what is already known, and the difference is a
/// handful of `getSchedule` calls with no checkpoint to keep, no block range
/// to page and no reorg to unwind. That is the right trade at a few hundred
/// schedules. Past that, index `ScheduleCreated` instead.
import { createClient } from "npm:@supabase/supabase-js@2";
import { CELO, runAmountProblem } from "../_shared/config.ts";
import { getSchedule, nextScheduleId } from "../_shared/celo.ts";
import { CNGN_RAILS_ENABLED, PAYOUT_DIRECT } from "../_shared/rails.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/// How many unknown schedules to adopt per invocation. A bound, not a target:
/// each one is an RPC read plus three inserts, and a tick that tries to do
/// five hundred of them times out halfway and leaves the work half done.
const BATCH = 25;

/// `sane_interval` on the schedules table. A schedule below it is valid
/// on-chain and cannot be mirrored, so it is reported rather than dropped
/// silently — a payment nobody can explain is worse than one nobody can run.
const MIN_INTERVAL = 300;

const PAYOUT_NAME = ["wallet", "ngn_bank", "direct"] as const;

/// How long a skipped id is left alone before it is read again.
const SKIP_RECHECK_MS = 24 * 60 * 60 * 1000;

/// Remember that `id` was looked at and not adopted, and why.
async function noteSkip(id: bigint, reason: string) {
  await db.from("schedule_sync_skips").upsert({
    executor_address: CELO.executor.toLowerCase(),
    onchain_id: String(id),
    reason: reason.slice(0, 200),
    checked_at: new Date().toISOString(),
  });
}

Deno.serve(async () => {
  if (!CELO.executor) return json({ error: "no executor configured" }, 500);

  let upper: bigint;
  try {
    upper = await nextScheduleId();
  } catch (e) {
    console.error("sync-schedules: chain read failed", (e as Error).message);
    return json({ error: "could not read the contract" }, 502);
  }

  // What we already hold for THIS contract. Ids are per-deployment, so a row
  // for another executor's #7 says nothing about this one's.
  const { data: known, error } = await db
    .from("schedules")
    .select("onchain_id")
    .ilike("executor_address", CELO.executor)
    .not("onchain_id", "is", null);
  if (error) return json({ error: error.message }, 500);

  const mirrored = new Set((known ?? []).map((r) => String(r.onchain_id)));

  // Ids skipped recently are not "missing", they are decided. Without this a
  // skipped id stays unmirrored forever and is re-read first on every tick, so
  // 25 of them — cheap to create — filled every batch and no new schedule was
  // ever found again (solidity-auditor scan 2026-10-16). Rechecked after a day,
  // because some reasons (the rails flag, the cap) can change.
  const { data: skips } = await db
    .from("schedule_sync_skips")
    .select("onchain_id")
    .eq("executor_address", CELO.executor.toLowerCase())
    .gt("checked_at", new Date(Date.now() - SKIP_RECHECK_MS).toISOString());
  for (const r of skips ?? []) mirrored.add(String(r.onchain_id));

  const missing: bigint[] = [];
  for (let i = 1n; i < upper && missing.length < BATCH; i++) {
    if (!mirrored.has(String(i))) missing.push(i);
  }
  if (!missing.length) return json({ scanned: Number(upper) - 1, adopted: 0, results: [] });

  const results: unknown[] = [];
  let adopted = 0;

  for (const id of missing) {
    try {
      const s = await getSchedule(id) as Onchain;

      // Only what can actually run. A cancelled or finished schedule is
      // history, and mirroring it would put a row in front of the executor
      // that it has to re-derive its way out of on every tick.
      if (s.cancelled || !s.active) {
        results.push({ id: String(id), skipped: "not active" });
        await noteSkip(id, "not active");
        continue;
      }
      if (s.expiresAt !== 0n && s.expiresAt * 1000n < BigInt(Date.now())) {
        results.push({ id: String(id), skipped: "expired" });
        await noteSkip(id, "expired");
        continue;
      }
      if (!CNGN_RAILS_ENABLED && s.payoutType !== PAYOUT_DIRECT) {
        // The same refusal execute-due-runs makes. Mirroring it would only
        // create a row that is skipped every minute from now on.
        results.push({ id: String(id), skipped: "cngn_rails_disabled" });
        await noteSkip(id, "cngn_rails_disabled");
        continue;
      }
      if (Number(s.interval) < MIN_INTERVAL) {
        results.push({ id: String(id), skipped: `interval ${s.interval}s below the ${MIN_INTERVAL}s floor` });
        await noteSkip(id, `interval ${s.interval}s below the ${MIN_INTERVAL}s floor`);
        continue;
      }

      // Too small to pay for its own gas, too large for the backend cap, or
      // in an asset we cannot scale: the cron refuses each of these, so a
      // mirrored row would only collect a failed run every backoff period.
      const problem = runAmountProblem(s.token, s.amountIn);
      if (problem) {
        results.push({ id: String(id), skipped: problem });
        await noteSkip(id, problem);
        continue;
      }

      const wallet = s.sender.toLowerCase();

      // The sender may be a wallet and nothing else. `auth_user_id` stays
      // null until somebody opens the app holding it, at which point
      // `claim_sender` adopts this row rather than making a second one.
      let senderId: string | undefined;
      const { data: existing } = await db
        .from("senders")
        .select("id")
        .eq("wallet_address", wallet)
        .maybeSingle();
      senderId = existing?.id;
      if (!senderId) {
        const { data: made, error: e1 } = await db
          .from("senders")
          .insert({ wallet_address: wallet })
          .select("id")
          .single();
        if (e1) throw new Error(`sender: ${e1.message}`);
        senderId = made.id;
      }

      // A name we can show before anyone has given us one. The sender never
      // typed a display name, so the address is the only honest label.
      const short = `${s.destination.slice(0, 6)}…${s.destination.slice(-4)}`;
      const { data: recipient, error: e2 } = await db
        .from("recipients")
        .insert({
          sender_id: senderId,
          display_name: short,
          payout_type: PAYOUT_NAME[s.payoutType] ?? "direct",
          wallet_address: s.destination,
        })
        .select("id")
        .single();
      if (e2) throw new Error(`recipient: ${e2.message}`);

      const { error: e3 } = await db.from("schedules").insert({
        sender_id: senderId,
        recipient_id: recipient.id,
        onchain_id: String(id),
        executor_address: CELO.executor,
        chain_id: CELO.chainId,
        amount_in: String(s.amountIn),
        interval_seconds: Number(s.interval),
        min_rate_e6: String(s.minRateE6),
        max_runs: Number(s.maxRuns),
        token_address: s.token,
        expires_at: s.expiresAt === 0n ? null : new Date(Number(s.expiresAt) * 1000).toISOString(),
        next_run_at: new Date(Number(s.nextRunAt) * 1000).toISOString(),
        status: "active",
        label: "Created on-chain",
      });
      // A duplicate means another invocation got there first, which is the
      // unique index doing its job rather than a failure.
      if (e3) throw new Error(`schedule: ${e3.message}`);

      adopted++;
      results.push({ id: String(id), adopted: true, sender: wallet, to: s.destination });
    } catch (e) {
      console.error(`sync-schedules: #${id}`, (e as Error).message);
      results.push({ id: String(id), error: (e as Error).message.slice(0, 200) });
    }
  }

  return json({ scanned: Number(upper) - 1, adopted, results });
});

type Onchain = {
  sender: string;
  interval: bigint;
  maxRuns: number;
  destination: string;
  nextRunAt: bigint;
  amountIn: bigint;
  minRateE6: bigint;
  expiresAt: bigint;
  payoutType: number;
  active: boolean;
  cancelled: boolean;
  token: string;
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
