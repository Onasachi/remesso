import { assertEquals } from "jsr:@std/assert@1";
import { mirrorStatus } from "./schedule-status.ts";

const base = { active: true, cancelled: false, maxRuns: 0, runsExecuted: 3, expiresAt: 2_000n };

Deno.test("a live schedule is active", () => {
  assertEquals(mirrorStatus(base, 1_000n), "active");
});

Deno.test("a sender's pause is a pause, not the end", () => {
  // The bug: inactive and not cancelled was written as completed.
  assertEquals(mirrorStatus({ ...base, active: false }, 1_000n), "paused");
  assertEquals(mirrorStatus({ ...base, active: false, maxRuns: 12 }, 1_000n), "paused");
});

Deno.test("the run that reaches the cap completes it", () => {
  assertEquals(mirrorStatus({ ...base, active: false, maxRuns: 3 }, 1_000n), "completed");
});

Deno.test("past the expiry nothing can run it", () => {
  assertEquals(mirrorStatus(base, 2_001n), "completed");
  assertEquals(mirrorStatus({ ...base, active: false }, 2_001n), "completed");
});

Deno.test("cancelled wins over everything", () => {
  assertEquals(mirrorStatus({ ...base, active: false, cancelled: true, maxRuns: 3 }, 9_999n), "cancelled");
});
