/// Agent to agent, end to end: a payment request reaches an agent's inbox,
/// the agent pays it, the indexer binds the payment to the request by its
/// memo, and the request reads paid. A retry pays nothing.
///
///   anvil --fork-url https://forno.celo.org --port 8546
///   supabase start -x studio,imgproxy,realtime,storage-api,logflare,vector,edge-runtime,mailpit,supavisor,postgres-meta
///   deno run --allow-all scripts/fork-agent-to-agent.ts
///
/// The real pieces: the plugin wallet (`mcp/src/server.mjs`, over stdio),
/// `request-payment` and `index-events`, run locally against the fork and the
/// local database. On the fork it impersonates V5 schedule #1's sender to give
/// a fresh agent a policy. It refuses unless the RPC is anvil and the database
/// is local.
import postgres from "npm:postgres@3.4.5";
import { createPublicClient, encodeFunctionData, http, parseAbi, toHex } from "npm:viem@2";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";

const FORK = "http://127.0.0.1:8546";
const FN = "http://127.0.0.1:8000";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ALLOWANCE = "0xA6351fAeEb097698289586C4D6188530300DB209";
const V5 = "0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8";
const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";
const OWNER = "0x5b156fe262B54c236563428c56839D8457A5542c";
const DEST = "0xFd1a3980f7473bdFE7461e78ADDe78c33d7b006b";

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
if (!/anvil/i.test(await rpc<string>("web3_clientVersion").catch(() => ""))) {
  console.error("refusing: start the fork first (see the top of this file)");
  Deno.exit(1);
}
const status = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command("supabase", { args: ["status", "-o", "json"], stderr: "null" }).output()).stdout,
));
if (status.API_URL !== "http://127.0.0.1:54321") {
  console.error("refusing: the local Supabase API is not running on 127.0.0.1:54321");
  Deno.exit(1);
}

const sql = postgres(DB_URL, { onnotice: () => {} });
const chain = createPublicClient({ chain: celo, transport: http(FORK) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function createPolicy(address agent, address token, uint128 perPayment, uint128 perDay, uint64 expiresAt, bool allowlistOnly, address[] recipients) returns (uint256)",
]);
const balance = () => chain.readContract({ address: USAT, abi, functionName: "balanceOf", args: [DEST] });

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

async function sendAs(from: string, to: string, data: `0x${string}`) {
  const hash = await rpc<`0x${string}`>("eth_sendTransaction", [{ from, to, data }]);
  for (let i = 0; i < 50; i++) {
    const r = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== "0x1") throw new Error(`setup transaction ${hash} failed`);
      return;
    }
    await sleep(200);
  }
  throw new Error(`setup transaction ${hash} never mined`);
}

