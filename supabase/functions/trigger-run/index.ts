/// A paid endpoint that asks Remesso to send a payment now.
///
/// This is the part that makes Remesso callable rather than only watchable. An
/// app, a person or another agent pays a cent in USDC or USAT over x402 and one run of
/// a schedule fires ahead of its cadence. No account, no API key, no invoice —
/// the payment IS the authentication.
///
/// What it cannot do, and this is the whole design:
///   - it cannot choose the destination, the amount, the asset or the rate
///   - it cannot run a schedule whose sender did not nominate this executor as
///     its trigger, and did not authorise early sends
///   - it cannot exceed the run cap, the expiry, the floor, or the sender's
///     ERC20 allowance
///   - it cannot bring forward a naira payout while the cNGN rails are off
///
/// The caller is buying timing. Everything else was fixed when the sender
/// signed, and `runNow` re-checks all of it on-chain.
///
/// Order of operations: check, verify the payment, simulate the run, settle,
/// then run. Until 2026-10-16 it was verify -> run -> settle with no record of
/// the payment, and an unsettled signature can be replayed or cancelled — so
/// one authorisation bought any number of runs, each costing our hot key gas
/// (solidity-auditor scan 2026-10-16). Settling first consumes the payer's
/// EIP-3009 nonce on-chain; the simulation before it keeps "a run that would
/// revert charges nobody". What remains is a run that simulated cleanly and
/// then reverted in the seconds after settlement — logged loudly, and the
/// payer told they were charged. Until 2026-10-24 a run that reverted after
/// being mined was answered `ok: true`: the receipt's status was never read.
/// Now the answer comes from the receipt (`_shared/receipt.ts`).
///
/// The cron signs with the same key, so the run holds the executor lease
/// (`_shared/lease.ts`) from before settlement until its receipt. Taken before
/// settlement, so a busy key turns a caller away before anyone is charged.
import { createClient } from "npm:@supabase/supabase-js@2";
import { codesForRun } from "../_shared/builder-codes.ts";
import {
  broadcast,
  confirmRun,
  CURRENT_EXECUTOR,
  executorV4,
  feeOf,
  getSchedule,
  liquidityIsHealthy,
  type SignedRun,
  signRun,
  simulateRunNow,
  triggerability,
  v4Runnability,
} from "../_shared/celo.ts";
import { CELO, runAmountProblem } from "../_shared/config.ts";
import { type ExecutorLease, takeExecutorLease } from "../_shared/lease.ts";
import type { RunOutcome } from "../_shared/receipt.ts";
import { CNGN_RAILS_ENABLED, PAYOUT_DIRECT, RAIL_DISABLED_DETAIL } from "../_shared/rails.ts";
import {
  decodePayment,
  paymentRequired,
  requirements,
  settle,
  settlementHeaders,
  verify,
  X402,
  X402_CORS,
} from "../_shared/x402.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Without these an agent's browser-side client can neither discover the
  // price nor read the settlement.
  ...X402_CORS,
};

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

