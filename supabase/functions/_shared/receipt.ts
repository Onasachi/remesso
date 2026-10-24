/// What a run's receipt says happened, decided from the receipt alone.
///
/// viem's `waitForTransactionReceipt` returns a reverted receipt without
/// throwing. Until 2026-10-24 neither `execute-due-runs` nor `trigger-run`
/// looked at its status, so a run that reverted on-chain could be recorded as
/// delivered, and a payer who bought an early send was told it went through
/// (docs/agent-to-agent.md, 1b).
///
/// A run counts only when the receipt succeeded AND holds this contract's
/// `RunExecuted` for this schedule. V5 emits exactly one on every successful
/// run, from both `executeRun` and `runNow`, so a success without it means the
/// hash belongs to some other transaction.
///
/// The amount a run recorded used to be the quote, which on the Direct rail is
/// the amount sent: the recipient gets that minus the commission. The event's
/// `amountOut` is what actually arrived.
///
/// Pure, so `receipt.test.ts` can pin it to real receipts.
import { type Address, decodeEventLog, type Hex, parseAbi } from "npm:viem@2";

export const runExecutedAbi = parseAbi([
  "event RunExecuted(uint256 indexed id, address indexed sender, address indexed destination, uint128 amountIn, uint256 amountOut, uint32 runsExecuted, uint64 nextRunAt)",
]);

export type RunExecuted = {
  id: bigint;
  sender: Address;
  destination: Address;
  amountIn: bigint;
  /// What the recipient received: the amount after the commission on the
  /// Direct rail, the swap's output on the others.
  amountOut: bigint;
  runsExecuted: number;
  nextRunAt: bigint;
};

/// The parts of a receipt this reads. viem's `TransactionReceipt` fits.
export type ReceiptLike = {
  status: "success" | "reverted";
  transactionHash: Hex;
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
};

export type RunOutcome = { ok: true; run: RunExecuted } | { ok: false; reason: string };

/// Did this receipt run schedule `scheduleId` on `contract`? The reasons are
/// failure reasons a sender may see, matched by `failures.ts`.
export function runOutcome(receipt: ReceiptLike, contract: Address, scheduleId: bigint): RunOutcome {
  if (receipt.status !== "success") {
    return { ok: false, reason: `run reverted on-chain in ${receipt.transactionHash}` };
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    let args;
    try {
      ({ args } = decodeEventLog({
        abi: runExecutedAbi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      }));
    } catch {
      continue; // another of the contract's events: FeeCharged, RunTriggered
    }
    if (args.id !== scheduleId) continue;
    return {
      ok: true,
      run: {
        id: args.id,
        sender: args.sender,
        destination: args.destination,
        amountIn: args.amountIn,
        amountOut: args.amountOut,
        runsExecuted: Number(args.runsExecuted),
        nextRunAt: args.nextRunAt,
      },
    };
  }
  return {
    ok: false,
    reason: `run ${receipt.transactionHash} mined without a RunExecuted for schedule ${scheduleId}`,
  };
}
