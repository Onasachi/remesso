/// Every RemessoAgentAllowance policy that `keep` accepts, newest first.
///
/// Read by id in multicall batches, not by searching `PolicyCreated`: forno
/// answers getLogs over 5,000 blocks at most (~83 minutes). Until 2026-10-25
/// the setup screen read only the newest 200 ids and the hosted connector the
/// newest 1,000, so past those numbers an older live policy vanished from the
/// screens people use to inspect and stop it (docs/agent-to-agent.md, 2c).
/// Ids are dense, so reading every one is a call per 250 policies. The event
/// pipeline (Phase 3 of the plan) replaces this for the backend.
import type { Address, ContractFunctionReturnType, PublicClient } from "viem";
import { agentAllowanceAbi } from "./abi";

export type Policy = ContractFunctionReturnType<typeof agentAllowanceAbi, "view", "policy">;

/// The two reads used, so wagmi's client (Celo or Celo Sepolia, each with its
/// own formatters) and a plain server-side client both fit.
type Reader = Pick<PublicClient, "readContract" | "multicall">;

const BATCH = 250;

/// `above` skips every id at or below it: the hosted connector learns older
/// policies from the event table and reads only the newer ones here.
export async function scanPolicies(
  client: Reader,
  allowance: Address,
  keep: (p: Policy) => boolean,
  above = 0n,
): Promise<{ id: bigint; p: Policy }[]> {
  const next = await client.readContract({ address: allowance, abi: agentAllowanceAbi, functionName: "nextPolicyId" });
  const found: { id: bigint; p: Policy }[] = [];
  const low = above + 1n;
  for (let hi = next - 1n; hi >= low; hi -= BigInt(BATCH)) {
    const ids: bigint[] = [];
    for (let id = hi; id >= low && id > hi - BigInt(BATCH); id--) ids.push(id);
    const policies = await client.multicall({
      contracts: ids.map((id) => ({ address: allowance, abi: agentAllowanceAbi, functionName: "policy", args: [id] }) as const),
      allowFailure: false,
    });
    policies.forEach((p, i) => {
      if (keep(p as Policy)) found.push({ id: ids[i], p: p as Policy });
    });
  }
  return found;
}
