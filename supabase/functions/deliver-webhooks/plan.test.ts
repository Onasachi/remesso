/// Pins what a subscription is told, what it says, and the retry schedule.
///
///   deno test supabase/functions/deliver-webhooks/plan.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { type EventRow, nextAttempt, payloadFor, plan, type WebhookType } from "./plan.ts";

const none = new Set<WebhookType>();

Deno.test("seen, not final: payment.received", () => {
  assertEquals(plan({ final: false, removed: false }, none, []), { queue: "payment.received", cancel: [] });
});

Deno.test("final: payment.finalized, also when it is the first we see of it", () => {
  assertEquals(plan({ final: true, removed: false }, new Set(["payment.received"]), []), { queue: "payment.finalized", cancel: [] });
  assertEquals(plan({ final: true, removed: false }, none, []), { queue: "payment.finalized", cancel: [] });
});

Deno.test("removed after it was announced: payment.removed", () => {
  assertEquals(plan({ final: false, removed: true }, new Set(["payment.received"]), []), { queue: "payment.removed", cancel: [] });
});

Deno.test("removed before anything was sent: nothing to say, and the waiting message is cancelled", () => {
  assertEquals(
    plan({ final: false, removed: true }, none, [{ id: "msg_waiting", type: "payment.received" }]),
    { queue: null, cancel: ["msg_waiting"] },
  );
});

Deno.test("retries: 1m, 5m, 30m, 2h, 6h, then every 6h, inside 24 hours", () => {
  const start = new Date("2026-10-25T00:00:00Z");
  const after = (attempts: number, at: Date) => nextAttempt(attempts, start, at)?.toISOString() ?? null;
  assertEquals(after(1, start), "2026-10-25T00:01:00.000Z");
  assertEquals(after(2, new Date("2026-10-25T00:01:00Z")), "2026-10-25T00:06:00.000Z");
  assertEquals(after(3, new Date("2026-10-25T00:06:00Z")), "2026-10-25T00:36:00.000Z");
  assertEquals(after(4, new Date("2026-10-25T00:36:00Z")), "2026-10-25T02:36:00.000Z");
  assertEquals(after(5, new Date("2026-10-25T02:36:00Z")), "2026-10-25T08:36:00.000Z");
  assertEquals(after(6, new Date("2026-10-25T08:36:00Z")), "2026-10-25T14:36:00.000Z");
  assertEquals(after(8, new Date("2026-10-25T20:36:00Z")), null, "past 24 hours: failed, until replayed");
});

const run: EventRow = {
  chain_id: 42220,
  tx_hash: "0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72",
  log_index: 11,
  contract: "0x3c357af3300f383ea49b6d6ed8e084199a92bed8",
  kind: "run",
  ref_id: "1",
  from_address: "0x5b156fe262b54c236563428c56839d8457a5542c",
  to_address: "0xfd1a3980f7473bdfe7461e78adde78c33d7b006b",
  token: "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
  amount: "997500",
  amount_in: "1000000",
  memo: null,
  memo_text: null,
  run_number: 1,
  early: false,
  block_number: 80271047,
  block_hash: "0xabc",
  block_time: "2026-10-16T17:30:05+00:00",
  final: true,
  removed: false,
  seq: 42,
};

Deno.test("a run's payload names the schedule, the amount that arrived, and how to check it", () => {
  const p = payloadFor(run, "payment.finalized", new Date("2026-10-25T09:00:00Z"));
  assertEquals(p.type, "payment.finalized");
  assertEquals(p.timestamp, "2026-10-25T09:00:00.000Z");
  assertEquals(p.data.schedule, "1");
  assertEquals([p.data.amount, p.data.amountIn, p.data.runNumber, p.data.early], ["997500", "1000000", 1, false]);
  assertEquals([p.data.txHash, p.data.logIndex, p.data.blockNumber, p.data.final], [run.tx_hash, 11, 80271047, true]);
  assertEquals("policy" in p.data, false);
});

Deno.test("a policy payment's payload names the policy and carries the memo", () => {
  const p = payloadFor(
    { ...run, kind: "policy_payment", ref_id: "7", memo: "0x6162", memo_text: "ab", amount_in: null, run_number: null, early: null },
    "payment.received",
    new Date("2026-10-25T09:00:00Z"),
  );
  assertEquals([p.data.policy, p.data.memo, p.data.memoText], ["7", "0x6162", "ab"]);
  assertEquals("schedule" in p.data || "amountIn" in p.data, false);
});
