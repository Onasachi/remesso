/// Move Remesso's ERC-8004 identities onto V5 and the new agent wallet.
///
///   deno run --allow-env --allow-read --allow-net scripts/erc8004-v5.ts          # dry run: reads only
///   deno run --allow-env --allow-read --allow-net scripts/erc8004-v5.ts --send   # sends what is missing
///
/// Both entries embed their metadata as a `data:` URI (see CLAUDE.md, "Agent
/// identity"), and both named V4. V5 went live 2026-10-16 with a new executor,
/// so:
///
///   #9879 — the identity held by the wallet that sends the agent's
///           transactions. That wallet is now 0xA351…, so the token moves
///           there from the old executor (0x3c75…). The registry clears
///           `agentWallet` on any transfer, so the new wallet then sets itself
///           back, by EIP-712 signature (it must consent), and writes the new
///           metadata. The id stays 9879, which the hackathon submission cites.
///   #9867 — held by the owner 0xcDEA…; only its metadata changes.
///
/// Idempotent: every step reads first and is skipped if already done, so a
/// re-run after a failure sends only what is left. Every transaction carries
/// the ERC-8021 attribution suffix. Keys are read from their files and never
/// printed.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
} from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";
import { ATTRIBUTION_CODES, suffixFor } from "../supabase/functions/_shared/attribution.ts";

const SEND = Deno.args.includes("--send");
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
const AGENT_WALLET_ID = 9879n;
const OWNER_ID = 9867n;
const RPC = Deno.env.get("CELO_RPC_URL") ?? "https://forno.celo.org";
const SUFFIX = suffixFor(ATTRIBUTION_CODES);

const abi = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function getAgentWallet(uint256) view returns (address)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function setAgentURI(uint256 agentId, string newURI)",
]);

const HOME = Deno.env.get("HOME")!;
const fromKeyFile = (f: string) =>
  JSON.parse(Deno.readTextFileSync(`${HOME}/.remesso/keys/${f}`))[0].private_key as Hex;
const fromDotEnv = (k: string) => {
  const line = Deno.readTextFileSync(new URL("../.env", import.meta.url)).split("\n").find((l) => l.startsWith(`${k}=`));
  if (!line) throw new Error(`${k} missing from .env`);
  return line.slice(k.length + 1).trim() as Hex;
};

const oldExecutor = privateKeyToAccount(fromKeyFile("executor.json"));
const newExecutor = privateKeyToAccount(fromDotEnv("EXECUTOR_PRIVATE_KEY"));
const owner = privateKeyToAccount(fromKeyFile("owner.json"));

const doc = JSON.parse(Deno.readTextFileSync(new URL("../docs/erc8004/registration.json", import.meta.url)));
// UTF-8 first: the descriptions carry dashes, and `btoa` takes Latin-1 only.
const URI = "data:application/json;base64," +
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(doc))));

const pub = createPublicClient({ chain: celo, transport: http(RPC) });

console.log(`mode         : ${SEND ? "SEND" : "dry run (pass --send to send)"}`);
console.log(`old executor : ${oldExecutor.address}`);
console.log(`new executor : ${newExecutor.address}`);
console.log(`owner        : ${owner.address}`);
console.log(`metadata     : ${URI.length} chars, contract ${doc.contracts[0].name} ${doc.contracts[0].address}`);

/// Nonces tracked here: forno is load balanced and a node a block behind
/// reports a stale next nonce (it failed setup-v5.sh's sends the same day).
const nonces = new Map<string, number>();
async function send(account: typeof owner, fn: "transferFrom" | "setAgentWallet" | "setAgentURI", args: readonly unknown[]) {
  if (!SEND) return console.log(`  would send ${fn} from ${account.address}`);
  let n = nonces.get(account.address);
  if (n === undefined) n = await pub.getTransactionCount({ address: account.address });
  const wc = createWalletClient({ account, chain: celo, transport: http(RPC) });
  // deno-lint-ignore no-explicit-any
  const { request } = await pub.simulateContract({ address: REGISTRY, abi, functionName: fn, args: args as any, account, nonce: n, ...(SUFFIX ? { dataSuffix: SUFFIX } : {}) });
  const hash = await wc.writeContract(request);
  nonces.set(account.address, n + 1);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${fn}: ${hash} ${r.status} gas ${r.gasUsed}`);
  if (r.status !== "success") throw new Error(`${fn} reverted`);
}

const read = <T>(functionName: "ownerOf" | "tokenURI" | "getAgentWallet", id: bigint) =>
  pub.readContract({ address: REGISTRY, abi, functionName, args: [id] }) as Promise<T>;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// --- #9879: held by the agent wallet --------------------------------------
console.log(`\n#${AGENT_WALLET_ID}`);
const holder = await read<string>("ownerOf", AGENT_WALLET_ID);
if (same(holder, oldExecutor.address)) {
  console.log(`  held by the old executor — moving to ${newExecutor.address}`);
  await send(oldExecutor, "transferFrom", [oldExecutor.address, newExecutor.address, AGENT_WALLET_ID]);
} else if (same(holder, newExecutor.address)) {
  console.log("  already held by the new executor");
} else {
  throw new Error(`#${AGENT_WALLET_ID} is held by ${holder}, neither executor — refusing`);
}

const wallet = await read<string>("getAgentWallet", AGENT_WALLET_ID);
if (SEND && !same(wallet, newExecutor.address)) {
  // The new wallet's consent, over exactly what the registry hashes. Five
  // minutes is the registry's own ceiling on the deadline.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
  const signature = await newExecutor.signTypedData({
    domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: celo.id, verifyingContract: REGISTRY },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: { agentId: AGENT_WALLET_ID, newWallet: newExecutor.address, owner: newExecutor.address, deadline },
  });
  await send(newExecutor, "setAgentWallet", [AGENT_WALLET_ID, newExecutor.address, deadline, signature]);
} else {
  console.log(same(wallet, newExecutor.address) ? "  agentWallet already the new executor" : `  would set agentWallet (now ${wallet || "empty"})`);
}

if ((await read<string>("tokenURI", AGENT_WALLET_ID)) !== URI) {
  await send(newExecutor, "setAgentURI", [AGENT_WALLET_ID, URI]);
} else console.log("  metadata already current");

// --- #9867: held by the owner ---------------------------------------------
console.log(`\n#${OWNER_ID}`);
const ownerHolder = await read<string>("ownerOf", OWNER_ID);
if (!same(ownerHolder, owner.address)) throw new Error(`#${OWNER_ID} is held by ${ownerHolder}, not ${owner.address}`);
if ((await read<string>("tokenURI", OWNER_ID)) !== URI) {
  await send(owner, "setAgentURI", [OWNER_ID, URI]);
} else console.log("  metadata already current");

console.log("\ndone.");