/// A backend function on :8000, as the platform runs it, reading the fork.
async function serve(name: string) {
  const p = new Deno.Command("deno", {
    args: ["run", "--allow-all", `supabase/functions/${name}/index.ts`],
    env: { SUPABASE_URL: status.API_URL, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, CELO_RPC_URL: FORK },
    stdout: "null",
    stderr: "null",
  }).spawn();
  for (let i = 0; i < 150; i++) {
    try {
      (await Deno.connect({ hostname: "127.0.0.1", port: 8000 })).close();
      return async () => {
        p.kill("SIGKILL");
        await p.status;
      };
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`${name} did not start`);
}

/// The plugin wallet over stdio, as an agent's host runs it.
function wallet(home: string) {
  const p = new Deno.Command("node", {
    args: ["mcp/src/server.mjs"],
    env: { REMESSO_RPC_URL: FORK, REMESSO_FUNCTIONS_URL: FN, REMESSO_AGENT_HOME: home },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = p.stdin.getWriter();
  const out = p.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let id = 0;
  const waiting = new Map<number, (v: { result?: { content: { text: string }[]; isError?: boolean } }) => void>();
  (async () => {
    for (;;) {
      const { value, done } = await out.read();
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
      waiting.set(++id, resolve);
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

// --- the stage ---------------------------------------------------------
await rpc("evm_setIntervalMining", [0]);
await rpc("evm_setAutomine", [true]);
await sql`truncate public.payment_events, public.payment_requests cascade`;
const head = await chain.getBlock();
// The indexer starts at the fork's head, so it reads only what happens here.
for (const c of [V5, ALLOWANCE]) {
  await sql`update public.chain_cursors set block_number = ${head.number.toString()}, block_hash = ${head.hash} where contract = ${c.toLowerCase()}`;
}

const home = await Deno.makeTempDir({ prefix: "remesso-agent-" });
const key = generatePrivateKey();
const agent = privateKeyToAccount(key);
await Deno.writeTextFile(`${home}/agent-key.json`, JSON.stringify({ privateKey: key, createdAt: new Date().toISOString() }), { mode: 0o600 });
await rpc("anvil_impersonateAccount", [OWNER]);
await rpc("anvil_setBalance", [OWNER, toHex(10n ** 18n)]);
await rpc("anvil_setBalance", [agent.address, toHex(10n ** 18n)]);
await sendAs(OWNER, USAT, encodeFunctionData({ abi, functionName: "approve", args: [ALLOWANCE, 200_000n] }));
await sendAs(OWNER, ALLOWANCE, encodeFunctionData({
  abi,
  functionName: "createPolicy",
  args: [agent.address, USAT, 50_000n, 200_000n, head.timestamp + 7n * 86_400n, false, []],
}));
const [pay1] = await sql`
  insert into public.payment_requests (payer_address, to_address, amount, token_symbol, from_name, note, created_at)
  values (${OWNER.toLowerCase()}, ${DEST.toLowerCase()}, '0.02', 'USA₮', 'invoicing agent', 'October hosting', now() - interval '1 minute')
  returning id, reference`;
const [pay2] = await sql`
  insert into public.payment_requests (payer_address, to_address, amount, token_symbol, from_name, created_at)
  values (${OWNER.toLowerCase()}, ${DEST.toLowerCase()}, '0.03', 'USA₮', 'someone unknown', now() - interval '1 minute')
  returning id`;
console.log(`fork: agent ${agent.address} with a USA₮ policy; two requests to its human's wallet`);

// --- 1. the inbox, paying one, declining the other ----------------------------
console.log("\n1. the agent's inbox");
let stop = await serve("request-payment");
const w = wallet(home);
await w.init();
const inbox = await w.tool("payment_requests");
check(!inbox.error && inbox.text.includes(pay1.id) && inbox.text.includes(pay2.id), "payment_requests lists both requests addressed to its human");

let before = await balance();
const paid = await w.tool("pay", { request_id: pay1.id });
check(!paid.error && (await balance()) - before === 20_000n, "pay with request_id: 0.02 USA₮ paid, the request's own terms");
const declined = await w.tool("decline_request", { request_id: pay2.id });
const [r2] = await sql`select status from public.payment_requests where id = ${pay2.id}`;
check(!declined.error && r2.status === "declined", "decline_request: signed by the agent under its human's policy, and recorded");
await stop();

// --- 2. the indexer binds the payment to the request ---------------------------
console.log("\n2. the indexer reads the payment and binds it");
stop = await serve("index-events");
const pass = await (await fetch(FN, { method: "POST" })).json();
check(pass.requestsBound === 1, `one request bound by its memo (${pass.requestsBound})`);
const [ev] = await sql`select memo_text, amount, from_address, agent from public.payment_events where kind = 'policy_payment'`;
check(ev?.memo_text === pay1.reference && ev.amount === "20000" && ev.agent === agent.address.toLowerCase(),
  "the event: the request's reference as the memo, 20,000 units, paid by the agent from its human's wallet");
await stop();

// --- 3. the requester's view, and a retry ---------------------------------------
console.log("\n3. what the requester sees");
stop = await serve("request-payment");
const st = await (await fetch(FN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "status", id: pay1.id }) })).json();
check(st.status === "accepted" && st.payment?.state === "paid" && st.payment.txs?.length === 1, `status: ${st.status}, payment ${st.payment?.state}, one transaction`);
before = await balance();
const again = await w.tool("pay", { request_id: pay1.id });
check(!again.error && /already paid/.test(again.text) && (await balance()) === before, "paying the same request again pays nothing");
w.stop();
await stop();

await sql.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
