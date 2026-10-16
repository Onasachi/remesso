/// Picks up schedules pg_cron says are due and executes them.
///
/// Ordering matters and is the whole point of this file:
///
///   wallet payout   quote -> simulate -> executeRun -> delivered
///   bank payout     quote -> redeemAsset (get deposit address)
///                         -> executeRun sending cNGN there
///                         -> redeeming -> [poll/webhook] -> paid_out
///
/// A bank run is NOT complete when the swap settles. It is complete when cNGN
/// says naira reached the account. Marking it earlier is the mistake that
/// tells a sender money arrived when it has not.
///
/// The work is split into two phases for throughput:
///
///   prepare   read-only and parallel — runnability, limits, liquidity, quote
///   settle    sequential — redeemAsset, then executeRun
///
/// Settling stays sequential because every run is signed by one executor EOA.
/// Broadcasting in parallel makes them all claim the same nonce and all but one
/// is rejected. Batching them into a single transaction is the way past that,
/// and it needs a batcher contract set via setExecutor — see README.
import { createClient } from "npm:@supabase/supabase-js@2";
import { CELO, requireEnv, runAmountProblem } from "../_shared/config.ts";
import {
  executeRun,
  feeOf,
  getSchedule,
  isPaused,
  liquidityIsHealthy,
  runnability,
} from "../_shared/celo.ts";
import { assertCeloSupported, CngnError, redeemToBank } from "../_shared/cngn.ts";
import { CNGN_RAILS_ENABLED } from "../_shared/rails.ts";
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
};

Deno.serve(async () => {
  const startedAt = Date.now();
  try {
    requireEnv();
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  // Scoped to the contract this executor is configured with. Schedule ids are
  // per-contract and every deployment numbers from 1, so an unscoped query
  // would hand V4 a V3 row's id and run a different sender's schedule.
  const { data: due, error } = await db.rpc("due_schedules", {
    p_limit: BATCH,
    p_executor: CELO.executor,
  });
  if (error) return json({ error: error.message }, 500);

  let schedules = (due ?? []) as DueSchedule[];
  if (!schedules.length) return json({ processed: 0, results: [] });

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
  if (!schedules.length) return json({ processed: 0, results: refused });

  // The deployed contract's runnability() does not report paused state, so ask
  // directly. Without this, a pause turns every tick into a fresh cNGN
  // redemption opened for a run that cannot execute — the emergency lever
  // making the emergency worse. Security review 2026-09-14.
  if (await isPaused()) {
    return json({ processed: 0, paused: true, results: [] });
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
  for (const p of prepared) {
    if (Date.now() > deadline) {
      // Release the claim rather than recording a failure. Nothing was
      // attempted, no redemption was opened, and a `skipped` row here would
      // feed the backoff in due_schedules and punish the schedule for our
      // scheduling, not its own state.
      await db.from("runs").delete().eq("id", p.runId);
      results.push({ schedule: p.s.schedule_id, status: "deferred" });
      continue;
    }
    results.push(await settle(p));
  }

  return json({ processed: results.length, ms: Date.now() - startedAt, results });
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

    return { prepared: { s, runId: run.id, onchainId, quote: health.quote } };
  } catch (e) {
    return await fail(describe(e));
  }
}

/// Moves money. Sequential by construction — see the note at the top of the
/// file about nonces.
async function settle(p: Prepared) {
  const { s, runId, onchainId, quote } = p;

  const fail = async (reason: string, status: "failed" | "skipped" = "failed") => {
    await db.from("runs").update({
      status,
      failure_reason: reason,
      settled_at: new Date().toISOString(),
    }).eq("id", runId);
    return { schedule: s.schedule_id, status, reason };
  };

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
    const { hash, receipt } = await executeRun(onchainId, quote.minOut);

    await db.from("runs").update({
      token_address: s.token_address,
      status: s.payout_type === "ngn_bank" ? "redeeming" : "delivered",
      tx_hash: hash,
      block_number: Number(receipt.blockNumber),
      gas_used: receipt.gasUsed.toString(),
      amount_out: quote.amountOut.toString(),
      settled_at: s.payout_type === "ngn_bank" ? null : new Date().toISOString(),
    }).eq("id", runId);

    // The contract flips `active` false on the run that reaches `maxRuns`, and
    // nothing else notices. Without this the mirror keeps the schedule `active`
    // with a next_run_at that advances forever, the UI shows a finished
    // schedule as live, and every cycle writes another "not due" skipped row.
    const [r, onchain] = await Promise.all([runnability(onchainId), getSchedule(onchainId)]);
    const status = mirrorStatus(onchain);
    await db.from("schedules").update({
      next_run_at: new Date(Number(r.nextRunAt) * 1000).toISOString(),
      ...(status !== "active" ? { status } : {}),
    }).eq("id", s.schedule_id);

    return { schedule: s.schedule_id, status: "ok", hash, awaitingPayout: !!cngnTrxRef };
  } catch (e) {
    return await fail(describe(e));
  }
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
