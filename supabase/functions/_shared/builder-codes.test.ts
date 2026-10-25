/// Which builder codes a run carries, and that nothing about finding them can
/// stop a run.
///
///   deno test --allow-env supabase/functions/_shared/builder-codes.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { suffixFor } from "./attribution.ts";
import { type CodesChain, codesForRun, creationCodes } from "./builder-codes.ts";

const V5 = "0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8";
const CREATED = "0x5c2b8389a3e9a312d4c880017e35d3169a749471c729fba3388c21fe7fee7ffc";
/// A createSchedule input as an integrator using remesso-sdk would send it:
/// the call, then ours and theirs in one suffix.
const CALL = `0x6f2e1b3b${"00".repeat(31)}04${"ab".repeat(64)}`;
const INPUT = `${CALL}${suffixFor(["remesso", "celo_5cd35ca55baf", "acme_app"])!.slice(2)}`;

/// A Supabase client whose one query answers `row`, keeping the filters asked.
function fakeDb(row: Record<string, unknown> | null, error: { message: string } | null = null) {
  const asked: Record<string, unknown> = {};
  const q = {
    select: () => q,
    eq: (column: string, value: unknown) => {
      asked[column] = value;
      return q;
    },
    limit: () => q,
    maybeSingle: async () => ({ data: row, error }),
  };
  return { db: { from: (table: string) => (asked.table = table, q) } as never, asked };
}

/// A chain that fails the test if it is asked anything.
const untouched: CodesChain = {
  getBlockNumber: () => Promise.reject(new Error("the chain was asked")),
  createdIn: () => Promise.reject(new Error("the chain was asked")),
  inputOf: () => Promise.reject(new Error("the chain was asked")),
};

Deno.test("the codes in a creating transaction: theirs, not ours", () => {
  assertEquals(creationCodes(INPUT), ["acme_app"]);
  assertEquals(creationCodes(`${CALL}${suffixFor(["remesso", "celo_5cd35ca55baf"])!.slice(2)}`), [], "made in the Remesso app");
  assertEquals(creationCodes(CALL), [], "untagged");
});

Deno.test("a recorded schedule: its stored codes, and nothing asked of the chain", async () => {
  const { db, asked } = fakeDb({ tx_hash: CREATED, details: { builderCodes: ["acme_app"] } });
  assertEquals(await codesForRun(db, V5, 4n, untouched), ["acme_app"]);
  assertEquals(asked, {
    table: "payment_events", chain_id: 42220, contract: V5.toLowerCase(), kind: "schedule_created", ref_id: "4", removed: false,
  });
  // Stored before a rule changed: checked again on the way out.
  const old = fakeDb({ tx_hash: CREATED, details: { builderCodes: ["acme_app", "remesso", "Bad", 7] } });
  assertEquals(await codesForRun(old.db, V5, 4n, untouched), ["acme_app"]);
  const none = fakeDb({ tx_hash: CREATED, details: { builderCodes: [] } });
  assertEquals(await codesForRun(none.db, V5, 4n, untouched), [], "read, and none: nothing more to look up");
});

Deno.test("recorded before codes were read: its transaction is read", async () => {
  const { db } = fakeDb({ tx_hash: CREATED, details: { interval: "300" } });
  const read: string[] = [];
  const chain: CodesChain = { ...untouched, inputOf: async (hash) => (read.push(hash), INPUT) };
  assertEquals(await codesForRun(db, V5, 4n, chain), ["acme_app"]);
  assertEquals(read, [CREATED]);
});

Deno.test("not recorded yet (an early send in the first minute): found on the chain", async () => {
  const { db } = fakeDb(null);
  const asked: unknown[] = [];
  const chain: CodesChain = {
    getBlockNumber: async () => 81_050_000n,
    createdIn: async (contract, id, from, to) => (asked.push([contract, id, from, to]), CREATED),
    inputOf: async () => INPUT,
  };
  assertEquals(await codesForRun(db, V5, 4n, chain), ["acme_app"]);
  assertEquals(asked, [[V5, 4n, 81_045_001n, 81_050_000n]], "one forno window back from the head");

  const missing: CodesChain = { ...chain, createdIn: async () => null };
  assertEquals(await codesForRun(db, V5, 4n, missing), [], "no log in reach: ours only");
});

Deno.test("whatever fails, the run goes out with ours only", async () => {
  assertEquals(await codesForRun(fakeDb(null, { message: "connection refused" }).db, V5, 4n, untouched), []);
  const lagging: CodesChain = {
    getBlockNumber: async () => 81_050_000n,
    createdIn: async () => CREATED,
    inputOf: () => Promise.reject(new Error("transaction not found")),
  };
  assertEquals(await codesForRun(fakeDb(null).db, V5, 4n, lagging), []);
  const throwing: CodesChain = { ...lagging, getBlockNumber: () => Promise.reject(new Error("block is out of range")) };
  assertEquals(await codesForRun(fakeDb(null).db, V5, 4n, throwing), []);
});
