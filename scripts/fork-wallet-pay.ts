/// Step 2's "done when" for the local MCP wallet, on a fork of Celo mainnet:
/// a payment retried with the same key pays once, and a wallet pointed at the
/// wrong chain refuses to sign.
///
///   anvil --fork-url https://forno.celo.org --port 8546    # the fork
///   anvil --chain-id 1337 --port 8547                      # some other chain
///   deno run --allow-all scripts/fork-wallet-pay.ts
///
/// It drives the real server (`mcp/src/server.mjs`) over stdio, as an agent's
/// host does, with a fresh agent key in a temporary home. On the fork it
/// impersonates V5 schedule #1's sender, who still holds 0.287 USA₮, to give
/// that agent a policy. Nothing here touches mainnet: the RPCs are checked to
/// be anvil first.
import {
  concat,
  createPublicClient,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
  toHex,
} from "npm:viem@2";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";

const FORK = "http://127.0.0.1:8546";
const OTHER = "http://127.0.0.1:8547";
const ALLOWANCE = "0xA6351fAeEb097698289586C4D6188530300DB209";
const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";
const OWNER = "0x5b156fe262B54c236563428c56839D8457A5542c";
const DEST = "0xFd1a3980f7473bdFE7461e78ADDe78c33d7b006b";
// The ERC-8021 suffix the server appends, so hand-signed records match its own.
const ATTRIBUTION = "0x72656d6573736f2c63656c6f5f356364333563613535626166190080218021802180218021802180218021";

async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
for (const url of [FORK, OTHER]) {
  if (!/anvil/i.test(await rpc<string>(url, "web3_clientVersion").catch(() => ""))) {
    console.error(`refusing: ${url} is not anvil. Start both anvils first (see the top of this file).`);
    Deno.exit(1);
  }
}
const fork = (m: string, p: unknown[] = []) => rpc(FORK, m, p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function createPolicy(address agent, address token, uint128 perPayment, uint128 perDay, uint64 expiresAt, bool allowlistOnly, address[] recipients) returns (uint256)",
  "function nextPolicyId() view returns (uint256)",
  "function pay(uint256 id, address to, uint256 amount, bytes32 memo)",
]);
const chain = createPublicClient({ chain: celo, transport: http(FORK) });
const balance = () => chain.readContract({ address: USAT, abi, functionName: "balanceOf", args: [DEST] });

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

async function mined(hash: Hex) {
  for (let i = 0; i < 100; i++) {
    const r = await fork("eth_getTransactionReceipt", [hash]) as { status: string } | null;
    if (r) return r;
    await sleep(200);
  }
  throw new Error(`${hash} never mined`);
}
async function sendAs(from: string, to: string, data: Hex) {
  const hash = await fork("eth_sendTransaction", [{ from, to, data }]) as Hex;
  if ((await mined(hash)).status !== "0x1") throw new Error(`setup transaction ${hash} failed`);
}

// --- a fresh agent with a policy ------------------------------------------
await fork("evm_setIntervalMining", [0]);
await fork("evm_setAutomine", [true]);
const home = await Deno.makeTempDir({ prefix: "remesso-agent-" });
const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
await Deno.writeTextFile(`${home}/agent-key.json`, JSON.stringify({ privateKey: agentKey, createdAt: new Date().toISOString() }), { mode: 0o600 });
// The file as wallets before 2026-10-25 wrote it: one deployment's state.
await Deno.writeTextFile(`${home}/config.json`, JSON.stringify({ policies: [], scannedTo: 3 }), { mode: 0o600 });

