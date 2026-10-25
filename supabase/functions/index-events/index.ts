/// Reads Remesso's payment events from the chain into `payment_events`.
///
/// Every minute (pg_cron `remesso-index-events`). For each contract:
///   1. compare the cursor's block hash with the chain, and roll back if a
///      reorg reached it (`_shared/events.ts` decides);
///   2. read the next window of logs;
///   3. add what the logs don't say: a run's token, a policy payment's owner,
///      block times;
///   4. record the batch and the new cursor in one call. Events at or below the
///      RPC's finalized block are marked final as it passes them.
///
/// The record covers every path a payment takes, including the two that never
/// pass through our functions: an early send by a trigger the sender named,
/// and an agent's policy payment. It reads the chain, never the subgraph:
/// receivers act on these events, and nothing that money depends on reads the
/// subgraph (CLAUDE.md, invariants).
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseAbi } from "npm:viem@2";
import { creationCodes } from "../_shared/builder-codes.ts";
import { getSchedule, publicClient } from "../_shared/celo.ts";
import { ALLOWANCE, CHAIN_ID, V5 } from "../_shared/deployments.ts";
import {
  allowanceEvents,
  type Cursor,
  decideCursor,
  type EventRow,
  type Facts,
  type Head,
  type Log,
  rowsFor,
  v5Events,
} from "../_shared/events.ts";
import { bindPolicyPayments } from "../_shared/request-binding.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

/// Blocks per read: forno answers getLogs over at most 5,000.
const SPAN = 5_000n;
/// Reads per contract per pass. A backfill from the deployment blocks catches
/// up over an hour or so of passes instead of running one into its wall clock.
const MAX_READS = 10;

const policyAbi = parseAbi([
  "function policy(uint256) view returns ((address owner, address agent, address token, uint64 expiresAt, bool allowlistOnly, bool revoked, uint128 perPayment, uint128 perDay, uint128 spentInWindow, uint64 windowStart))",
]);

type Source = { name: string; address: `0x${string}`; events: typeof v5Events | typeof allowanceEvents };
const SOURCES: Source[] = [
  { name: "RemessoExecutorV5", address: V5.address, events: v5Events },
  { name: "RemessoAgentAllowance", address: ALLOWANCE.address, events: allowanceEvents },
];

Deno.serve(async () => {
  let head: bigint, finalized: Head;
  try {
    const [h, f] = await Promise.all([
      publicClient.getBlock({ blockTag: "latest" }),
      publicClient.getBlock({ blockTag: "finalized" }),
    ]);
    head = h.number;
    finalized = { block: f.number, hash: f.hash };
  } catch (e) {
    console.error("index-events: could not read the heads", (e as Error).message);
    return json({ error: "could not read the chain" }, 502);
  }

  const results = [];
  for (const src of SOURCES) {
    try {
      results.push(await indexSource(src, head, finalized));
    } catch (e) {
      // One contract's failure doesn't hold up the other's.
      console.error(`index-events: ${src.name}`, (e as Error).message);
      results.push({ source: src.name, error: (e as Error).message });
    }
  }

  // Requests answered by a policy payment carrying their reference in the memo.
  let bound = 0;
  try {
    bound = await bindPolicyPayments(db);
  } catch (e) {
    console.error("index-events: request binding failed", (e as Error).message);
  }

  return json({ head: String(head), finalized: String(finalized.block), results, requestsBound: bound });
});

