/// The chain's logs as `payment_events` rows, and where the indexer reads next.
///
/// Pure: `index-events` reads the chain and hands the results in, and
/// `events.test.ts` pins the rules. The table and why it exists are in
/// migration `20261025000001_payment_events.sql`.
import { type Hex, hexToBytes, parseAbi } from "npm:viem@2";

export const v5Events = parseAbi([
  "event RunExecuted(uint256 indexed id, address indexed sender, address indexed destination, uint128 amountIn, uint256 amountOut, uint32 runsExecuted, uint64 nextRunAt)",
  "event RunTriggered(uint256 indexed id, address indexed by, uint16 triggersLeft)",
  "event ScheduleCreated(uint256 indexed id, address indexed sender, address indexed destination, uint128 amountIn, uint64 interval, uint96 minRateE6, uint32 maxRuns, uint64 expiresAt, uint8 payoutType)",
]);

export const allowanceEvents = parseAbi([
  "event Paid(uint256 indexed id, address indexed to, uint256 amount, bytes32 memo)",
  "event PolicyCreated(uint256 indexed id, address indexed owner, address indexed agent, address token, uint128 perPayment, uint128 perDay, uint64 expiresAt, bool allowlistOnly)",
  "event PolicyRevoked(uint256 indexed id)",
]);

// ---- where to read next ----

export type Cursor = { block: bigint; hash: string | null };
export type Head = { block: bigint; hash: string };

export type Decision =
  | { action: "read"; from: bigint; to: bigint }
  | { action: "rollback"; to: Head }
  | { action: "wait" }
  | { action: "halt"; reason: string };

/// `hashAtCursor` is the chain's hash for the cursor's block now: undefined or
/// null when the node doesn't have that block yet. A reorg replaces a suffix of
/// the chain, so a changed hash at the cursor catches any reorg that reached a
/// block already read.
export function decideCursor(
  cursor: Cursor,
  hashAtCursor: string | null | undefined,
  head: bigint,
  finalized: Head,
  span: bigint,
): Decision {
  if (cursor.hash !== null) {
    // Behind a load balancer, this node can be behind the one we last read.
    if (hashAtCursor == null) return { action: "wait" };
    if (hashAtCursor.toLowerCase() !== cursor.hash.toLowerCase()) {
      if (cursor.block <= finalized.block) {
        return { action: "halt", reason: `block ${cursor.block} changed at or below the finalized block ${finalized.block}` };
      }
      // Everything above the finalized block is in doubt; it is read again.
      return { action: "rollback", to: finalized };
    }
  }
  if (cursor.block >= head) return { action: "wait" };
  const to = cursor.block + span < head ? cursor.block + span : head;
  return { action: "read", from: cursor.block + 1n, to };
}

// ---- logs into rows ----

/// A bytes32 memo as text, when it is printable ASCII padded with zero bytes:
/// how both agent wallets write a memo, and how a request's reference rides.
export function memoText(memo: Hex): string | null {
  const bytes = hexToBytes(memo);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  if (end === 0) return null;
  for (let i = 0; i < end; i++) if (bytes[i] < 0x20 || bytes[i] > 0x7e) return null;
  return String.fromCharCode(...bytes.slice(0, end));
}

/// What the recipient of a run receives: the funding token itself on the
/// Direct rail, the payout token on the swap rails.
export type ScheduleFacts = { token: string; tokenOut: string; payoutType: number; feeBps: number };
export type PolicyFacts = { owner: string; agent: string; token: string };
const DIRECT = 2;
const receivedToken = (s: ScheduleFacts) => (s.payoutType === DIRECT ? s.token : s.tokenOut);
/// V5's commission, rounded up, as the contract takes it.
const net = (amountIn: bigint, feeBps: number) => amountIn - (amountIn * BigInt(feeBps) + 9_999n) / 10_000n;

/// A decoded log; viem's getLogs output fits.
export type Log = {
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
};

/// One row as `record_payment_events` takes it. Big numbers travel as strings.
export type EventRow = {
  tx_hash: string;
  log_index: number;
  kind: "run" | "schedule_created" | "policy_payment" | "policy_created" | "policy_revoked";
  ref_id: string;
  from_address: string | null;
  to_address: string | null;
  agent: string | null;
  token: string | null;
  amount: string | null;
  amount_in: string | null;
  memo: string | null;
  memo_text: string | null;
  run_number: number | null;
  early: boolean | null;
  details: Record<string, unknown>;
  block_number: string;
  block_hash: string;
  block_time: string;
};