/// The executor lease is held through settlement and the receipt, so the TTL
/// covers both with room to spare; it expires by itself if this dies. A caller
/// waits at most `LEASE_WAIT_MS` for a cron run to finish with the key.
const LEASE_TTL_S = 120;
const LEASE_WAIT_MS = 20_000;
const CONFIRM_TIMEOUT_MS = 30_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (!X402.isConfigured || !executorV4) {
    return json({ error: "paid triggering is not available" }, 503);
  }

  let body: { schedule?: string | number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const raw = String(body.schedule ?? "");
  if (!/^\d{1,78}$/.test(raw)) return json({ error: "schedule must be an on-chain id" }, 400);
  const id = BigInt(raw);

  // The canonical, public URL of this endpoint. Not `req.url`: behind
  // Supabase's proxy that arrives as http:// and without the /functions/v1
  // prefix, and `resource` is part of what the payer signs — a payment scoped
  // to a URL that does not exist is a bad receipt and a worse audit trail.
  const resource = Deno.env.get("X402_RESOURCE_URL") ||
    `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1/trigger-run`;
  const accepts = requirements();
  const what = { url: resource, description: `Send schedule #${raw} now`, mimeType: "application/json" };

  // Ask the contract before charging anyone. A schedule nobody nominated this
  // executor for is a 402 that would always fail, so it is a 403 instead —
  // the caller should not pay to discover that.
  let canTrigger: boolean;
  let floor: bigint;
  let onchain: Awaited<ReturnType<typeof getSchedule>>;
  try {
    const [t, r, s] = await Promise.all([triggerability(id), v4Runnability(id), getSchedule(id)]);
    canTrigger = t.canTrigger;
    floor = r.floor;
    onchain = s;
  } catch (e) {
    console.error("trigger-run: chain read failed", (e as Error).message);
    return json({ error: "could not read the schedule" }, 502);
  }

  // A cNGN schedule is refused here, not priced. The contract would happily
  // run it — the rails are compiled in and immutable — so this endpoint is one
  // of only two places that can decline, and the rail is read from the chain
  // rather than from our mirror of it because a payer is about to spend money
  // on the answer.
  // An id nobody has created reads back as an all-zero struct, whose payout
  // type (0, Wallet) would otherwise be refused below as a naira schedule.
  if (/^0x0{40}$/i.test(onchain.sender)) {
    return json({ error: "no such schedule", detail: `schedule #${raw} does not exist on this contract` }, 404);
  }

  const payoutType = onchain.payoutType;
  if (!CNGN_RAILS_ENABLED && payoutType !== PAYOUT_DIRECT) {
    return json({ error: "this schedule cannot be triggered", detail: RAIL_DISABLED_DETAIL }, 403);
  }

  if (!canTrigger) {
    return json({
      error: "this schedule cannot be triggered",
      detail:
        "its sender has not authorised early sends for this executor, or none are left, " +
        "or the schedule is paused, expired, finished, or was triggered in the last minute",
      // V5: a sender grants Remesso by naming the CURRENT_EXECUTOR sentinel,
      // which follows key rotation. The executor's literal address is refused.
      trigger: CURRENT_EXECUTOR,
    }, 403);
  }

  // The backend's own limits, which the cron applies and this path skipped
  // until 2026-10-16: the sender signed the amount, but the per-run cap, the
  // dust minimum and the token table are ours to hold on every path that has
  // the hot key sign a run.
  const problem = runAmountProblem(onchain.token, onchain.amountIn);
  if (problem) return json({ error: "this schedule cannot be triggered", detail: problem }, 403);

  // The slippage bound. Direct converts nothing, so the floor (zero) is the
  // bound. A swap rail gets a live quote, as the cron does — handing the
  // contract the sender's floor as the bound let whoever bought the timing
  // trade around the swap down to it.
  let amountOutMinimum = floor;
  if (payoutType !== PAYOUT_DIRECT) {
    // The quoter prices USDT -> cNGN only. A schedule paying out in anything
    // else would get a bound for the wrong asset.
    if (onchain.tokenOut.toLowerCase() !== CELO.cngn.toLowerCase()) {
      return json({ error: "this schedule cannot be triggered", detail: "only cNGN swap payouts are priced" }, 403);
    }
    try {
      const health = await liquidityIsHealthy(onchain.amountIn - feeOf(onchain.amountIn, onchain.feeBps));
      if (!health.ok) {
        return json({ error: "the pool cannot fill this run right now", detail: `${health.impactBps}bps impact` }, 409);
      }
      if (health.quote.minOut > amountOutMinimum) amountOutMinimum = health.quote.minOut;
    } catch (e) {
      console.error("trigger-run: quote failed", (e as Error).message);
      return json({ error: "could not price the run" }, 502);
    }
  }

  // --- the 402 half ------------------------------------------------------
  const payment = decodePayment(req);
  if (!payment) {
    const q = paymentRequired(accepts, what);
    return json(q.body, 402, q.headers);
  }

  // Settlement must reuse the entry that verified — see `verify`.
  const check = await verify(payment, accepts, what);
  if (!check.ok || !check.matched) {
    const q = paymentRequired(accepts, what, check.reason ?? "payment invalid");
    return json(q.body, 402, q.headers);
  }

  // --- dry run -----------------------------------------------------------
  try {
    await simulateRunNow(id, amountOutMinimum);
  } catch (e) {
    // Nothing is settled, so nothing is charged. The contract's own revert is
    // the honest answer: it knows why better than this handler does.
    console.error("trigger-run: runNow would revert", raw, (e as Error).message);
    return json({ error: "the run would not go through", detail: (e as Error).message.slice(0, 200) }, 409);
  }

  // Whose codes the run carries besides ours, read before taking the key. A
  // schedule created a minute ago is found on the chain; nothing here fails a run.
  const builderCodes = await codesForRun(db, executorV4, id);

  // --- the executor key ----------------------------------------------------
  let lease: ExecutorLease | null = null;
  try {
    lease = await takeExecutorLease(db, "trigger-run", { ttlSec: LEASE_TTL_S, waitMs: LEASE_WAIT_MS });
  } catch (e) {
    console.error("trigger-run:", (e as Error).message);
  }
  if (!lease) {
    // Nothing is settled, so nothing is charged.
    return json(
      { error: "Remesso is busy sending another payment", detail: "nothing was charged; try again in a few seconds" },
      503,
      { "Retry-After": "5" },
    );
  }

  let minedNonce: number | undefined;
  try {
    // --- settlement ------------------------------------------------------
    // Before the run, so the signature is spent before anything is given for
    // it. A second request with the same payment fails here.
    const paid = await settle(payment, check.matched, what);
    if (!paid.ok) {
      const q = paymentRequired(accepts, what, "payment could not be settled");
      return json(q.body, 402, q.headers);
    }
    const charged = (status: number, body: Record<string, unknown>) =>
      json({ ...body, settlement: paid.txHash ?? null }, status, settlementHeaders(paid.txHash, check.version));

    // --- the work --------------------------------------------------------
    let signed: SignedRun;
    try {
      signed = await signRun("runNow", id, amountOutMinimum, lease.nonceFloor, builderCodes);
    } catch (e) {
      // Simulated cleanly seconds ago, paid for, and would revert now — the
      // schedule changed in between (a cancel, a cron run inside the minute).
      // Our failure to deliver what was bought: loud, and the payer is told.
      console.error("trigger-run: RUN FAILED after settlement", raw, paid.txHash, (e as Error).message);
      return charged(409, {
        error: "you were charged but the run did not go through",
        detail: (e as Error).message.slice(0, 200),
      });
    }

    try {
      await broadcast(signed);
    } catch (e) {
      // Maybe sent, maybe not; the receipt says which.
      console.error("trigger-run: broadcast failed", raw, signed.hash, (e as Error).message);
    }

    let outcome: RunOutcome;
    try {
      ({ outcome } = await confirmRun(signed.hash, id, { confirmations: 1, timeoutMs: CONFIRM_TIMEOUT_MS }));
    } catch {
      console.error("trigger-run: NO RECEIPT after settlement", raw, paid.txHash, signed.hash);
      return charged(504, {
        error: "you were charged, and the run's outcome is not confirmed yet",
        detail: "check txHash on Celo",
        txHash: signed.hash,
      });
    }
    minedNonce = signed.nonce;

    if (!outcome.ok) {
      console.error("trigger-run: RUN REVERTED after settlement", raw, paid.txHash, signed.hash);
      return charged(409, {
        error: "you were charged but the run did not go through",
        detail: outcome.reason,
        txHash: signed.hash,
      });
    }

    return new Response(JSON.stringify({ ok: true, schedule: raw, txHash: signed.hash, settled: true }), {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        ...settlementHeaders(paid.txHash, check.version),
      },
    });
  } finally {
    await lease.release(minedNonce);
  }
});

const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
