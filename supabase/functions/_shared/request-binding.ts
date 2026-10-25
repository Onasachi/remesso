/// Binding evidence to a payment request (docs/agent-to-agent.md, 3a).
///
/// A schedule or a payment answers a request only when it is evidence about
/// THIS request: from the wallet the request was sent to, paying the address
/// that asked, and made after the request. Matching the two wallets alone
/// would tie an old schedule, or an unrelated payment, to a new request. The
/// terms decide between `accepted` and `accepted_with_changes`, and never
/// whether the evidence binds: a payer who changed the amount still answered.
///
/// Amounts are compared with what the recipient receives: a request names
/// what is owed, and V5 takes its commission from the amount sent.
///
/// `judge` is pure and pinned by `request-binding.test.ts`. The rest reads the
/// database and the chain for `index-events`, `request-payment` and
/// `confirm-schedule`, which all bind the same way.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type Hex, parseAbi } from "npm:viem@2";
import { getSchedule, publicClient } from "./celo.ts";
import { DIRECT_TOKENS, directToken } from "./config.ts";
import { V5 } from "./deployments.ts";

export type RequestRow = {
  id: string;
  payer_address: string;
  to_address: string;
  amount: string | null;
  token_symbol: string | null;
  interval_seconds: number | null;
  max_runs: number | null;
  status: string;
  created_at: string;
  /// What already answers it, once it has been answered.
  bound_contract?: string | null;
  bound_schedule_id?: string | null;
  signed_terms?: Record<string, unknown> | null;
};

export type Evidence = {
  kind: "schedule" | "policy_payment";
  contract: string;
  scheduleId?: string;
  txHash?: string;
  from: string;
  to: string;
  token: string;
  /// What the recipient receives: per run for a schedule, once for a payment.
  amount: string;
  interval?: string | null;
  maxRuns?: number | null;
  /// When it was made: the block time of its ScheduleCreated or Paid event.
  at: string;
};

export type Judgement =
  | { ok: false; reason: string }
  | { ok: true; status: "accepted" | "accepted_with_changes"; terms: Record<string, unknown> };

/// A decimal amount in a token's base units, exactly. Null when it isn't a
/// plain decimal with at most `decimals` places.
export function toUnits(amount: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m || (m[2] ?? "").length > decimals) return null;
  return BigInt(m[1] + (m[2] ?? "").padEnd(decimals, "0"));
}

export function judge(r: RequestRow, e: Evidence): Judgement {
  if (e.from.toLowerCase() !== r.payer_address.toLowerCase()) {
    return { ok: false, reason: "it isn't from the wallet the request was sent to" };
  }
  if (e.to.toLowerCase() !== r.to_address.toLowerCase()) {
    return { ok: false, reason: "it doesn't pay the address that asked" };
  }
  if (Date.parse(e.at) <= Date.parse(r.created_at)) {
    return { ok: false, reason: "it was made before the request" };
  }

  const changed: string[] = [];
  const asked = r.token_symbol ? DIRECT_TOKENS.find((t) => t.symbol === r.token_symbol) : undefined;
  if (r.token_symbol && asked?.address.toLowerCase() !== e.token.toLowerCase()) changed.push("token");
  if (r.amount) {
    // With no token named, the amount is read in the token that was paid.
    const scale = asked ?? directToken(e.token);
    const units = scale ? toUnits(r.amount, scale.decimals) : null;
    if (units === null || units !== BigInt(e.amount)) changed.push("amount");
  }
  if (e.kind === "schedule") {
    if (r.interval_seconds && Number(e.interval) !== r.interval_seconds) changed.push("cadence");
    if (r.max_runs && e.maxRuns !== r.max_runs) changed.push("runs");
  }

  const terms: Record<string, unknown> = {
    token: e.token,
    amount: e.amount,
    ...(e.kind === "schedule" ? { intervalSeconds: Number(e.interval), runs: e.maxRuns ?? null } : {}),
    changed,
  };
  return { ok: true, status: changed.length ? "accepted_with_changes" : "accepted", terms };
}

// ---- evidence from the database and the chain ----

