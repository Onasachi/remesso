/// Write `deployments/celo-mainnet.json` from what is DEPLOYED: the live
/// capability document and reads from the chain, never from memory.
///
/// Several clients still hardcode the chain, the contracts, the tokens and the
/// function URLs (docs/agent-to-agent.md, 2a). This file is the one place they
/// are written down, generated so it can't drift from the deployment
/// unnoticed. `scripts/deployments.test.ts` holds the hardcoded copies to it
/// until each client reads it directly. Re-run after a redeploy, a new token
/// on the allowlist, or a new public function:
///
///   deno run --allow-net --allow-read --allow-write --allow-env scripts/build-deployments.ts
///
/// `--check` writes nothing and exits 1 if the committed file differs from
/// what is live, for CI or a cron.
import { createPublicClient, getAddress, http, parseAbi, type Address } from "npm:viem@2";
import { celo } from "npm:viem@2/chains";
import { DIRECT_TOKENS } from "../supabase/functions/_shared/config.ts";

const FUNCTIONS = "https://engaboljiqudghvzmebq.supabase.co/functions/v1";
const APP = "https://remesso.xyz";
const RPC = "https://forno.celo.org";
const OUT = "deployments/celo-mainnet.json";
const check = Deno.args.includes("--check");

/// Not in `/agent`, which describes the executor's side only. Read back from
/// the contract below, so a wrong address fails the build instead of landing
/// in the file. Blocks from CLAUDE.md's "Deployed state".
const AGENT_ALLOWANCE = { address: "0xA6351fAeEb097698289586C4D6188530300DB209", deployBlock: 80_467_202 };
const V5_DEPLOY_BLOCK = 80_268_721;

/// Celo's FeeCurrencyDirectory: the tokens gas can be paid in. USD₮, USDC and
/// USA₮ are listed through 18dp adapters that report the real token's symbol,
/// which is why a client must take the adapter's address from here, never
/// match on a symbol.
const FEE_CURRENCY_DIRECTORY = "0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276";

/// A token's unit of account. Not on-chain: a wARS is a peso whatever its
/// decimals, and every dollar total the app shows depends on not adding it 1:1.
const CURRENCY: Record<string, string> = {
  USDT: "USD",
  USDC: "USD",
  USDm: "USD",
  "USA₮": "USD",
  wARS: "ARS",
  wBRL: "BRL",
  wCOP: "COP",
  cNGN: "NGN",
};

/// The public functions a client calls, by the last part of their URL.
const PUBLIC_FUNCTIONS = ["agent", "request-payment", "trigger-run", "rate-service", "latam-rate", "latam-route"];

