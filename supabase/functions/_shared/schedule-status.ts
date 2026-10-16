/// What a schedule's mirror row should say, decided from the chain alone.
///
/// One rule for every writer. Before 2026-10-16 the executor wrote `completed`
/// for any schedule that was neither active nor cancelled — which includes one
/// its sender had merely PAUSED. `due_schedules` never returns a completed row
/// and the app hides Resume on one, so a pause became permanent
/// (solidity-auditor scan 2026-10-16). The contract has no "completed" flag:
/// it flips `active` off on the run that reaches `maxRuns`, the same field a
/// pause sets, so the two are told apart by the run count, not by `active`.
export type MirrorStatus = "active" | "paused" | "cancelled" | "completed";

export type ChainState = {
  active: boolean;
  cancelled: boolean;
  maxRuns: number;
  runsExecuted: number;
  expiresAt: bigint;
};

export function mirrorStatus(s: ChainState, nowSec: bigint = BigInt(Math.floor(Date.now() / 1000))): MirrorStatus {
  if (s.cancelled) return "cancelled";
  if (s.maxRuns !== 0 && s.runsExecuted >= s.maxRuns) return "completed";
  // Expired is finished too: nothing can run it, a resume included.
  if (s.expiresAt !== 0n && nowSec > s.expiresAt) return "completed";
  return s.active ? "active" : "paused";
}
