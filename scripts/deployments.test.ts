/// Holds every hand-typed copy of the deployment to
/// `deployments/celo-mainnet.json`.
///
/// The manifest is generated from what is deployed
/// (`scripts/build-deployments.ts`). These files typed the same facts in by
/// hand before it existed, and each copy is a place a redeploy can be missed
/// (docs/agent-to-agent.md, 2a). Until every client reads the manifest
/// directly, this fails naming the file and the constant that drifted.
///
/// Offline: it reads files, never the chain. Values that come only from the
/// environment (the backend's executor, the web app's executor and allowance
/// addresses) have no hardcoded copy to compare, so they aren't here.
///
///   deno test --allow-env --allow-read --unstable-sloppy-imports scripts/deployments.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import manifest from "../deployments/celo-mainnet.json" with { type: "json" };
import * as backend from "../supabase/functions/_shared/config.ts";
import * as web from "../web/lib/config.ts";

type Token = (typeof manifest.tokens)[number];

const V5 = manifest.contracts.RemessoExecutorV5;
const ALLOWANCE = manifest.contracts.RemessoAgentAllowance.address;
const REGISTRY = manifest.contracts.ERC8004IdentityRegistry.address;

const tokenAt = (file: string, address: string): Token => {
  const t = manifest.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
  if (!t) throw new Error(`${file}: token ${address} is not in the manifest`);
  return t;
};

/// Addresses compare without case; everything else exactly.
function same(file: string, constant: string, actual: unknown, expected: unknown) {
  const norm = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v);
  assertEquals(norm(actual), norm(expected), `${file}: ${constant} is ${actual}, the manifest says ${expected}`);
}

const source = (file: string) => Deno.readTextFileSync(new URL(`../${file}`, import.meta.url));

/// One capture from a source file, or a failure that says what to do about it.
function find(file: string, src: string, re: RegExp, constant: string): string {
  const m = src.match(re);
  if (!m) {
    throw new Error(
      `${file}: no ${constant} found. If it now reads deployments/celo-mainnet.json, drop this check; ` +
        `otherwise update the pattern in scripts/deployments.test.ts.`,
    );
  }
  return m[1];
}

Deno.test("backend: supabase/functions/_shared/config.ts", () => {
  const f = "supabase/functions/_shared/config.ts";
  same(f, "CELO.chainId", backend.CELO.chainId, manifest.chain.chainId);
  same(f, "CELO.rpcUrl", backend.CELO.rpcUrl, manifest.chain.rpc);
  same(f, "CELO.usdt", backend.CELO.usdt, manifest.tokens.find((t) => t.symbol === "USDT")?.address);
  same(f, "CELO.cngn", backend.CELO.cngn, manifest.tokens.find((t) => t.symbol === "cNGN")?.address);
  // The manifest's token list is built from this table, so it must stay the
  // same list, in the same order.
  same(f, "DIRECT_TOKENS.length", backend.DIRECT_TOKENS.length, manifest.tokens.length);
  backend.DIRECT_TOKENS.forEach((t, i) => {
    same(f, `DIRECT_TOKENS[${i}].symbol`, t.symbol, manifest.tokens[i].symbol);
    same(f, `${t.symbol} address`, t.address, manifest.tokens[i].address);
    same(f, `${t.symbol} decimals`, t.decimals, manifest.tokens[i].decimals);
  });
});

Deno.test("web app: web/lib/config.ts", () => {
  const f = "web/lib/config.ts";
  same(f, "CHAIN_ID", web.CHAIN_ID, manifest.chain.chainId);
  same(f, "RPC_URL", web.RPC_URL, manifest.chain.rpc);
  same(f, "CURRENT_EXECUTOR", web.CURRENT_EXECUTOR, V5.currentExecutorSentinel);
  same(f, "DIRECT_TOKENS.length", web.DIRECT_TOKENS.length, manifest.tokens.length);
  for (const t of web.DIRECT_TOKENS) {
    const m = tokenAt(f, t.address);
    same(f, `${t.symbol} symbol`, t.symbol, m.symbol);
    same(f, `${t.symbol} decimals`, t.decimals, m.decimals);
    same(f, `${t.symbol} currency`, t.currency, m.currency);
  }
});

Deno.test("local MCP wallet: mcp/src/server.mjs", () => {
  const f = "mcp/src/server.mjs";
  const src = source(f);
  same(f, "RPC default", find(f, src, /REMESSO_RPC_URL\s*\|\|\s*"([^"]+)"/, "the RPC default"), manifest.chain.rpc);
  same(f, "FUNCTIONS", find(f, src, /const FUNCTIONS = "([^"]+)"/, "FUNCTIONS"), manifest.functions.base);
  same(f, "APP", find(f, src, /const APP = "([^"]+)"/, "APP"), manifest.app.origin);
  same(f, "ALLOWANCE", find(f, src, /REMESSO_ALLOWANCE_ADDRESS\s*\|\|\s*"(0x[0-9a-fA-F]{40})"/, "the ALLOWANCE default"), ALLOWANCE);
  same(f, "ERC8004", find(f, src, /const ERC8004 = "(0x[0-9a-fA-F]{40})"/, "ERC8004"), REGISTRY);
  const tokens = [...src.matchAll(/(\w+): \{ address: "(0x[0-9a-fA-F]{40})", decimals: (\d+), feeCurrency: "(0x[0-9a-fA-F]{40})"/g)];
  if (!tokens.length) find(f, src, /(?!)/, "the TOKENS table");
  for (const [, key, address, decimals, feeCurrency] of tokens) {
    const m = tokenAt(f, address);
    same(f, `TOKENS.${key}.decimals`, Number(decimals), m.decimals);
    same(f, `TOKENS.${key}.feeCurrency`, feeCurrency, m.feeCurrency);
  }
});

Deno.test("hosted connector: web/lib/mcp/hosted.ts", () => {
  const f = "web/lib/mcp/hosted.ts";
  const src = source(f);
  same(f, "the chain id", Number(find(f, src, /defineChain\(\{\s*id: (\d+)/, "the chain id")), manifest.chain.chainId);
  same(f, "caip2", find(f, src, /caip2: "([^"]+)"/, "caip2"), manifest.chain.caip2);
  same(f, "ALLOWANCE", find(f, src, /NEXT_PUBLIC_AGENT_ALLOWANCE_ADDRESS \?\? "(0x[0-9a-fA-F]{40})"/, "the ALLOWANCE default"), ALLOWANCE);
  const tokens = [...src.matchAll(/(\w+): \{ address: getAddress\("(0x[0-9a-fA-F]{40})"\), decimals: (\d+)/g)];
  if (!tokens.length) find(f, src, /(?!)/, "the TOKENS table");
  for (const [, key, address, decimals] of tokens) {
    same(f, `TOKENS.${key}.decimals`, Number(decimals), tokenAt(f, address).decimals);
  }
});

Deno.test("connector tools: web/lib/mcp/tools.ts", () => {
  const f = "web/lib/mcp/tools.ts";
  same(f, "ERC8004", find(f, source(f), /const ERC8004 = "(0x[0-9a-fA-F]{40})"/, "ERC8004"), REGISTRY);
});
