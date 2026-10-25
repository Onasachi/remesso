/// Picks up schedules pg_cron says are due and executes them.
///
/// Ordering matters and is the whole point of this file:
///
///   wallet payout   quote -> sign executeRun -> save its hash -> broadcast
///                         -> receipt -> delivered
///   bank payout     quote -> redeemAsset (get deposit address)
///                         -> executeRun sending cNGN there
///                         -> redeeming -> [poll/webhook] -> paid_out
///
/// A bank run is NOT complete when the swap settles. It is complete when cNGN
/// says naira reached the account. Marking it earlier is the mistake that
/// tells a sender money arrived when it has not.
///
/// A run counts only from its receipt: `delivered` needs a successful receipt
/// holding this contract's `RunExecuted` for the schedule, and `amount_out` is
/// that event's, after the commission (`_shared/receipt.ts`). Until 2026-10-24
/// a reverted run could be recorded as delivered, at the quoted amount. The
/// hash is saved before the transaction is broadcast, so an invocation that
/// dies mid-run leaves something to look up, and each pass starts by settling
/// such rows from the chain (`_shared/recovery.ts`).
///
/// The work is split into two phases for throughput:
///
///   prepare   read-only and parallel — runnability, limits, liquidity, quote
///   settle    sequential — redeemAsset, then executeRun
///
/// Settling stays sequential because every run is signed by one executor EOA.
/// Broadcasting in parallel makes them all claim the same nonce and all but one
/// is rejected. `trigger-run` signs with the same key, so each run also holds
/// the executor lease (`_shared/lease.ts`) from its nonce to its receipt.
/// Batching them into a single transaction is the way past that, and it needs a
/// batcher contract set via setExecutor — see README.
import { createClient } from "npm:@supabase/supabase-js@2";
import type { Hex } from "npm:viem@2";
import { codesForRun } from "../_shared/builder-codes.ts";
import { CELO, requireEnv, runAmountProblem } from "../_shared/config.ts";
import {
  broadcast,
  confirmRun,
  feeOf,
  findOwnRunSince,
  getSchedule,
  isPaused,
  liquidityIsHealthy,
  lookupRunTx,
  runnability,
  signRun,
} from "../_shared/celo.ts";
import { assertCeloSupported, CngnError, redeemToBank } from "../_shared/cngn.ts";
import { takeExecutorLease } from "../_shared/lease.ts";
import { CNGN_RAILS_ENABLED } from "../_shared/rails.ts";
import { decide, type PayoutType } from "../_shared/recovery.ts";
import { mirrorStatus } from "../_shared/schedule-status.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/// Concurrent read-phase workers. Bounded because every one of them is issuing
/// RPC calls to the same Celo endpoint, and a burst gets throttled rather than
/// served faster.
const READ_CONCURRENCY = 8;

/// Stop starting new settlements past this point and hand the rest to the next
/// tick. Edge Functions have a wall clock, and a run killed mid-broadcast is
/// far worse than a run that waits a minute.
const SETTLE_DEADLINE_MS = 45_000;

/// Never claim more than one invocation can plausibly finish.
const BATCH = 20;

/// The executor lease: how long one run may hold it (from its nonce to its
/// receipt, seconds in practice; it expires by itself if this invocation
/// dies), and how long a run waits for `trigger-run` to finish with it.
const LEASE_TTL_S = 120;
const LEASE_WAIT_MS = 20_000;

/// After this the outcome is unknown and the row is left for recovery. Celo
/// makes a block a second, so a receipt normally arrives in two or three.
const CONFIRM_TIMEOUT_MS = 45_000;

/// A paid early send polls for the lease every 150ms. Taking it straight back
/// after each run would keep it out until the pass ends.
const YIELD_MS = 300;

/// A `pending` or `swapping` row older than this belonged to an invocation
/// that is over: a pass lasts a couple of minutes at most.
const STALE_MS = 10 * 60_000;

/// Stale rows settled per pass. A bound: each is a few chain reads.
const RECOVER_BATCH = 5;

