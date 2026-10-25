/// The contracts' ABIs, generated from the compiled contracts, and the two
/// standard ones the SDK reads.
import { parseAbi } from "viem";

export { allowanceAbi, executorAbi } from "./generated/abi.js";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

/// ERC-8004's identity registry: who an agent is, and the wallet it is paid at.
export const registryAbi = parseAbi([
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
]);
