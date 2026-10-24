/// What to do with a run left `pending` or `swapping`.
///
/// `due_schedules` skips any schedule with a run in flight, and until
/// 2026-10-24 nothing moved such a row on. An invocation that died between
/// claiming a run and finishing it took that schedule out of every later pass,
/// silently (docs/agent-to-agent.md, 1c). `execute-due-runs` now looks at rows
/// older than ten minutes at the start of each pass, asks the chain what
/// happened, and lets this decide.
///
/// Every run's hash is written to its row before the transaction is
/// broadcast, so a row with a hash is settled from that hash. A row without
/// one was never sent by today's code. An older row could have been, so the
/// caller also looks for our own `executeRun` of that schedule since the row
/// was written.
///
/// Pure, like `preflight.ts`: the caller reads the chain and hands in what it
/// saw, and `recovery.test.ts` pins every rule.
import type { RunOutcome } from "./receipt.ts";

export type Seen =
  /// The row's transaction, or our own run found in the logs, has a receipt.
  | { kind: "mined"; hash: string; outcome: RunOutcome; blockNumber: bigint; gasUsed: bigint }
  /// The row's transaction is known to the node and not mined yet.
  | { kind: "pending"; hash: string }
  /// The row has a hash the chain doesn't know, asked more than once.
  | { kind: "unknown_tx"; hash: string }
  /// No hash on the row, and no run of ours for the schedule since it was written.
  | { kind: "never_sent" };

export type PayoutType = "direct" | "wallet" | "ngn_bank";

export type Decision =
  | {
    action: "settle";
    status: "delivered" | "redeeming";
    hash: string;
    amountOut: bigint;
    blockNumber: bigint;
    gasUsed: bigint;
  }
  | { action: "fail"; reason: string; hash?: string; blockNumber?: bigint; gasUsed?: bigint }
  | { action: "wait" };

export function decide(seen: Seen, payoutType: PayoutType): Decision {
  switch (seen.kind) {
    case "mined":
      if (!seen.outcome.ok) {
        // The gas was spent, so the row keeps where and how much.
        return {
          action: "fail",
          reason: seen.outcome.reason,
          hash: seen.hash,
          blockNumber: seen.blockNumber,
          gasUsed: seen.gasUsed,
        };
      }
      return {
        action: "settle",
        // A bank run's swap landing is not the naira landing: it waits for
        // `reconcile-redemptions` like any other bank run.
        status: payoutType === "ngn_bank" ? "redeeming" : "delivered",
        hash: seen.hash,
        amountOut: seen.outcome.run.amountOut,
        blockNumber: seen.blockNumber,
        gasUsed: seen.gasUsed,
      };
    case "pending":
      // Still in the mempool. It lands or it is dropped; either way a later
      // pass sees it.
      return { action: "wait" };
    case "unknown_tx":
      return { action: "fail", reason: `run transaction ${seen.hash} was never mined`, hash: seen.hash };
    case "never_sent":
      return { action: "fail", reason: "abandoned before sending" };
  }
}
