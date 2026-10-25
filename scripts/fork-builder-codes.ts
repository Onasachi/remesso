/// Builder codes (Phase 6) end to end, on a fork of Celo mainnet and a local
/// Supabase, with the real `index-events` and `execute-due-runs`:
///
///   1. two schedules from remesso-sdk, one created with `builderCodes` and
///      one without, both due now;
///   2. `execute-due-runs` runs them before `index-events` has recorded
///      them, as an early send in a schedule's first minute can: the codes
///      are found on the chain;
///   3. `index-events` records them, with the integrator's codes;
///   4. an hour later the second runs carry what the indexer stored.
///
/// Every transaction is checked with the attribution SDK's own `verifyTx`.
/// `trigger-run` signs through the same `signRun` and `codesForRun`, but
/// it settles an x402 payment first, which a fork can't, so it isn't run here.
///
///   anvil --fork-url https://forno.celo.org --port 8546
///   supabase start -x studio,imgproxy,realtime,storage-api,logflare,vector,edge-runtime,mailpit,supavisor,postgres-meta
///   deno run --allow-all --config packages/remesso-sdk/deno.json --unstable-sloppy-imports scripts/fork-builder-codes.ts
///
/// It signs with the real executor key, so it refuses unless the RPC is anvil
/// and the database is local, and it writes only to that local database.
import { verifyTx } from "npm:@celo/attribution-tags@0.5.0";
import postgres from "npm:postgres@3.4.5";
import { createPublicClient, encodeFunctionData, type Hex, http, parseAbi, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { createRemesso } from "../packages/remesso-sdk/src/index.ts";

const FORK = "http://127.0.0.1:8546";
const FN = "http://127.0.0.1:8000";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const V5 = "0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8";
const ALLOWANCE = "0xA6351fAeEb097698289586C4D6188530300DB209";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const POOL = "0x6519d56eb0a69fc0338657784c783b169b8f7d32"; // cNGN/USDT, ~94k USDT
const DEST = "0xFd1a3980f7473bdFE7461e78ADDe78c33d7b006b";
const OURS = ["remesso", "celo_5cd35ca55baf"];
const THEIRS = ["acme_app", "partner_2"];

const env: Record<string, string> = {};
for (const line of (await Deno.readTextFile(".env")).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
}

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
if (!/anvil/i.test(await rpc<string>("web3_clientVersion").catch(() => ""))) {
  console.error(`refusing: ${FORK} is not anvil. Start the fork first (see the top of this file).`);
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
const chain = createPublicClient({ chain: celo, transport: http(FORK), pollingInterval: 200 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/// The codes Celo's own SDK reads from a transaction.
const codesOf = async (hash: Hex) => (await verifyTx({ client: chain as never, hash }))?.codes ?? null;

/// A backend function on :8000, as the platform runs it, reading the fork.
async function serve(name: string) {
  const p = new Deno.Command("deno", {
    args: ["run", "--allow-all", `supabase/functions/${name}/index.ts`],
    env: {
      SUPABASE_URL: status.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      CELO_RPC_URL: FORK,
      REMESSO_EXECUTOR_ADDRESS: V5,
      EXECUTOR_PRIVATE_KEY: env.EXECUTOR_PRIVATE_KEY,
      CNGN_API_KEY: env.CNGN_API_KEY,
      CNGN_ENCRYPTION_KEY: env.CNGN_ENCRYPTION_KEY,
      CNGN_SSH_PRIVATE_KEY: env.CNGN_SSH_PRIVATE_KEY,
      ATTRIBUTION_CODE: OURS.join(","),
    },
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
const call = async (name: string) => {
  const stop = await serve(name);
  try {
    return await (await fetch(FN, { method: "POST" })).json();
  } finally {
    await stop();
  }
};

// --- the stage: a block a second, like Celo, so a run gets its confirmations ---
await rpc("evm_setAutomine", [false]);
await rpc("evm_setIntervalMining", [1]);
const payer = privateKeyToAccount(generatePrivateKey());
for (const who of [payer.address, POOL]) await rpc("anvil_setBalance", [who, toHex(10n ** 19n)]);
await rpc("anvil_impersonateAccount", [POOL]);
const fund = await rpc<Hex>("eth_sendTransaction", [{
  from: POOL, to: USDT, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [payer.address, 5_000_000n] }),
}]);
await chain.waitForTransactionReceipt({ hash: fund });

// The indexer starts at the fork's head, so it reads exactly what follows.
await sql`truncate public.runs, public.schedules, public.recipients, public.senders, public.executor_leases, public.payment_events cascade`;
const start = await chain.getBlock({ blockTag: "latest" });
for (const c of [V5, ALLOWANCE]) {
  await sql`update public.chain_cursors set block_number = ${start.number.toString()}, block_hash = ${start.hash} where contract = ${c.toLowerCase()}`;
}

// --- 1. two schedules from the SDK --------------------------------------------
console.log("1. two schedules: one created with builderCodes, one without");
const integrator = createRemesso({ account: payer, rpcUrl: FORK, publicClient: chain as never, builderCodes: THEIRS });
const plain = createRemesso({ account: payer, rpcUrl: FORK, publicClient: chain as never });
const terms = { to: DEST, amount: "1", token: "USDT", every: 3600, runs: 2 } as const;
const tagged = await integrator.schedules.create(terms);
const untagged = await plain.schedules.create(terms);
check(same(await codesOf(tagged.hash), [...OURS, ...THEIRS]), `schedule #${tagged.id}: its createSchedule carries ${[...OURS, ...THEIRS].join(", ")}`);
check(same(await codesOf(untagged.hash), OURS), `schedule #${untagged.id}: its createSchedule carries ours only`);

// The mirror rows the app or the sync would have written, due now.
const [sender] = await sql`insert into public.senders (wallet_address) values (${payer.address.toLowerCase()}) returning id`;
const [recipient] = await sql`
  insert into public.recipients (sender_id, display_name, payout_type, wallet_address)
  values (${sender.id}, 'fork test', 'direct', ${DEST.toLowerCase()}) returning id`;
const rowOf = new Map<bigint, string>();
for (const s of [tagged, untagged]) {
  const [row] = await sql`
    insert into public.schedules (sender_id, recipient_id, onchain_id, chain_id, amount_in, interval_seconds,
      min_rate_e6, max_runs, expires_at, next_run_at, status, executor_address, token_address)
    values (${sender.id}, ${recipient.id}, ${s.id.toString()}, 42220, ${s.amountIn.toString()}, 3600, 0, 2,
      now() + interval '7 days', now() - interval '1 minute', 'active', ${V5.toLowerCase()}, ${USDT.toLowerCase()})
    returning id`;
  rowOf.set(s.id, row.id);
}
const latestRun = async (id: bigint) =>
  (await sql`select status, tx_hash from public.runs where schedule_id = ${rowOf.get(id)!} order by started_at desc limit 1`)[0];

// --- 2. first runs, before the indexer has seen either schedule -----------------
console.log("\n2. the first runs, before index-events has recorded the schedules");
const [indexed] = await sql`select count(*)::int as n from public.payment_events`;
check(indexed.n === 0, "nothing indexed yet");
await call("execute-due-runs");
for (const [s, want] of [[tagged, [...OURS, ...THEIRS]], [untagged, OURS]] as const) {
  const run = await latestRun(s.id);
  check(run?.status === "delivered" && same(await codesOf(run.tx_hash), want), `schedule #${s.id}, run 1: ${run?.status}, carries ${want.join(", ")}`);
}

// --- 3. the indexer records the codes ---------------------------------------
console.log("\n3. index-events records each schedule with its integrator's codes");
const pass = await call("index-events");
check(pass.results?.every((r: { error?: string }) => !r.error), `the pass read both contracts (${JSON.stringify(pass.results?.map((r: { recorded?: number }) => r.recorded))} recorded)`);
for (const [s, want] of [[tagged, THEIRS], [untagged, []]] as const) {
  const [ev] = await sql`select details from public.payment_events where kind = 'schedule_created' and ref_id = ${s.id.toString()}`;
  check(same(ev?.details?.builderCodes, want), `schedule #${s.id}: builderCodes ${JSON.stringify(ev?.details?.builderCodes)}`);
}

// --- 4. second runs, from what the indexer stored ------------------------------
console.log("\n4. an hour later, the second runs carry what the indexer stored");
// Rewritten here, so what the run carries can only have come from the row.
await sql`update public.payment_events set details = jsonb_set(details, '{builderCodes}', '["from_the_row"]')
  where kind = 'schedule_created' and ref_id = ${tagged.id.toString()}`;
await rpc("evm_increaseTime", [3_601]);
await rpc("evm_mine");
await sql`update public.schedules set next_run_at = now() - interval '1 minute', status = 'active'`;
await call("execute-due-runs");
for (const [s, want] of [[tagged, [...OURS, "from_the_row"]], [untagged, OURS]] as const) {
  const run = await latestRun(s.id);
  check(run?.status === "delivered" && same(await codesOf(run.tx_hash), want), `schedule #${s.id}, run 2: ${run?.status}, carries ${want.join(", ")}`);
}

await sql.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