await fork("anvil_impersonateAccount", [OWNER]);
await fork("anvil_setBalance", [OWNER, toHex(10n ** 18n)]);
await fork("anvil_setBalance", [agent.address, toHex(10n ** 18n)]);
await sendAs(OWNER, USAT, encodeFunctionData({ abi, functionName: "approve", args: [ALLOWANCE, 200_000n] }));
const head = await chain.getBlock();
await sendAs(OWNER, ALLOWANCE, encodeFunctionData({
  abi,
  functionName: "createPolicy",
  args: [agent.address, USAT, 50_000n, 200_000n, head.timestamp + 7n * 86_400n, false, []],
}));
const policyId = (await chain.readContract({ address: ALLOWANCE, abi, functionName: "nextPolicyId" })) - 1n;
console.log(`fork: agent ${agent.address}, policy #${policyId}: 0.05 USA₮ a payment, 0.2 a day`);

// --- the server, as an agent's host runs it ------------------------------
function server(rpcUrl: string, dir: string) {
  const p = new Deno.Command("node", {
    args: ["mcp/src/server.mjs"],
    env: { REMESSO_RPC_URL: rpcUrl, REMESSO_AGENT_HOME: dir },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = p.stdin.getWriter();
  const lines = p.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let id = 0;
  const waiting = new Map<number, (v: unknown) => void>();
  (async () => {
    for (;;) {
      const { value, done } = await lines.read();
      if (done) return;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        waiting.get(msg.id)?.(msg);
      }
    }
  })();
  const send = (o: unknown) => w.write(new TextEncoder().encode(JSON.stringify(o) + "\n"));
  const call = (method: string, params: unknown) =>
    new Promise<{ result?: { content: { text: string }[]; isError?: boolean } }>((resolve) => {
      waiting.set(++id, resolve as (v: unknown) => void);
      send({ jsonrpc: "2.0", id, method, params });
    });
  return {
    async init() {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fork-test", version: "1" } });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async tool(name: string, args: Record<string, unknown> = {}) {
      const r = await call("tools/call", { name, arguments: args });
      return { text: r.result?.content?.[0]?.text ?? "", error: Boolean(r.result?.isError) };
    },
    stop() {
      try {
        p.kill("SIGKILL");
      } catch { /* gone */ }
    },
  };
}

const s = server(FORK, home);
await s.init();
const payments = async () => JSON.parse(await Deno.readTextFile(`${home}/payments.json`)).payments as Record<string, unknown>[];

// --- 1. the old state file moves under its deployment ----------------------
console.log("\n1. state keyed by chain and contract");
const w = await s.tool("wallet");
check(!w.error, "wallet answers");
const state = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
const section = state.deployments?.[`42220:${ALLOWANCE.toLowerCase()}`];
check(state.version === 2 && Boolean(section), "config.json migrated to one section per deployment");
check(section?.policies?.includes(Number(policyId)) && section.scannedTo >= Number(policyId), `the old scan position carried over and the new policy was found (#${policyId})`);

// --- 2–7. keys, repeats and memos ----------------------------------------
console.log("\n2–7. a payment retried with its key pays once");
let before = await balance();
const a = await s.tool("pay", { to: DEST, amount: "0.01", token: "USAT", idempotency_key: "invoice-1" });
check(!a.error && (await balance()) - before === 10_000n, "a keyed payment pays 0.01");
before = await balance();
const again = await s.tool("pay", { to: DEST, amount: "0.01", token: "USAT", idempotency_key: "invoice-1" });
check(!again.error && /already paid/.test(again.text) && (await balance()) === before, "the same key again pays nothing and reports the first payment");
const changed = await s.tool("pay", { to: DEST, amount: "0.02", token: "USAT", idempotency_key: "invoice-1" });
check(changed.error && /different payment/.test(changed.text) && (await balance()) === before, "the same key for a different payment is refused");
const bare = await s.tool("pay", { to: DEST, amount: "0.01", token: "USAT" });
check(bare.error && /identical payment/.test(bare.text) && (await balance()) === before, "the same payment without a key, minutes later, is refused");
const meant = await s.tool("pay", { to: DEST, amount: "0.01", token: "USAT", allow_repeat: true });
check(!meant.error && (await balance()) - before === 10_000n, "with allow_repeat it pays");
before = await balance();
const long = await s.tool("pay", { to: DEST, amount: "0.01", token: "USAT", memo: "é".repeat(17), idempotency_key: "memo-1" });
check(long.error && /34 bytes/.test(long.text) && (await balance()) === before, "a 17-character memo of 34 bytes is refused, not cut");

// --- 8. a call that timed out, retried -----------------------------------
console.log("\n8. a payment whose call timed out (about 45 seconds)");
await fork("evm_setAutomine", [false]);
before = await balance();
const slow = await s.tool("pay", { to: DEST, amount: "0.011", token: "USAT", idempotency_key: "invoice-2" });
check(!slow.error && /pending/.test(slow.text), "no receipt in time: answered pending, with the hash");
await fork("evm_mine");
await fork("evm_setAutomine", [true]);
const settled = await s.tool("pay", { to: DEST, amount: "0.011", token: "USAT", idempotency_key: "invoice-2" });
check(!settled.error && /already paid/.test(settled.text) && (await balance()) - before === 11_000n, "the retry finds it landed: paid once");

// Signs a pay() the way the server does, without sending it.
async function handSigned(amount: bigint, nonce: number) {
  const data = concat([encodeFunctionData({ abi, functionName: "pay", args: [policyId, DEST, amount, `0x${"0".repeat(64)}`] }), ATTRIBUTION]);
  const gas = await chain.estimateGas({ account: agent.address, to: ALLOWANCE, data });
  const fees = await chain.estimateFeesPerGas();
  const raw = await agent.signTransaction({ chainId: 42220, to: ALLOWANCE, data, nonce, gas: gas * 2n, ...fees });
  return { raw, hash: keccak256(raw) };
}
async function plantRecord(key: string, amount: bigint, nonce: number) {
  const { raw, hash } = await handSigned(amount, nonce);
  const list = await payments();
  list.push({
    key, deployment: `42220:${ALLOWANCE.toLowerCase()}`, policyId: Number(policyId), to: DEST, units: amount.toString(),
    token: "USAT", memo: `0x${"0".repeat(64)}`, hash, nonce, raw, status: "sent", at: new Date().toISOString(),
  });
  await Deno.writeTextFile(`${home}/payments.json`, JSON.stringify({ version: 1, payments: list }, null, 2));
  return hash;
}
const pendingNonce = async () => chain.getTransactionCount({ address: agent.address, blockTag: "pending" });

// --- 9. signed and recorded, never sent ------------------------------------
console.log("\n9. a payment recorded but never broadcast (the process died)");
before = await balance();
await plantRecord("invoice-3", 12_000n, await pendingNonce());
const resumed = await s.tool("pay", { to: DEST, amount: "0.012", token: "USAT", idempotency_key: "invoice-3" });
check(!resumed.error && /never reached the network/.test(resumed.text) && (await balance()) - before === 12_000n, "the retry sends the recorded bytes: paid once");

// --- 10. never sent, and its nonce went to another payment --------------------
console.log("\n10. a recorded payment whose nonce another payment took");
before = await balance();
await plantRecord("invoice-4", 13_000n, await pendingNonce());
const other = await s.tool("pay", { to: DEST, amount: "0.014", token: "USAT", idempotency_key: "invoice-5" });
check(!other.error && (await balance()) - before === 14_000n, "another payment takes that nonce");
const fresh = await s.tool("pay", { to: DEST, amount: "0.013", token: "USAT", idempotency_key: "invoice-4" });
check(!fresh.error && (await balance()) - before === 27_000n, "the first can never land, so the retry pays it once, fresh");
s.stop();

// --- 11. the wrong chain ----------------------------------------------------
console.log("\n11. a wallet pointed at another chain");
const elsewhere = server(OTHER, await Deno.makeTempDir({ prefix: "remesso-agent-" }));
await elsewhere.init();
const refused = await elsewhere.tool("pay", { to: DEST, amount: "0.01", token: "USAT", idempotency_key: "x" });
check(refused.error && /not Celo mainnet/.test(refused.text), "it refuses to sign");
elsewhere.stop();

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