const createdEvent = parseAbi([
  "event ScheduleCreated(uint256 indexed id, address indexed sender, address indexed destination, uint128 amountIn, uint64 interval, uint96 minRateE6, uint32 maxRuns, uint64 expiresAt, uint8 payoutType)",
])[0];

/// A V5 schedule as evidence: from its indexed ScheduleCreated row, or, when
/// `index-events` hasn't reached it yet, from the chain. A schedule is
/// usually answered the moment it is created, so the last 5,000 blocks (forno's
/// getLogs limit, about 83 minutes) hold its event; an older one waits for the
/// indexer.
export async function scheduleEvidence(
  db: SupabaseClient,
  contract: string,
  scheduleId: string,
  chain: EvidenceChain = liveChain,
  waitMs = LIVE_WAIT_MS,
): Promise<Evidence | null> {
  const c = contract.toLowerCase();
  const { data } = await db
    .from("payment_events")
    .select("from_address, to_address, token, amount::text, details, block_time")
    .eq("kind", "schedule_created")
    .eq("contract", c)
    .eq("ref_id", scheduleId)
    .eq("removed", false)
    .maybeSingle();
  if (data) {
    return {
      kind: "schedule",
      contract: c,
      scheduleId,
      from: data.from_address,
      to: data.to_address,
      token: data.token,
      amount: data.amount,
      interval: data.details?.interval ?? null,
      maxRuns: data.details?.maxRuns ?? null,
      at: data.block_time,
    };
  }
  if (c !== V5.address) return null; // only the current executor is read live

  // The app and the SDK both answer a request seconds after the schedule is
  // mined, before the indexer has it. A node behind forno's load balancer can
  // then still answer from an earlier block: no log, or an empty schedule
  // (the SDK's first mainnet run, 2026-10-25, got this 409). So the chain is
  // asked a few times before the schedule counts as unseen, and an empty read
  // never becomes evidence: it would refuse the request as not from the payer.
  for (let attempt = 0; attempt < LIVE_TRIES; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, waitMs));
    try {
      const head = await chain.getBlockNumber();
      const logs = await chain.getLogs({
        address: V5.address,
        event: createdEvent,
        args: { id: BigInt(scheduleId) },
        fromBlock: head > 4_999n ? head - 4_999n : 0n,
        toBlock: head,
      });
      const log = logs[0];
      if (!log) continue;
      const [s, block] = await Promise.all([chain.getSchedule(BigInt(scheduleId)), chain.getBlock({ blockNumber: log.blockNumber })]);
      if (/^0x0{40}$/i.test(s.sender)) continue;
      const received = s.payoutType === 2 ? s.token : s.tokenOut;
      const net = s.amountIn - (s.amountIn * BigInt(s.feeBps) + 9_999n) / 10_000n;
      return {
        kind: "schedule",
        contract: c,
        scheduleId,
        from: s.sender.toLowerCase(),
        to: s.destination.toLowerCase(),
        token: received.toLowerCase(),
        amount: net.toString(),
        interval: s.interval.toString(),
        maxRuns: s.maxRuns,
        at: new Date(Number(block.timestamp) * 1000).toISOString(),
      };
    } catch (e) {
      // A node that hasn't reached the block answers with an error ("block is
      // out of range", block not found) rather than an empty result. The
      // second mainnet run hit that as a 500, so it is another try, not a
      // failure.
      console.warn(`scheduleEvidence: attempt ${attempt + 1} for schedule ${scheduleId} failed:`, (e as Error).message?.slice(0, 160));
    }
  }
  return null;
}

/// How often, and how far apart, the chain is asked about a schedule that
/// isn't indexed yet: about seven seconds in all.
const LIVE_TRIES = 4;
const LIVE_WAIT_MS = 2_500;

/// What `scheduleEvidence` reads from the chain: the live client, or a lagging
/// one in its test.
export type EvidenceChain = {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: { address: string; event: unknown; args: { id: bigint }; fromBlock: bigint; toBlock: bigint }): Promise<{ blockNumber: bigint }[]>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getSchedule(id: bigint): Promise<{
    sender: string; destination: string; token: string; tokenOut: string; payoutType: number;
    amountIn: bigint; feeBps: number; interval: bigint; maxRuns: number;
  }>;
};

