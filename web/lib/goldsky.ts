/// Reads the Goldsky subgraph that indexes the configured executor contract
/// (`RemessoExecutorV5` since 2026-10-16; it was V3 until then) on Celo. One
/// contract only, so `useOnchainRuns` asks it about that contract's schedules
/// and no other: schedule ids restart at 1 in every deployment.
///
/// The `runs` table is written by `execute-due-runs` after it has waited for
/// the receipt, and the browser then polls it every 15s — so a run shows up
/// here well after the chain has settled it. The subgraph sees the
/// `RunExecuted` event within seconds of the block, which is as close to
/// "instant" as anything on-chain gets. It is an instant (no-code) subgraph
/// generated from the ABI — `indexer/goldsky.json` — so there are no mapping
/// handlers to keep in step with the contract.
///
/// Advisory to the UI only: nothing that decides whether a run pays reads
/// this. The contract is the authority, the database mirrors it, and the
/// subgraph is a faster window onto the contract.
///
/// Optional. Without `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL` the history is the
/// database alone, and every error here yields `null` so an outage is a
/// slower screen, not a broken one.

const URL = process.env.NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL ?? "";

export function goldskyEnabled(): boolean {
  return URL.startsWith("https://");
}

/// One `RunExecuted` event. Goldsky renames the event's `id` parameter to
/// `idParam` because `id` is the entity key; `block_number`, `timestamp_` and
/// `transactionHash_` are its own built-in fields, underscores and all.
export type OnchainRun = {
  txHash: string;
  blockNumber: number;
  /// Unix seconds, from the block.
  timestamp: number;
  amountIn: string;
  amountOut: string;
  runsExecuted: number;
  nextRunAt: number;
};

type RawRun = {
  transactionHash_: string;
  block_number: string;
  timestamp_: string;
  amountIn: string;
  amountOut: string;
  runsExecuted: string;
  nextRunAt: string;
};

const RUNS_QUERY = `
  query Runs($schedule: BigInt!, $first: Int!) {
    runExecuteds(
      where: { idParam: $schedule }
      orderBy: block_number
      orderDirection: desc
      first: $first
    ) {
      transactionHash_
      block_number
      timestamp_
      amountIn
      amountOut
      runsExecuted
      nextRunAt
    }
  }
`;

/// Every executed run for one on-chain schedule id, newest first. `null` when
/// the subgraph is unset, unreachable or answers with errors.
export async function fetchOnchainRuns(
  onchainId: string | number,
  signal?: AbortSignal,
): Promise<OnchainRun[] | null> {
  if (!goldskyEnabled()) return null;
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: RUNS_QUERY,
        variables: { schedule: String(onchainId), first: 200 },
      }),
      signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { runExecuteds?: RawRun[] };
      errors?: unknown[];
    };
    if (json.errors?.length || !json.data?.runExecuteds) return null;
    return json.data.runExecuteds.map((r) => ({
      txHash: r.transactionHash_.toLowerCase(),
      blockNumber: Number(r.block_number),
      timestamp: Number(r.timestamp_),
      amountIn: r.amountIn,
      amountOut: r.amountOut,
      runsExecuted: Number(r.runsExecuted),
      nextRunAt: Number(r.nextRunAt),
    }));
  } catch {
    return null;
  }
}
