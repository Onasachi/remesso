/// Reads pinned to a block, against an RPC that spreads calls across nodes
/// which aren't all at the same height (forno, 2026-10-26).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { BlockNotFoundError } from "viem";
import { atBlock, behind } from "../src/context.ts";

Deno.test("a read that reaches a node behind its block is tried again", async () => {
  let calls = 0;
  const read = await atBlock(async () => {
    if (calls++ === 0) throw new Error("RPC Request failed. Details: block is out of range");
    return "read";
  });
  assertEquals([read, calls], ["read", 2]);
});

Deno.test("anything else a read throws is passed on at once", async () => {
  let calls = 0;
  await assertRejects(() =>
    atBlock(async () => {
      calls++;
      throw new Error("execution reverted: RunCapReached");
    }), Error, "RunCapReached");
  assertEquals(calls, 1);
});

Deno.test("what counts as a node behind the block", () => {
  assert(behind(new BlockNotFoundError({ blockNumber: 101n })));
  assert(behind(new Error("RPC Request failed. Details: block is out of range")));
  assert(behind(new Error("header not found")));
  assert(!behind(new Error("429 Too Many Requests")));
  assert(!behind(new Error("execution reverted")));
});
