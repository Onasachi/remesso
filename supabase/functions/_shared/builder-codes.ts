/// Builder codes: an integrator's own ERC-8021 codes, carried on every run of
/// the schedules it creates (docs/agent-to-agent.md, step 6).
///
/// The integrator tags its `createSchedule` transaction, as it would anyway
/// for its own rewards. `index-events` reads that transaction when it records
/// the `ScheduleCreated` and keeps the codes on the event. Each run then puts
/// them after ours (`attribution.ts`, `runSuffix`), so Celo credits the
/// schedule's volume to the integrator too. The EVM discards the suffix: a
/// wrong code can put credit in the wrong place, never change what a run does.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type Hex, parseAbiItem } from "npm:viem@2";
import { OUR_CODES, parseSuffix } from "./attribution.ts";
import { publicClient } from "./celo.ts";
import { CHAIN_ID } from "./deployments.ts";
import { integratorCodes } from "./erc8021.ts";

/// The integrator codes in the input of a transaction that created schedules.
export function creationCodes(input: string): string[] {
  return integratorCodes(parseSuffix(input)?.codes ?? [], OUR_CODES);
}

/// What `codesForRun` reads from the chain when the indexer hasn't recorded a
/// schedule: the live client, or a scripted one in its test.
export type CodesChain = {
  getBlockNumber(): Promise<bigint>;
  /// The transaction whose `ScheduleCreated` names `id`, within these blocks.
  createdIn(contract: Hex, id: bigint, fromBlock: bigint, toBlock: bigint): Promise<Hex | null>;
  inputOf(hash: Hex): Promise<string>;
};

const scheduleCreated = parseAbiItem(
  "event ScheduleCreated(uint256 indexed id, address indexed sender, address indexed destination, uint128 amountIn, uint64 interval, uint96 minRateE6, uint32 maxRuns, uint64 expiresAt, uint8 payoutType)",
);

const liveChain: CodesChain = {
  getBlockNumber: () => publicClient.getBlockNumber(),
  async createdIn(contract, id, fromBlock, toBlock) {
    const logs = await publicClient.getLogs({ address: contract, event: scheduleCreated, args: { id }, fromBlock, toBlock });
    return logs[0]?.transactionHash ?? null;
  },
  inputOf: async (hash) => (await publicClient.getTransaction({ hash })).input,
};

/// One forno getLogs window. A schedule the indexer hasn't recorded was
/// created in the last minute or so, unless the indexer is stuck.
const LOOKBACK = 4_999n;

/// The integrator codes a run of schedule `id` on `contract` carries: [] rather
/// than an error, whatever goes wrong. Attribution must never be the reason a
/// payment doesn't go out.
///
/// Usually one indexed read. The indexer runs every minute, and an early send
/// can come sooner (`trigger-run`), so a schedule it hasn't recorded is looked
/// up on the chain instead. So is one recorded before codes were read.
export async function codesForRun(
  db: SupabaseClient,
  contract: string,
  id: bigint,
  chain: CodesChain = liveChain,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from("payment_events")
      .select("tx_hash, details")
      .eq("chain_id", CHAIN_ID)
      .eq("contract", contract.toLowerCase())
      .eq("kind", "schedule_created")
      .eq("ref_id", id.toString())
      .eq("removed", false)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const stored = (data?.details as { builderCodes?: unknown } | undefined)?.builderCodes;
    if (Array.isArray(stored)) {
      return integratorCodes(stored.filter((c): c is string => typeof c === "string"), OUR_CODES);
    }

    let hash = (data?.tx_hash as Hex | undefined) ?? null;
    if (!hash) {
      const head = await chain.getBlockNumber();
      hash = await chain.createdIn(contract as Hex, id, head > LOOKBACK ? head - LOOKBACK : 0n, head);
    }
    return hash ? creationCodes(await chain.inputOf(hash)) : [];
  } catch (e) {
    console.warn(`builder codes for schedule ${id}: ${(e as Error).message}; the run carries ours only`);
    return [];
  }
}