export type Facts = {
  /// Unix seconds per block number.
  blockTime: Map<bigint, number>;
  schedules: Map<string, ScheduleFacts>;
  policies: Map<string, PolicyFacts>;
};

/// Rows for a batch of logs. Throws when a fact is missing: a row recorded
/// without its token or payer would be a wrong answer kept forever, so the
/// batch waits for the next pass instead.
export function rowsFor(logs: Log[], facts: Facts): EventRow[] {
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`missing ${what}`);
    return v;
  };
  // A RunTriggered marks its schedule's RunExecuted in the same transaction as
  // an early send. It has no row of its own.
  const early = new Map<string, { by: string; triggersLeft: number }>();
  for (const l of logs) {
    if (l.eventName === "RunTriggered") {
      early.set(`${l.transactionHash}:${l.args.id}`, { by: String(l.args.by), triggersLeft: Number(l.args.triggersLeft) });
    }
  }

  const rows: EventRow[] = [];
  for (const l of logs) {
    const a = l.args;
    const id = a.id as bigint;
    const time = need(facts.blockTime.get(l.blockNumber), `the time of block ${l.blockNumber}`);
    const base = {
      tx_hash: l.transactionHash,
      log_index: l.logIndex,
      ref_id: id.toString(),
      block_number: l.blockNumber.toString(),
      block_hash: l.blockHash,
      block_time: new Date(time * 1000).toISOString(),
      memo: null,
      memo_text: null,
      run_number: null,
      early: null,
    };
    switch (l.eventName) {
      case "RunExecuted": {
        const s = need(facts.schedules.get(id.toString()), `schedule ${id}`);
        const t = early.get(`${l.transactionHash}:${id}`);
        rows.push({
          ...base,
          kind: "run",
          from_address: String(a.sender),
          to_address: String(a.destination),
          agent: null,
          token: receivedToken(s),
          amount: String(a.amountOut),
          amount_in: String(a.amountIn),
          run_number: Number(a.runsExecuted),
          early: Boolean(t),
          details: { nextRunAt: String(a.nextRunAt), ...(t ? { triggeredBy: t.by, triggersLeft: t.triggersLeft } : {}) },
        });
        break;
      }
      case "ScheduleCreated": {
        const s = need(facts.schedules.get(id.toString()), `schedule ${id}`);
        const amountIn = a.amountIn as bigint;
        rows.push({
          ...base,
          kind: "schedule_created",
          from_address: String(a.sender),
          to_address: String(a.destination),
          agent: null,
          token: receivedToken(s),
          // What each run will deliver, after the commission pinned at consent.
          amount: net(amountIn, s.feeBps).toString(),
          amount_in: amountIn.toString(),
          details: {
            interval: String(a.interval),
            maxRuns: Number(a.maxRuns),
            expiresAt: String(a.expiresAt),
            minRateE6: String(a.minRateE6),
            payoutType: Number(a.payoutType),
            feeBps: s.feeBps,
            fundingToken: s.token,
          },
        });
        break;
      }
      case "Paid": {
        const p = need(facts.policies.get(id.toString()), `policy ${id}`);
        rows.push({
          ...base,
          kind: "policy_payment",
          from_address: p.owner,
          to_address: String(a.to),
          agent: p.agent,
          token: p.token,
          amount: String(a.amount),
          amount_in: null,
          memo: String(a.memo),
          memo_text: memoText(a.memo as Hex),
          details: {},
        });
        break;
      }
      case "PolicyCreated":
        rows.push({
          ...base,
          kind: "policy_created",
          from_address: String(a.owner),
          to_address: null,
          agent: String(a.agent),
          token: String(a.token),
          amount: null,
          amount_in: null,
          details: {
            perPayment: String(a.perPayment),
            perDay: String(a.perDay),
            expiresAt: String(a.expiresAt),
            allowlistOnly: Boolean(a.allowlistOnly),
          },
        });
        break;
      case "PolicyRevoked": {
        const p = need(facts.policies.get(id.toString()), `policy ${id}`);
        rows.push({
          ...base,
          kind: "policy_revoked",
          from_address: p.owner,
          to_address: null,
          agent: p.agent,
          token: p.token,
          amount: null,
          amount_in: null,
          details: {},
        });
        break;
      }
    }
  }
  return rows;
}
