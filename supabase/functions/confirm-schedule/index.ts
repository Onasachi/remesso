/// Mirror a sender's own schedule from the chain, after they sign something.
///
/// The app used to write this itself: after `createSchedule` it set its row's
/// `onchain_id` and `status`, and after a pause, resume or cancel it set
/// `status`. Row-level security let it, because the row was the sender's — but
/// "the sender's" only ever meant "bound to this anonymous session", and
/// `claim_sender` binds a wallet to whoever asks (MiniPay cannot sign, so
/// nothing can prove ownership). So anybody could take a wallet's rows and:
///
///   - set a victim's schedules to `paused`, which `due_schedules` skips, and
///     the cadence silently stopped paying;
///   - write `onchain_id`s nobody had created yet, which the unique index then
///     refused to the real schedules — they were never mirrored, never run.
///
/// (solidity-auditor scan 2026-10-16.) Those columns are now written by the
/// service role only (migration 20261016000001), and this function is the one
/// way the app gets them written: it reads the transaction and the contract,
/// and the row says only what the chain says. A caller can at most ask for
/// the truth to be written sooner.
///
/// POST { schedule: <row uuid>, txHash?: <0x…>, request?: <payment request uuid> }
///   - a row with no `onchain_id` needs the `createSchedule` transaction. Its
///     ScheduleCreated event must come from the configured executor and name
///     the row's own sender, and the schedule must match the row's terms.
///   - a row with one is re-read from its own contract. `txHash`, if given,
///     pins the read to that transaction's block: forno can answer from a
///     block behind right after a write, and a status read then is stale.
///   - `request`, from a pay link's `req=`, binds the schedule to that payment
///     request (`_shared/request-binding.ts`).
import { createClient } from "npm:@supabase/supabase-js@2";
import { decodeEventLog, parseAbi } from "npm:viem@2";
import { CELO } from "../_shared/config.ts";
import { getSchedule, publicClient } from "../_shared/celo.ts";
import { answerWithSchedule } from "../_shared/request-binding.ts";
import { mirrorStatus } from "../_shared/schedule-status.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("WEB_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const createdAbi = parseAbi([
  "event ScheduleCreated(uint256 indexed id, address indexed sender, address indexed destination, uint128 amountIn, uint64 interval, uint96 minRateE6, uint32 maxRuns, uint64 expiresAt, uint8 payoutType)",
]);

type Row = {
  id: string;
  sender_id: string;
  onchain_id: string | null;
  executor_address: string | null;
  amount_in: string;
  interval_seconds: number;
  token_address: string | null;
  senders: { wallet_address: string } | { wallet_address: string }[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!CELO.executor) return json({ error: "no executor configured" }, 500);

  // The caller's own session reads the row, so row-level security decides
  // whether it is theirs; everything after that is written by the service.
  const user = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );

  let body: { schedule?: string; txHash?: string; request?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const rowId = String(body.schedule ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(rowId)) return json({ error: "schedule must be a row id" }, 400);
  const txHash = body.txHash ? String(body.txHash) : undefined;
  if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return json({ error: "txHash must be a transaction hash" }, 400);
  const requestId = body.request ? String(body.request) : undefined;
  if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return json({ error: "request must be a payment request id" }, 400);
  }

  const { data, error } = await user
    .from("schedules")
    .select("id, sender_id, onchain_id, executor_address, amount_in, interval_seconds, token_address, senders(wallet_address)")
    .eq("id", rowId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "no such schedule" }, 404);
  const row = data as unknown as Row;
  const sender = Array.isArray(row.senders) ? row.senders[0] : row.senders;
  const wallet = sender?.wallet_address?.toLowerCase();
  if (!wallet) return json({ error: "schedule has no sender wallet" }, 409);

  try {
    // The receipt, if one was named. Waited for briefly: the app calls this
    // right after its own wallet reported the transaction mined, and the RPC
    // behind us may be a block behind that.
    const receipt = txHash
      ? await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 30_000 })
      : undefined;
    if (receipt && receipt.status !== "success") return json({ error: "that transaction reverted" }, 409);

    if (row.onchain_id === null) {
      if (!receipt) return json({ error: "txHash is required to confirm a new schedule" }, 400);
      return await adopt(row, wallet, receipt, requestId);
    }

    // Already mirrored: refresh the status from the row's own contract.
    const contract = (row.executor_address ?? CELO.executor) as `0x${string}`;
    const s = await getSchedule(BigInt(row.onchain_id), { contract, blockNumber: receipt?.blockNumber });
    if (s.sender.toLowerCase() !== wallet) return json({ error: "that schedule is not this sender's" }, 403);
    const status = mirrorStatus(s);
    const { error: uErr } = await db.from("schedules").update({
      status,
      next_run_at: new Date(Number(s.nextRunAt) * 1000).toISOString(),
    }).eq("id", row.id);
    if (uErr) return json({ error: uErr.message }, 500);
    const request = await answerRequest(requestId, String(row.onchain_id), contract);
    return json({ ok: true, status, ...(request ? { request } : {}) });
  } catch (e) {
    console.error("confirm-schedule:", rowId, (e as Error).message);
    return json({ error: "could not read the chain", detail: (e as Error).message.slice(0, 200) }, 502);
  }
});