async function indexSource(src: Source, head: bigint, finalized: Head) {
  let reads = 0, recorded = 0;
  for (;;) {
    const cursor = await readCursor(src);
    const d = decideCursor(cursor, cursor.hash ? await blockHash(cursor.block) : undefined, head, finalized, SPAN);

    if (d.action === "halt") {
      console.error(`index-events: ${src.name} HALTED: ${d.reason}`);
      return { source: src.name, halted: d.reason };
    }
    if (d.action === "rollback") {
      const { data, error } = await db.rpc("rollback_payment_events", {
        p_chain_id: CHAIN_ID,
        p_contract: src.address,
        p_from_block: cursor.block.toString(),
        p_from_hash: cursor.hash,
        p_to_block: d.to.block.toString(),
        p_to_hash: d.to.hash,
      });
      if (error) throw new Error(`rollback: ${error.message}`);
      console.warn(`index-events: ${src.name} reorg under block ${cursor.block}; ${data} events marked removed, reading again from ${d.to.block}`);
      continue;
    }
    if (d.action === "wait" || reads >= MAX_READS) {
      // Nothing more to read this pass, but the finalized block may have
      // moved: an empty batch from the cursor to itself marks what passed it.
      await record(src, cursor, cursor, finalized.block, []);
      return { source: src.name, reads, recorded, at: String(cursor.block) };
    }

    // The window's last block, before and after the read. If it changed, a
    // reorg happened mid-read and the logs may be from either side of it.
    const endBefore = await blockHash(d.to);
    const logs = await publicClient.getLogs({ address: src.address, events: src.events, fromBlock: d.from, toBlock: d.to });
    const endAfter = await blockHash(d.to);
    if (!endBefore || endBefore !== endAfter) {
      return { source: src.name, reads, recorded, at: String(cursor.block), note: "the window's last block changed during the read" };
    }

    const rows = rowsFor(logs as unknown as Log[], await factsFor(src, logs as unknown as Log[]));
    recorded += await record(src, cursor, { block: d.to, hash: endAfter }, finalized.block, rows);
    reads++;
  }
}

async function readCursor(src: Source): Promise<Cursor> {
  const { data, error } = await db
    .from("chain_cursors")
    .select("block_number, block_hash")
    .eq("chain_id", CHAIN_ID)
    .eq("contract", src.address)
    .single();
  if (error) throw new Error(`cursor: ${error.message}`);
  return { block: BigInt(data.block_number), hash: data.block_hash };
}

/// The chain's hash for a block, or null when this node doesn't have it.
async function blockHash(n: bigint): Promise<string | null> {
  try {
    return (await publicClient.getBlock({ blockNumber: n })).hash;
  } catch {
    return null;
  }
}

/// What the logs don't carry. Every value read here is fixed when a schedule
/// or policy is created, so reading it at the latest block is as good as at
/// the event's.
async function factsFor(src: Source, logs: Log[]): Promise<Facts> {
  const facts: Facts = { blockTime: new Map(), schedules: new Map(), policies: new Map(), codes: new Map() };
  await Promise.all([...new Set(logs.map((l) => l.blockNumber))].map(async (n) => {
    facts.blockTime.set(n, Number((await publicClient.getBlock({ blockNumber: n })).timestamp));
  }));
  const ids = [...new Set(logs.map((l) => String(l.args.id)))];
  if (src.address === V5.address) {
    await Promise.all(ids.map(async (id) => {
      const s = await getSchedule(BigInt(id), { contract: V5.address });
      facts.schedules.set(id, {
        token: s.token.toLowerCase(),
        tokenOut: s.tokenOut.toLowerCase(),
        payoutType: s.payoutType,
        feeBps: s.feeBps,
      });
    }));
    // The builder codes an integrator put on the transaction that created a
    // schedule, which every run of it then carries (`builder-codes.ts`).
    const created = [...new Set(logs.filter((l) => l.eventName === "ScheduleCreated").map((l) => l.transactionHash))];
    await Promise.all(created.map(async (hash) => {
      facts.codes.set(hash, creationCodes((await publicClient.getTransaction({ hash })).input));
    }));
  } else {
    await Promise.all(ids.map(async (id) => {
      const p = await publicClient.readContract({ address: ALLOWANCE.address, abi: policyAbi, functionName: "policy", args: [BigInt(id)] });
      facts.policies.set(id, { owner: p.owner.toLowerCase(), agent: p.agent.toLowerCase(), token: p.token.toLowerCase() });
    }));
  }
  return facts;
}

async function record(src: Source, from: Cursor, to: Cursor, finalizedBlock: bigint, rows: EventRow[]): Promise<number> {
  const { data, error } = await db.rpc("record_payment_events", {
    p_chain_id: CHAIN_ID,
    p_contract: src.address,
    p_from_block: from.block.toString(),
    p_from_hash: from.hash,
    p_to_block: to.block.toString(),
    p_to_hash: to.hash,
    p_finalized: finalizedBlock.toString(),
    p_events: rows,
  });
  if (error) throw new Error(`record: ${error.message}`);
  return Number(data ?? 0);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