type DueSchedule = {
  schedule_id: string;
  onchain_id: string;
  sender_id: string;
  amount_in: string;
  payout_type: "direct" | "wallet" | "ngn_bank";
  token_address: string | null;
};


type Prepared = {
  s: DueSchedule;
  runId: string;
  onchainId: bigint;
  quote: { amountOut: bigint; minOut: bigint; rateE6: bigint };
  /// The integrator's codes, carried after ours (`_shared/builder-codes.ts`).
  builderCodes: string[];
};

Deno.serve(async () => {
  const startedAt = Date.now();
  try {
    requireEnv();
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  // Rows an earlier invocation left in flight, before anything new is
  // claimed: until they settle, `due_schedules` won't offer their schedules.
  const recovered = await recoverStale();

  // Scoped to the contract this executor is configured with. Schedule ids are
  // per-contract and every deployment numbers from 1, so an unscoped query
  // would hand V4 a V3 row's id and run a different sender's schedule.
  const { data: due, error } = await db.rpc("due_schedules", {
    p_limit: BATCH,
    p_executor: CELO.executor,
  });
  if (error) return json({ error: error.message, recovered }, 500);

  let schedules = (due ?? []) as DueSchedule[];
  if (!schedules.length) return json({ processed: 0, recovered, results: [] });

  // Naira payouts are refused here rather than in the contract, which has all
  // three rails compiled in and cannot be changed. Refused BEFORE a `runs` row
  // exists: a run we will never attempt is not a failed run, and writing one
  // every tick would bury a sender's real history under a policy decision.
  // The schedule simply stays due, which is the truth — it is owed a payment
  // and we are declining to send it.
  const refused: unknown[] = [];
  if (!CNGN_RAILS_ENABLED) {
    const runnable = schedules.filter((s: DueSchedule) => s.payout_type === "direct");
    for (const s of schedules) {
      if (s.payout_type === "direct") continue;
      console.warn(`execute-due-runs: skipping ${s.payout_type} schedule ${s.onchain_id} — cNGN rails off`);
      refused.push({ schedule: s.onchain_id, skipped: "cngn_rails_disabled" });
    }
    schedules = runnable;
  }
  if (!schedules.length) return json({ processed: 0, recovered, results: refused });

  // The deployed contract's runnability() does not report paused state, so ask
  // directly. Without this, a pause turns every tick into a fresh cNGN
  // redemption opened for a run that cannot execute — the emergency lever
  // making the emergency worse. Security review 2026-09-14.
  if (await isPaused()) {
    return json({ processed: 0, paused: true, recovered, results: [] });
  }

  // One cached call per environment, not per run: confirm cNGN still lists Celo
  // as enabled before any bank payout is attempted. Wallet payouts touch no
  // cNGN API at all and must not be blocked by this.
  if (schedules.some((s: DueSchedule) => s.payout_type === "ngn_bank")) {
    try {
      await assertCeloSupported();
    } catch (e) {
      return json({ error: `cNGN preflight failed: ${(e as Error).message}` }, 503);
    }
  }

  const results: unknown[] = [...refused];

  // --- phase 1: parallel, read-only -----------------------------------------
  const prepared: Prepared[] = [];
  await mapWithConcurrency(schedules, READ_CONCURRENCY, async (s) => {
    const outcome = await prepare(s);
    if ("prepared" in outcome) prepared.push(outcome.prepared);
    else results.push(outcome.result);
  });

  // --- phase 2: sequential, one nonce at a time -----------------------------
  const deadline = startedAt + SETTLE_DEADLINE_MS;
  for (const [i, p] of prepared.entries()) {
    if (Date.now() > deadline) {
      // Release the claim rather than recording a failure. Nothing was
      // attempted, no redemption was opened, and a `skipped` row here would
      // feed the backoff in due_schedules and punish the schedule for our
      // scheduling, not its own state.
      await db.from("runs").delete().eq("id", p.runId);
      results.push({ schedule: p.s.schedule_id, status: "deferred" });
      continue;
    }
    results.push(await settle(p, deadline));
    if (i < prepared.length - 1) await new Promise((r) => setTimeout(r, YIELD_MS));
  }

  return json({ processed: results.length, ms: Date.now() - startedAt, recovered, results });
});

/// Read-only. Claims the run row, then decides whether this schedule can run at
/// all. Touches no external state beyond Celo reads.
async function prepare(
  s: DueSchedule,
): Promise<{ prepared: Prepared } | { result: unknown }> {
  const onchainId = BigInt(s.onchain_id);
  const amountIn = BigInt(s.amount_in);

  // Claim the attempt first. The unique (schedule_id, attempt) constraint is
  // the idempotency key: a duplicate cron tick loses the insert and exits.
  const { count } = await db
    .from("runs")
    .select("*", { count: "exact", head: true })
    .eq("schedule_id", s.schedule_id);

  const { data: run, error: claimErr } = await db
    .from("runs")
    .insert({
      schedule_id: s.schedule_id,
      sender_id: s.sender_id,
      attempt: (count ?? 0) + 1,
      amount_in: s.amount_in,
      status: "pending",
    })
    .select("id")
    .single();

  if (claimErr) return { result: { schedule: s.schedule_id, skipped: "already claimed" } };

  const fail = async (reason: string, status: "failed" | "skipped" = "failed") => {
    await db.from("runs").update({
      status,
      failure_reason: reason,
      settled_at: new Date().toISOString(),
    }).eq("id", run.id);
    return { result: { schedule: s.schedule_id, status, reason } };
  };

  try {
    // 1. Ask the contract, not the database. It is the authority.
    const [r, onchain, wallet] = await Promise.all([
      runnability(onchainId),
      getSchedule(onchainId),
      senderWallet(s.sender_id),
    ]);

    // The row must belong to the schedule's own sender. A mirror row is only
    // a pointer at an on-chain id, and until 2026-10-16 the app could write
    // `onchain_id` itself — so a row could name somebody else's schedule, or
    // squat an id before its real owner's row arrived. Running it would still
    // only pay what that sender signed, but under the wrong person's history.
    if (!wallet || onchain.sender.toLowerCase() !== wallet) {
      return await fail(`on-chain schedule ${onchainId} belongs to ${onchain.sender}, not this row's sender`);
    }

    if (!r.due) {
      // Distinguish "not yet" from "never again" — and a pause from both. The
      // contract flips `active` off for a pause AND for the final run, so the
      // run count tells them apart; see `mirrorStatus`.
      const status = mirrorStatus(onchain);
      if (status !== "active") {
        await db.from("schedules").update({ status }).eq("id", s.schedule_id);
        return await fail(`schedule is ${status} on-chain`, "skipped");
      }
      return await fail("not due on-chain", "skipped");
    }
    if (!r.funded) return await fail("sender funding wallet is short", "skipped");
    if (!r.approved) return await fail("sender allowance revoked or too low", "skipped");

    // 2. Backstop the on-chain envelope with our own ceiling and floor, at the
    //    funding asset's own scale and in its own currency. Read from the
    //    chain's copy of the schedule, not the mirror's.
    const problem = runAmountProblem(onchain.token, onchain.amountIn);
    if (problem) return await fail(problem);

    // Whose codes the run carries besides ours. Read here, in parallel and
    // outside the lease; it answers [] rather than failing a run.
    const builderCodes = await codesForRun(db, CELO.executor, onchainId);

    // 3. A Direct run converts nothing: same asset in and out. There is no
    //    price to quote, no pool to check and no floor to clear, so the whole
    //    market-facing half of a run simply does not apply.
    if (s.payout_type === "direct") {
      await db.from("runs").update({ status: "swapping" }).eq("id", run.id);
      return {
        prepared: {
          s,
          runId: run.id,
          onchainId,
          quote: { amountOut: amountIn, minOut: 0n, rateE6: 0n },
          builderCodes,
        },
      };
    }

    // One pool, ~$95k deep. Confirm it can still fill this before spending gas
    // — and reuse the quote it computed rather than asking twice. Quoted on
    // the NET amount: the contract takes its commission first and swaps what
    // is left, so a quote on the gross asked a bank redemption for naira the
    // swap would never produce.
    const net = onchain.amountIn - feeOf(onchain.amountIn, onchain.feeBps);
    const health = await liquidityIsHealthy(net);
    if (!health.ok) {
      return await fail(`pool impact ${health.impactBps}bps exceeds limit`, "skipped");
    }

    await db.from("runs").update({
      status: "swapping",
      quoted_rate_e6: health.quote.rateE6.toString(),
      min_out: health.quote.minOut.toString(),
    }).eq("id", run.id);

    return { prepared: { s, runId: run.id, onchainId, quote: health.quote, builderCodes } };
  } catch (e) {
    return await fail(describe(e));
  }
}

/// Moves money. Sequential by construction — see the note at the top of the
/// file about nonces.
async function settle(p: Prepared, deadline: number) {
  const { s, runId, onchainId, quote, builderCodes } = p;

  const fail = async (
    reason: string,
    status: "failed" | "skipped" = "failed",
    mined: { block_number?: number; gas_used?: string } = {},
  ) => {
    await db.from("runs").update({
      status,
      failure_reason: reason,
      settled_at: new Date().toISOString(),
      ...mined,
    }).eq("id", runId);
    return { schedule: s.schedule_id, status, reason };
  };

  // Taken before anything external happens, so a key busy with an early send
  // defers this run cleanly instead of leaving a redemption opened for a swap
  // that never went.
  let lease = null;
  try {
    lease = await takeExecutorLease(db, "execute-due-runs", {
      ttlSec: LEASE_TTL_S,
      waitMs: Math.max(0, Math.min(LEASE_WAIT_MS, deadline - Date.now())),
    });
  } catch (e) {
    console.error("execute-due-runs:", (e as Error).message);
  }
  if (!lease) {
    // Released, not failed: nothing was attempted. Same as the deadline path.
    await db.from("runs").delete().eq("id", runId);
    return { schedule: s.schedule_id, status: "deferred", reason: "executor key busy" };
  }

  let minedNonce: number | undefined;
  try {
    // 4. For a bank payout, open the redemption immediately before the swap, so
    //    the swap can deliver straight to the address cNGN gives us. This stays
    //    out of the parallel phase deliberately: a redemption opened for a run
    //    that then never executes is a dangling payout instruction.
    let cngnTrxRef: string | null = null;
    if (s.payout_type === "ngn_bank") {
      const recipient = await bankDetails(s.schedule_id);

      // cNGN is 6dp on Celo; redeemAsset takes whole naira and rejects anything
      // under 1. Truncating is deliberate — rounding up would ask cNGN to burn
      // cNGN the swap did not produce.
      const wholeNaira = Number(quote.amountOut / 1_000_000n);
      if (wholeNaira < 1) {
        return await fail(`swap output ${quote.amountOut} is below cNGN's 1 naira minimum`);
      }

      const redemption = await redeemToBank({
        amount: wholeNaira,
        bankCode: recipient.bank_code,
        accountNumber: recipient.account_number,
      });
      cngnTrxRef = redemption.trxRef;

      // The contract fixes `destination` at authorisation and cannot be steered
      // here. If cNGN hands back a different address, the swap would deliver
      // cNGN somewhere the redemption is not watching and the naira would never
      // arrive — so stop before spending gas.
      const dest = (await getSchedule(onchainId)).destination.toLowerCase();
      if (redemption.address.toLowerCase() !== dest) {
        return await fail(
          `cNGN redemption address ${redemption.address} does not match the ` +
            `sender-authorised destination ${dest}; the sender must re-authorise`,
        );
      }

      await db.from("runs").update({
        cngn_trx_ref: cngnTrxRef,
        cngn_deposit_address: redemption.address,
      }).eq("id", runId);
    }

    // 5. Execute. The contract re-checks every limit.
    const signed = await signRun("executeRun", onchainId, quote.minOut, lease.nonceFloor, builderCodes);

    // Saved before the broadcast. If this invocation dies from here on, the
    // recovery pass settles the row from this hash instead of guessing. A run
    // that can't be written down first isn't sent.
    const { error: saveErr } = await db.from("runs").update({
      tx_hash: signed.hash,
      token_address: s.token_address,
    }).eq("id", runId);
    if (saveErr) return await fail(`not sent: could not record the transaction first (${saveErr.message})`);

    try {
      await broadcast(signed);
    } catch (e) {
      // Maybe sent, maybe not; the receipt says which.
      console.error(`execute-due-runs: broadcast of ${signed.hash} failed`, (e as Error).message);
    }

    let confirmed;
    try {
      confirmed = await confirmRun(signed.hash, onchainId, { confirmations: 2, timeoutMs: CONFIRM_TIMEOUT_MS });
    } catch {
      // No receipt in time. The row stays `swapping` with its hash, and a
      // later pass settles it from the chain.
      return { schedule: s.schedule_id, status: "unconfirmed", hash: signed.hash };
    }
    const { receipt, outcome } = confirmed;
    // Mined, so the nonce is used, whether the run succeeded or reverted.
    minedNonce = signed.nonce;
    const mined = { block_number: Number(receipt.blockNumber), gas_used: receipt.gasUsed.toString() };

    if (!outcome.ok) return await fail(outcome.reason, "failed", mined);

    await db.from("runs").update({
      status: s.payout_type === "ngn_bank" ? "redeeming" : "delivered",
      ...mined,
      // What the recipient received, from the event: after the commission on
      // the Direct rail. The quote was what was sent.
      amount_out: outcome.run.amountOut.toString(),
      settled_at: s.payout_type === "ngn_bank" ? null : new Date().toISOString(),
    }).eq("id", runId);

    await refreshMirror(s.schedule_id, onchainId, outcome.run.nextRunAt, receipt.blockNumber);
    return { schedule: s.schedule_id, status: "ok", hash: signed.hash, awaitingPayout: !!cngnTrxRef };
  } catch (e) {
    return await fail(describe(e));
  } finally {
    await lease.release(minedNonce);
  }
}

/// The contract flips `active` false on the run that reaches `maxRuns`, and
/// nothing else notices. Without this the mirror keeps the schedule `active`
/// with a next_run_at that advances forever, the UI shows a finished schedule
/// as live, and every cycle writes another "not due" skipped row.
///
/// The next date comes from the run's own event. The status read is pinned to
/// the run's block when there is one: right after a receipt, forno can answer
/// from a block behind. A failed read here is logged and nothing more: the run
/// is already recorded and must not be undone by a mirror.
async function refreshMirror(scheduleId: string, onchainId: bigint, nextRunAt: bigint, atBlock?: bigint) {
  try {
    const onchain = await getSchedule(onchainId, atBlock ? { blockNumber: atBlock } : {});
    const status = mirrorStatus(onchain);
    await db.from("schedules").update({
      next_run_at: new Date(Number(nextRunAt) * 1000).toISOString(),
      ...(status !== "active" ? { status } : {}),
    }).eq("id", scheduleId);
  } catch (e) {
    console.error(`execute-due-runs: mirror refresh for ${scheduleId} failed`, (e as Error).message);
  }
}

type StaleRow = {
  id: string;
  schedule_id: string;
  tx_hash: string | null;
  started_at: string;
  schedules: Rel<{ onchain_id: string | number; recipients: Rel<{ payout_type: PayoutType }> }>;
};

/// supabase-js types an embedded relation as an array regardless of cardinality.
type Rel<T> = T | T[] | null;
const one = <T>(r: Rel<T>): T | null => (Array.isArray(r) ? r[0] ?? null : r);

/// Settle what a dead invocation left in flight (`_shared/recovery.ts`).
/// Errors are logged per row and never stop the pass: recovery is
/// housekeeping, and the due payments behind it matter more.
async function recoverStale(): Promise<unknown[]> {
  const { data, error } = await db
    .from("runs")
    .select("id, schedule_id, tx_hash, started_at, schedules!inner(onchain_id, executor_address, recipients(payout_type))")
    .in("status", ["pending", "swapping"])
    .lt("started_at", new Date(Date.now() - STALE_MS).toISOString())
    .ilike("schedules.executor_address", CELO.executor)
    .order("started_at")
    .limit(RECOVER_BATCH);
  if (error) {
    console.error("execute-due-runs: stale-run query failed", error.message);
    return [];
  }

  const out: unknown[] = [];
  for (const row of (data ?? []) as unknown as StaleRow[]) {
    try {
      const schedule = one(row.schedules);
      if (!schedule) continue;
      const onchainId = BigInt(schedule.onchain_id);
      const seen = row.tx_hash
        ? await lookupRunTx(row.tx_hash as Hex, onchainId)
        : await findOwnRunSince(onchainId, Date.parse(row.started_at));
      const d = decide(seen, one(schedule.recipients)?.payout_type ?? "direct");
      if (d.action === "wait") {
        out.push({ run: row.id, action: "wait" });
        continue;
      }

      const now = new Date().toISOString();
      const update = d.action === "settle"
        ? {
          status: d.status,
          tx_hash: d.hash,
          block_number: Number(d.blockNumber),
          gas_used: d.gasUsed.toString(),
          amount_out: d.amountOut.toString(),
          failure_reason: null,
          settled_at: d.status === "redeeming" ? null : now,
        }
        : {
          status: "failed",
          failure_reason: d.reason,
          settled_at: now,
          ...(d.hash ? { tx_hash: d.hash } : {}),
          ...(d.blockNumber !== undefined
            ? { block_number: Number(d.blockNumber), gas_used: String(d.gasUsed) }
            : {}),
        };
      // Only while still in flight, so two overlapping passes can't both
      // write it.
      await db.from("runs").update(update).eq("id", row.id).in("status", ["pending", "swapping"]);

      // Ten minutes on, the latest state is past the run: no block pin.
      if (seen.kind === "mined" && seen.outcome.ok) {
        await refreshMirror(row.schedule_id, onchainId, seen.outcome.run.nextRunAt);
      }
      out.push({ run: row.id, action: d.action, ...(d.action === "fail" ? { reason: d.reason } : { hash: d.hash }) });
    } catch (e) {
      console.error(`execute-due-runs: recovering run ${row.id} failed`, (e as Error).message);
    }
  }
  return out;
}

/// Run `fn` over `items` with at most `limit` in flight.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function describe(e: unknown): string {
  return e instanceof CngnError
    ? `cNGN ${e.status}: ${e.message}${e.retryable ? " (retryable)" : ""}`
    : (e as Error).message;
}

/// The wallet a sender row names, lowercased, or null.
async function senderWallet(senderId: string): Promise<string | null> {
  const { data } = await db.from("senders").select("wallet_address").eq("id", senderId).maybeSingle();
  return data?.wallet_address ? String(data.wallet_address).toLowerCase() : null;
}

async function bankDetails(scheduleId: string) {
  const { data, error } = await db
    .from("schedules")
    .select("recipients(bank_code, account_number, bank_verified_at)")
    .eq("id", scheduleId)
    .single();
  if (error) throw new Error(error.message);
  // supabase-js types an embedded relation as an array regardless of cardinality.
  type Bank = { bank_code: string; account_number: string; bank_verified_at: string | null };
  const rel = (data as unknown as { recipients: Bank | Bank[] }).recipients;
  const r = Array.isArray(rel) ? rel[0] : rel;
  if (!r) throw new Error("schedule has no recipient");
  if (!r.bank_verified_at) throw new Error("recipient bank account not verified");
  return r;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
