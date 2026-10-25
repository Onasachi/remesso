/// Pins how `index-events` reads the chain: where it reads next, what a reorg
/// does, and what each log becomes.
///
///   deno test supabase/functions/_shared/events.test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { decideCursor, type Facts, type Log, memoText, rowsFor } from "./events.ts";

const FIN = { block: 1_000n, hash: "0xf1" };
const SPAN = 5_000n; // blocks per read: forno answers getLogs over at most 5,000

Deno.test("a seed cursor has nothing to compare and reads from the next block", () => {
  assertEquals(decideCursor({ block: 80_268_720n, hash: null }, undefined, 80_300_000n, FIN, SPAN), {
    action: "read",
    from: 80_268_721n,
    to: 80_273_720n,
  });
});

Deno.test("a matching cursor reads up to the head, at most one forno window", () => {
  assertEquals(decideCursor({ block: 2_000n, hash: "0xaa" }, "0xAA", 2_010n, FIN, SPAN), { action: "read", from: 2_001n, to: 2_010n });
  assertEquals(decideCursor({ block: 2_000n, hash: "0xaa" }, "0xaa", 20_000n, FIN, SPAN), { action: "read", from: 2_001n, to: 7_000n });
});

Deno.test("at the head, or on a node that lags, it waits", () => {
  assertEquals(decideCursor({ block: 2_000n, hash: "0xaa" }, "0xaa", 2_000n, FIN, SPAN), { action: "wait" });
  assertEquals(decideCursor({ block: 2_000n, hash: "0xaa" }, null, 2_100n, FIN, SPAN), { action: "wait" });
});

Deno.test("a changed hash above finality rolls back to the finalized block", () => {
  assertEquals(decideCursor({ block: 2_000n, hash: "0xaa" }, "0xbb", 2_100n, FIN, SPAN), { action: "rollback", to: FIN });
});

Deno.test("a changed hash at or below finality halts: that needs a person", () => {
  const d = decideCursor({ block: 900n, hash: "0xaa" }, "0xbb", 2_100n, FIN, SPAN);
  assertEquals(d.action, "halt");
});

Deno.test("memos: a request's reference reads as text; zeros and binary don't", () => {
  const ref = "3f2a9c1e5b7d4f60a1b2c3d4e5f60718"; // 32 characters, a UUID without dashes
  const hex = `0x${[...ref].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}` as const;
  assertEquals(memoText(hex), ref);
  assertEquals(memoText(`0x${Buffer.from("x402 top-up").toString("hex").padEnd(64, "0")}`), "x402 top-up");
  assertEquals(memoText(`0x${"0".repeat(64)}`), null);
  assertEquals(memoText(`0x01${"0".repeat(62)}`), null);
});

const tx = "0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72" as const;
const log = (eventName: string, args: Record<string, unknown>, logIndex: number): Log => ({
  eventName,
  args,
  transactionHash: tx,
  logIndex,
  blockNumber: 80_271_047n,
  blockHash: "0xb10c",
});
const facts = (): Facts => ({
  blockTime: new Map([[80_271_047n, 1_792_171_805]]),
  schedules: new Map([["1", { token: "0xusat", tokenOut: "0x0000000000000000000000000000000000000000", payoutType: 2, feeBps: 25 }]]),
  policies: new Map([["7", { owner: "0xowner", agent: "0xagent", token: "0xusdt" }]]),
  codes: new Map([[tx, ["acme_app"]]]),
});

Deno.test("a run: the amount that arrived, its token, and whether it was sent early", () => {
  const run = log("RunExecuted", {
    id: 1n,
    sender: "0xsender",
    destination: "0xdest",
    amountIn: 1_000_000n,
    amountOut: 997_500n,
    runsExecuted: 1,
    nextRunAt: 1_792_172_105n,
  }, 11);
  const [plain] = rowsFor([run], facts());
  assertEquals([plain.kind, plain.amount, plain.amount_in, plain.token, plain.run_number, plain.early], ["run", "997500", "1000000", "0xusat", 1, false]);
  assertEquals(plain.block_time, new Date(1_792_171_805_000).toISOString());

  const trigger = log("RunTriggered", { id: 1n, by: "0x0000000000000000000000000000000000000001", triggersLeft: 2 }, 10);
  const rows = rowsFor([trigger, run], facts());
  assertEquals(rows.length, 1, "a RunTriggered rides on its run, with no row of its own");
  assertEquals(rows[0].early, true);
  assertEquals(rows[0].details.triggersLeft, 2);
});

Deno.test("a swap-rail run records the payout token, not the funding token", () => {
  const f = facts();
  f.schedules.set("1", { token: "0xusdt", tokenOut: "0xcngn", payoutType: 0, feeBps: 25 });
  const [row] = rowsFor([log("RunExecuted", { id: 1n, sender: "0xs", destination: "0xd", amountIn: 1n, amountOut: 1n, runsExecuted: 1, nextRunAt: 0n }, 0)], f);
  assertEquals(row.token, "0xcngn");
});

Deno.test("a new schedule records what each run will deliver, after the fee", () => {
  const [row] = rowsFor([log("ScheduleCreated", {
    id: 1n,
    sender: "0xs",
    destination: "0xd",
    amountIn: 5_012_532n,
    interval: 2_592_000n,
    minRateE6: 0n,
    maxRuns: 12,
    expiresAt: 1_800_000_000n,
    payoutType: 2,
  }, 3)], facts());
  assertEquals([row.kind, row.amount, row.amount_in], ["schedule_created", "5000000", "5012532"]);
  assertEquals([row.details.interval, row.details.maxRuns], ["2592000", 12]);
  assertEquals(row.details.builderCodes, ["acme_app"], "the integrator codes its transaction carried");
});

Deno.test("a schedule whose transaction wasn't read waits for the next pass", () => {
  const f = facts();
  f.codes.clear();
  const created = log("ScheduleCreated", {
    id: 1n, sender: "0xs", destination: "0xd", amountIn: 1n, interval: 1n, minRateE6: 0n, maxRuns: 1, expiresAt: 1n, payoutType: 2,
  }, 0);
  assertThrows(() => rowsFor([created], f), Error, `missing the input of transaction ${tx}`);
  f.codes.set(tx, []);
  assertEquals(rowsFor([created], f)[0].details.builderCodes, [], "read, and carrying none: an empty list");
});

Deno.test("a policy payment: the owner pays, and the memo is kept as text", () => {
  const memo = `0x${Buffer.from("invoice-42").toString("hex").padEnd(64, "0")}`;
  const [row] = rowsFor([log("Paid", { id: 7n, to: "0xdest", amount: 2_500_000n, memo }, 5)], facts());
  assertEquals([row.kind, row.from_address, row.agent, row.token, row.amount, row.memo_text], ["policy_payment", "0xowner", "0xagent", "0xusdt", "2500000", "invoice-42"]);
});

Deno.test("a missing fact refuses the batch rather than recording a blank", () => {
  assertThrows(() => rowsFor([log("Paid", { id: 8n, to: "0xd", amount: 1n, memo: `0x${"0".repeat(64)}` }, 0)], facts()), Error, "missing policy 8");
});