const liveChain: EvidenceChain = {
  getBlockNumber: () => publicClient.getBlockNumber(),
  getLogs: (a) => publicClient.getLogs(a as never) as never,
  getBlock: (a) => publicClient.getBlock(a),
  getSchedule: (id) => getSchedule(id, { contract: V5.address }) as never,
};

const REQUEST_COLUMNS =
  "id, payer_address, to_address, amount, token_symbol, interval_seconds, max_runs, status, created_at, " +
  "bound_contract, bound_schedule_id::text, signed_terms";

export type AnswerResult =
  | { ok: true; status: "accepted" | "accepted_with_changes"; terms: Record<string, unknown> }
  | { ok: false; code: 400 | 404 | 409; reason: string };

/// Bind a V5 schedule to a request: what `request-payment`'s answer action
/// and `confirm-schedule` both do.
export async function answerWithSchedule(
  db: SupabaseClient,
  requestId: string,
  contract: string,
  scheduleId: string,
): Promise<AnswerResult> {
  const { data: r, error } = await db.from("payment_requests").select(REQUEST_COLUMNS).eq("id", requestId.toLowerCase()).maybeSingle();
  if (error) throw new Error(error.message);
  if (!r) return { ok: false, code: 404, reason: "no such request" };

  // Already answered by this same schedule: the first answer again, not a
  // refusal. A caller retrying after a lost response, or the app confirming
  // twice, would otherwise be told the request "isn't open".
  const row = r as unknown as RequestRow;
  if (
    (row.status === "accepted" || row.status === "accepted_with_changes") &&
    row.bound_contract === contract.toLowerCase() && row.bound_schedule_id === scheduleId
  ) {
    return { ok: true, status: row.status as "accepted" | "accepted_with_changes", terms: row.signed_terms ?? {} };
  }

  const e = await scheduleEvidence(db, contract, scheduleId);
  if (!e) return { ok: false, code: 409, reason: "that schedule hasn't been seen on-chain yet; try again in a minute" };
  const j = judge(row, e);
  if (!j.ok) return { ok: false, code: 409, reason: `that schedule can't answer this request: ${j.reason}` };
  return await bind(db, requestId, j, { contract: e.contract, scheduleId, txHash: null });
}

async function bind(
  db: SupabaseClient,
  requestId: string,
  j: Extract<Judgement, { ok: true }>,
  what: { contract: string; scheduleId: string | null; txHash: string | null },
): Promise<AnswerResult> {
  const { data, error } = await db.rpc("answer_payment_request", {
    p_id: requestId.toLowerCase(),
    p_status: j.status,
    p_contract: what.contract,
    p_schedule_id: what.scheduleId,
    p_tx_hash: what.txHash,
    p_terms: j.terms,
  });
  if (error) {
    if (error.code === "23505") return { ok: false, code: 409, reason: "that schedule or payment already answers another request" };
    throw new Error(error.message);
  }
  if (!data) return { ok: false, code: 409, reason: "the request isn't open: it was already answered, declined, or is over 30 days old" };
  return { ok: true, status: j.status, terms: j.terms };
}

/// Requests answered by a policy payment carrying their reference in the
/// memo. Called by `index-events` after each pass; returns how many it bound.
/// A candidate the rules refuse (paid from another wallet, say) is simply
/// left: it never binds, however often it is looked at.
export async function bindPolicyPayments(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc("policy_payment_answers", { p_limit: 100 });
  if (error) throw new Error(error.message);
  let bound = 0;
  for (const c of (data ?? []) as Record<string, string>[]) {
    const j = judge(c as unknown as RequestRow, {
      kind: "policy_payment",
      contract: c.contract,
      txHash: c.tx_hash,
      from: c.paid_from,
      to: c.paid_to,
      token: c.paid_token,
      amount: c.paid_amount,
      at: c.paid_at,
    });
    if (!j.ok) continue;
    const r = await bind(db, c.request_id, j, { contract: c.contract, scheduleId: null, txHash: c.tx_hash as Hex });
    if (r.ok) bound++;
  }
  return bound;
}
