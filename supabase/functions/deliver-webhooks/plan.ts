/// What a subscription is told about a payment event, what that message says,
/// and when a failed attempt is tried again. Pure, so `plan.test.ts` pins
/// every rule; `worker.ts` does the reading and the sending.

/// A `payment_events` row as the worker selects it: amounts and ids as text,
/// because PostgREST sends numeric(78,0) as a JSON number and an 18-decimal
/// amount loses its digits on the way.
export type EventRow = {
  chain_id: number;
  tx_hash: string;
  log_index: number;
  contract: string;
  kind: "run" | "policy_payment";
  ref_id: string;
  from_address: string | null;
  to_address: string | null;
  token: string | null;
  amount: string | null;
  amount_in: string | null;
  memo: string | null;
  memo_text: string | null;
  run_number: number | null;
  early: boolean | null;
  block_number: number;
  block_hash: string;
  block_time: string;
  final: boolean;
  removed: boolean;
  seq: number;
};

export type WebhookType = "payment.received" | "payment.finalized" | "payment.removed";

/// The deliveries one change to an event calls for.
///
/// - Seen, not final yet: payment.received. Sent at once, so a receiver hears
///   within a minute; the payload says it isn't final.
/// - Final: payment.finalized. An event first seen already final gets only
///   this one.
/// - Removed by a reorg: payment.removed, but only to a subscription that was
///   actually told about it. Anything still waiting about it is cancelled.
///
/// `sent` holds the types already delivered for this event, in this block, to
/// this subscription; `waiting` those queued and not yet sent.
export function plan(
  e: Pick<EventRow, "final" | "removed">,
  sent: ReadonlySet<WebhookType>,
  waiting: ReadonlyArray<{ id: string; type: WebhookType }>,
): { queue: WebhookType | null; cancel: string[] } {
  if (e.removed) {
    return {
      queue: sent.size ? "payment.removed" : null,
      cancel: waiting.filter((w) => w.type !== "payment.removed").map((w) => w.id),
    };
  }
  return { queue: e.final ? "payment.finalized" : "payment.received", cancel: [] };
}

/// What a receiver gets. Amounts are base units as strings, after the fee.
export type WebhookPayload = {
  type: WebhookType;
  timestamp: string;
  data: {
    chainId: number;
    contract: string;
    schedule?: string;
    policy?: string;
    from: string | null;
    to: string | null;
    token: string | null;
    amount: string | null;
    amountIn?: string | null;
    runNumber?: number | null;
    early?: boolean;
    memo?: string | null;
    memoText?: string | null;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    blockTime: string;
    final: boolean;
    removed: boolean;
  };
};

/// The message body, fixed when queued so every attempt sends the same bytes.
/// Standard Webhooks shape: `{ type, timestamp, data }`. A receiver about to
/// release goods should still check the transaction itself.
export function payloadFor(e: EventRow, type: WebhookType, queuedAt: Date): WebhookPayload {
  const run = e.kind === "run";
  return {
    type,
    timestamp: queuedAt.toISOString(),
    data: {
      chainId: e.chain_id,
      contract: e.contract,
      ...(run ? { schedule: e.ref_id } : { policy: e.ref_id }),
      from: e.from_address,
      to: e.to_address,
      token: e.token,
      amount: e.amount,
      ...(run
        ? { amountIn: e.amount_in, runNumber: e.run_number, early: e.early ?? false }
        : { memo: e.memo, memoText: e.memo_text }),
      txHash: e.tx_hash,
      logIndex: e.log_index,
      blockNumber: e.block_number,
      blockHash: e.block_hash,
      blockTime: e.block_time,
      final: e.final,
      removed: e.removed,
    },
  };
}

/// After the 1st, 2nd, … failed attempt: 1 minute, 5 minutes, 30 minutes,
/// 2 hours, 6 hours, then every 6 hours, for 24 hours from the first attempt
/// (or from a replay).
export const RETRY_DELAYS_SECS = [60, 300, 1_800, 7_200, 21_600] as const;
export const RETRY_WINDOW_SECS = 24 * 3_600;

/// When to try again after `attempts` failures, or null once the next try
/// would fall outside the window: the delivery is then failed until replayed.
export function nextAttempt(attempts: number, windowStartedAt: Date, now: Date): Date | null {
  const delay = RETRY_DELAYS_SECS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_SECS.length) - 1];
  const next = new Date(now.getTime() + delay * 1_000);
  return next.getTime() - windowStartedAt.getTime() > RETRY_WINDOW_SECS * 1_000 ? null : next;
}
