// (cd web && deno test --unstable-sloppy-imports lib/policies.test.ts)   # from web/: needs its node_modules
//
// Pins the policy scan to "every id, newest first": the setup screen's Stop
// buttons and the hosted connector's spending both depend on no live policy
// falling out of view, which is what the old 200 and 1,000 windows did.
import { assertEquals } from "jsr:@std/assert@1";
import { type Policy, scanPolicies } from "./policies";

const ME = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const ALLOWANCE = "0xA6351fAeEb097698289586C4D6188530300DB209";

/// A chain with `count` policies, where every seventh belongs to ME.
function fakeChain(count: number) {
  const batches: bigint[][] = [];
  const client = {
    readContract: async () => BigInt(count + 1), // nextPolicyId
    multicall: async ({ contracts }: { contracts: { args: [bigint] }[] }) => {
      const ids = contracts.map((c) => c.args[0]);
      batches.push(ids);
      return ids.map((id) => ({ owner: id % 7n === 0n ? ME : OTHER, agent: ME }) as unknown as Policy);
    },
  } as unknown as Parameters<typeof scanPolicies>[0];
  return { client, batches };
}

Deno.test("reads every policy, newest first, in batches of 250", async () => {
  const { client, batches } = fakeChain(1_200);
  const mine = await scanPolicies(client, ALLOWANCE, (p) => p.owner === ME);

  assertEquals(batches.map((b) => b.length), [250, 250, 250, 250, 200]);
  assertEquals(batches[0][0], 1_200n);
  assertEquals(batches.at(-1)!.at(-1), 1n, "the oldest policy is read too");

  const expected = Array.from({ length: 171 }, (_, i) => BigInt(1_197 - 7 * i));
  assertEquals(mine.map((m) => m.id), expected, "every seventh id, newest first");
  assertEquals(mine.at(-1)!.id, 7n, "a policy far older than the newest 1,000 still shows");
});

Deno.test("`above` reads only the policies newer than it", async () => {
  const { client, batches } = fakeChain(1_200);
  const newer = await scanPolicies(client, ALLOWANCE, () => true, 1_150n);
  assertEquals(batches.map((b) => b.length), [50]);
  assertEquals(newer.map((m) => m.id).at(-1), 1_151n);
  assertEquals(newer.length, 50);
});

Deno.test("no policies yet is an empty list, not an error", async () => {
  const { client, batches } = fakeChain(0);
  assertEquals(await scanPolicies(client, ALLOWANCE, () => true), []);
  assertEquals(batches.length, 0);
});
