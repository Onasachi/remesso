/// Pins what `execute-due-runs` does with a run a dead invocation left in
/// flight. The reasons are pinned by `failures.test.ts` too, because a sender
/// sees them.
///
///   deno test supabase/functions/_shared/recovery.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import type { RunExecuted } from "./receipt.ts";
import { decide } from "./recovery.ts";

const HASH = "0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72";
const RUN: RunExecuted = {
  id: 1n,
  sender: "0x5b156fe262b54c236563428c56839d8457a5542c",
  destination: "0xfd1a3980f7473bdfe7461e78adde78c33d7b006b",
  amountIn: 1_000_000n,
  amountOut: 997_500n,
  runsExecuted: 1,
  nextRunAt: 1_792_172_105n,
};
const mined = (ok: boolean) => ({
  kind: "mined" as const,
  hash: HASH,
  outcome: ok ? { ok: true as const, run: RUN } : { ok: false as const, reason: `run reverted on-chain in ${HASH}` },
  blockNumber: 80_271_047n,
  gasUsed: 118_302n,
});

Deno.test("a mined run settles from its own event, net of the fee", () => {
  assertEquals(decide(mined(true), "direct"), {
    action: "settle",
    status: "delivered",
    hash: HASH,
    amountOut: 997_500n,
    blockNumber: 80_271_047n,
    gasUsed: 118_302n,
  });
});

Deno.test("a mined bank run waits for the naira, it is not delivered", () => {
  const d = decide(mined(true), "ngn_bank");
  assertEquals(d.action === "settle" && d.status, "redeeming");
});

Deno.test("a reverted run fails, and keeps its hash and gas", () => {
  assertEquals(decide(mined(false), "direct"), {
    action: "fail",
    reason: `run reverted on-chain in ${HASH}`,
    hash: HASH,
    blockNumber: 80_271_047n,
    gasUsed: 118_302n,
  });
});

Deno.test("a transaction still in the mempool is left alone", () => {
  assertEquals(decide({ kind: "pending", hash: HASH }, "direct"), { action: "wait" });
});

Deno.test("a hash the chain never saw fails, so the schedule runs again", () => {
  assertEquals(decide({ kind: "unknown_tx", hash: HASH }, "direct"), {
    action: "fail",
    reason: `run transaction ${HASH} was never mined`,
    hash: HASH,
  });
});

Deno.test("a row that never sent anything fails as abandoned", () => {
  assertEquals(decide({ kind: "never_sent" }, "wallet"), { action: "fail", reason: "abandoned before sending" });
});
