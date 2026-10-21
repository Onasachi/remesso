// deno test --allow-env --unstable-sloppy-imports web/lib/allowance.test.ts
//
// Pins the approval a sender is asked for to the transfers the contract will
// actually make. Counting whole intervals before the expiry, the review screen
// asked for 11 of the default 12 monthly transfers — the first goes on the
// spot and the form ends a schedule on the day of its last — so the 12th was
// skipped for want of allowance.
import { assertEquals } from "jsr:@std/assert@1";
import { MAX_RUNS_PER_APPROVAL, runsToCover } from "./allowance";
import { INTERVALS, TEST_INTERVAL } from "./format";

const DAY = 86_400_000;
const MONTHLY = INTERVALS.find((i) => i.label === "Monthly")!.seconds;

/// The day `ms` falls on, read back as its last second: how the review screen
/// and `createSchedule` turn the form's end date into an expiry.
const endOfDay = (ms: number) => Date.parse(`${new Date(ms).toISOString().slice(0, 10)}T23:59:59Z`);

/// The end date the form fills in for a schedule signed at `at` (TermsStep's
/// `expiryFor`): the day the last transfer lands, with an hour's margin, at
/// most 364 days out; 330 days for one that runs until stopped.
function formExpiry(at: number, intervalSeconds: number, runs: number, startNow: boolean): number {
  const last = runs ? at + (startNow ? runs - 1 : runs) * intervalSeconds * 1000 + 3600_000 : at + 330 * DAY;
  return endOfDay(Math.min(last, at + 364 * DAY));
}

/// What RemessoExecutorV5 runs for a schedule signed at `at`: the first
/// transfer then or one interval later (`firstRunAt`), each next one an
/// interval after it, none past the expiry or the cap. That is on time at
/// best; the cron only ever runs them later. Counts no further than one past
/// the per-approval ceiling.
function contractRuns(at: number, intervalSeconds: number, maxRuns: number, expiresAtMs: number, startNow: boolean): number {
  let runs = 0;
  for (
    let t = startNow ? at : at + intervalSeconds * 1000;
    t <= expiresAtMs && (maxRuns === 0 || runs < maxRuns) && runs <= MAX_RUNS_PER_APPROVAL;
    t += intervalSeconds * 1000
  ) runs++;
  return runs;
}

Deno.test("the default schedule is approved for all 12 transfers", () => {
  const at = Date.parse("2026-10-20T19:00:00Z");
  const expiresAtMs = formExpiry(at, MONTHLY, 12, true);
  assertEquals(runsToCover({ intervalSeconds: MONTHLY, maxRuns: 12, expiresAtMs, startNow: true, fromMs: at }), 12);
});

Deno.test("every cadence, count, start and hour: the approval covers what the contract runs", () => {
  // The hours put the last transfer early in its day, late in it, and an
  // hour's margin either side of midnight.
  for (const hour of ["00:30:00", "12:00:00", "22:59:59", "23:30:00"]) {
    const at = Date.parse(`2026-10-20T${hour}Z`);
    for (const { seconds } of [TEST_INTERVAL, ...INTERVALS]) {
      for (const startNow of [true, false]) {
        for (let maxRuns = 0; maxRuns <= 60; maxRuns++) {
          const expiresAtMs = formExpiry(at, seconds, maxRuns, startNow);
          assertEquals(
            runsToCover({ intervalSeconds: seconds, maxRuns, expiresAtMs, startNow, fromMs: at }),
            Math.min(contractRuns(at, seconds, maxRuns, expiresAtMs, startNow), MAX_RUNS_PER_APPROVAL),
            `every ${seconds}s, ${maxRuns || "until stopped"}, ${startNow ? "first now" : "first in one interval"}, at ${hour}`,
          );
        }
      }
    }
  }
});

Deno.test("re-approving part-way covers every transfer left, due now or later", () => {
  const now = Date.parse("2026-10-20T19:00:00Z");
  for (const dueInDays of [0, 3, 29]) {
    // 12 monthly, the first at signing, 5 made; the 6th is due in `dueInDays`.
    const next = now + dueInDays * DAY;
    const signedAt = next - 5 * MONTHLY * 1000;
    const expiresAtMs = formExpiry(signedAt, MONTHLY, 12, true);
    assertEquals(
      // As Reapprove counts: from the next transfer, which goes once it is due.
      runsToCover({ intervalSeconds: MONTHLY, maxRuns: 12, expiresAtMs, startNow: true, fromMs: Math.max(next, now) }),
      7,
      `the next one due in ${dueInDays} days`,
    );
  }
});