/// Bind a pending row to the schedule its `createSchedule` transaction made.
async function adopt(
  row: Row,
  wallet: string,
  receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>,
  requestId: string | undefined,
) {
  // The event from OUR contract only. Another contract can emit an event with
  // the same signature, and its "schedule id" means nothing here.
  let id: bigint | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CELO.executor.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: createdAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "ScheduleCreated" && ev.args.sender.toLowerCase() === wallet) {
        id = ev.args.id;
        break;
      }
    } catch {
      // Not a ScheduleCreated log.
    }
  }
  if (id === undefined) {
    return json({ error: "no schedule by this sender was created in that transaction" }, 409);
  }

  const s = await getSchedule(id, { blockNumber: receipt.blockNumber });
  // The row was written before signing, from the same form, so its terms must
  // be the schedule's. A mismatch means the row and the transaction are about
  // different things, and binding them would show one and run the other.
  if (
    s.amountIn !== BigInt(row.amount_in) ||
    Number(s.interval) !== Number(row.interval_seconds) ||
    (row.token_address && s.token.toLowerCase() !== row.token_address.toLowerCase())
  ) {
    return json({ error: "that schedule's terms do not match this row" }, 409);
  }

  const update = {
    onchain_id: String(id),
    executor_address: CELO.executor,
    authorized_tx_hash: receipt.transactionHash,
    status: mirrorStatus(s),
    next_run_at: new Date(Number(s.nextRunAt) * 1000).toISOString(),
    // The chain's copy of the terms, which the executor acts on anyway.
    min_rate_e6: String(s.minRateE6),
    max_runs: Number(s.maxRuns),
    expires_at: s.expiresAt === 0n ? null : new Date(Number(s.expiresAt) * 1000).toISOString(),
    token_address: s.token,
  };

  let { error } = await db.from("schedules").update(update).eq("id", row.id);
  if (error?.code === "23505") {
    // `sync-schedules` found the schedule on-chain first and made its own row.
    // Fold that one into this, the row with the sender's names on it — only if
    // sync made it (it never sets `authorized_tx_hash`), it is the same
    // sender's, and it has no run history to lose. A row the app confirmed is
    // never replaced: whoever confirms first keeps the id.
    const { data: other } = await db
      .from("schedules")
      .select("id, sender_id, recipient_id, authorized_tx_hash")
      .ilike("executor_address", CELO.executor)
      .eq("onchain_id", String(id))
      .maybeSingle();
    const { count } = other
      ? await db.from("runs").select("*", { count: "exact", head: true }).eq("schedule_id", other.id)
      : { count: null };
    if (!other || other.authorized_tx_hash || other.sender_id !== row.sender_id || (count ?? 1) > 0) {
      return json({ error: "this schedule is already mirrored to another row" }, 409);
    }
    await db.from("schedules").delete().eq("id", other.id);
    await db.from("recipients").delete().eq("id", other.recipient_id);
    ({ error } = await db.from("schedules").update(update).eq("id", row.id));
  }
  if (error) return json({ error: error.message }, 500);
  const request = await answerRequest(requestId, String(id), CELO.executor);
  return json({ ok: true, onchainId: String(id), status: update.status, ...(request ? { request } : {}) });
}

/// The request the form came from (`req=` in a pay link), bound to the
/// schedule by the same rules as request-payment's answer action. Its outcome
/// rides along: the schedule is confirmed either way.
async function answerRequest(requestId: string | undefined, onchainId: string, contract: string) {
  if (!requestId) return undefined;
  try {
    const r = await answerWithSchedule(db, requestId, contract, onchainId);
    return r.ok ? { status: r.status, signed: r.terms } : { error: r.reason };
  } catch (e) {
    console.error("confirm-schedule: answering request", requestId, (e as Error).message);
    return { error: "could not record the answer" };
  }
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