const client = createPublicClient({ chain: celo, transport: http(RPC) });
const v5Abi = parseAbi([
  "function executor() view returns (address)",
  "function directTokenAllowed(address) view returns (bool)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);
const allowanceAbi = parseAbi(["function nextPolicyId() view returns (uint256)"]);
const directoryAbi = parseAbi(["function getCurrencies() view returns (address[])"]);
// Circle's adapter names its token `adaptedToken()`, Tether's `wrappedToken()`.
const adapterAbi = parseAbi([
  "function adaptedToken() view returns (address)",
  "function wrappedToken() view returns (address)",
]);

const fail = (why: string): never => {
  console.error(`build-deployments: ${why}`);
  Deno.exit(1);
};

// --- what the deployment says about itself ----------------------------------
const agent = await (await fetch(`${FUNCTIONS}/agent`)).json();
if (agent.chain?.chainId !== 42220) fail(`/agent says chain ${agent.chain?.chainId}, not 42220`);
const v5 = getAddress(agent.chain.executor);
const sentinel = getAddress(agent.chain.trigger);
const registry = getAddress(agent.identity.erc8004.registry);

// --- what the chain says ----------------------------------------------------
const chainId = await client.getChainId();
if (chainId !== 42220) fail(`${RPC} answered chain ${chainId}`);

for (const [name, address] of [["RemessoExecutorV5", v5], ["RemessoAgentAllowance", AGENT_ALLOWANCE.address], ["ERC-8004 registry", registry]]) {
  const code = await client.getCode({ address: address as Address });
  if (!code || code === "0x") fail(`${name} at ${address} has no code`);
}

const executor = await client.readContract({ address: v5, abi: v5Abi, functionName: "executor" });
if (executor.toLowerCase() !== String(agent.chain.triggeredBy).toLowerCase()) {
  fail(`V5's executor is ${executor} on-chain but /agent says ${agent.chain.triggeredBy}`);
}
// A liveness read: the address answers as the allowance contract does.
await client.readContract({ address: getAddress(AGENT_ALLOWANCE.address), abi: allowanceAbi, functionName: "nextPolicyId" });

const tokenReads = await client.multicall({
  allowFailure: false,
  contracts: DIRECT_TOKENS.flatMap((t) => [
    { address: getAddress(t.address), abi: erc20Abi, functionName: "decimals" } as const,
    { address: v5, abi: v5Abi, functionName: "directTokenAllowed", args: [getAddress(t.address)] } as const,
  ]),
});

const feeCurrencies = await client.readContract({ address: FEE_CURRENCY_DIRECTORY, abi: directoryAbi, functionName: "getCurrencies" });
const adapted = await client.multicall({
  allowFailure: true,
  contracts: feeCurrencies.flatMap((a) => [
    { address: a, abi: adapterAbi, functionName: "adaptedToken" } as const,
    { address: a, abi: adapterAbi, functionName: "wrappedToken" } as const,
  ]),
});
/// token address (lowercase) → the address to name as its fee currency.
const feeCurrencyOf = new Map<string, Address>();
feeCurrencies.forEach((entry, i) => {
  const [a, w] = [adapted[2 * i], adapted[2 * i + 1]];
  const underlying = a.status === "success" ? a.result : w.status === "success" ? w.result : entry;
  feeCurrencyOf.set(String(underlying).toLowerCase(), entry);
});

const tokens = DIRECT_TOKENS.map((t, i) => {
  const decimals = Number(tokenReads[2 * i]);
  if (decimals !== t.decimals) fail(`${t.symbol} has ${decimals} decimals on-chain, the backend table says ${t.decimals}`);
  const currency = CURRENCY[t.symbol] ?? fail(`no currency for ${t.symbol}: add it to CURRENCY`);
  return {
    symbol: t.symbol,
    address: getAddress(t.address),
    decimals,
    currency,
    /// Whether V5 takes it for a new Direct schedule right now.
    directAllowed: tokenReads[2 * i + 1] as boolean,
    feeCurrency: feeCurrencyOf.get(t.address.toLowerCase()) ?? null,
  };
});

// /agent lists what the contract accepts. If the two disagree, one of them is
// stale, and a manifest written from either would be wrong.
const advertised = new Set<string>(agent.receiving?.assets ?? []);
const allowed = new Set(tokens.filter((t) => t.directAllowed).map((t) => t.symbol));
if ([...advertised].sort().join() !== [...allowed].sort().join()) {
  fail(`/agent advertises ${[...advertised].join(", ")} but V5 allows ${[...allowed].join(", ")}`);
}

const endpoints = new Map<string, string>(
  (agent.services ?? []).map((s: { endpoint: string }) => [s.endpoint.split("/").pop()!, s.endpoint]),
);
const functions: Record<string, string> = { base: FUNCTIONS };
for (const name of PUBLIC_FUNCTIONS) {
  const url = endpoints.get(name) ?? fail(`/agent lists no ${name} service`);
  if (!url.startsWith(`${FUNCTIONS}/`)) fail(`${name} is served from ${url}, outside ${FUNCTIONS}`);
  functions[name] = url;
}

const manifest = {
  version: 1,
  generatedBy: "scripts/build-deployments.ts, from /functions/v1/agent and chain reads. Do not edit by hand.",
  chain: { name: "Celo", chainId, caip2: `eip155:${chainId}`, rpc: RPC },
  contracts: {
    RemessoExecutorV5: {
      address: v5,
      deployBlock: V5_DEPLOY_BLOCK,
      /// The hot key that signs runs, read from the contract.
      executor: getAddress(executor),
      /// Stored as a schedule's trigger, it means "whoever is the executor now".
      currentExecutorSentinel: sentinel,
    },
    RemessoAgentAllowance: { address: getAddress(AGENT_ALLOWANCE.address), deployBlock: AGENT_ALLOWANCE.deployBlock },
    ERC8004IdentityRegistry: { address: registry },
  },
  tokens,
  functions,
  app: { origin: APP, mcp: `${APP}/mcp` },
};

const body = JSON.stringify(manifest, null, 2) + "\n";
if (check) {
  let current = "";
  try {
    current = await Deno.readTextFile(OUT);
  } catch {
    fail(`${OUT} is missing; run without --check to write it`);
  }
  if (current !== body) {
    const was = JSON.parse(current);
    const changed = Object.keys(manifest).filter(
      (k) => JSON.stringify(was[k]) !== JSON.stringify((manifest as Record<string, unknown>)[k]),
    );
    fail(`${OUT} has drifted from the deployment (${changed.join(", ") || "formatting"}); re-run without --check`);
  }
  console.log(`${OUT} matches the deployment`);
} else {
  await Deno.mkdir("deployments", { recursive: true });
  await Deno.writeTextFile(OUT, body);
  console.log(`wrote ${OUT}: ${tokens.length} tokens, ${tokens.filter((t) => t.directAllowed).length} allowed on V5`);
}
