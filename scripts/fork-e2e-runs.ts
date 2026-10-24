/// The real `execute-due-runs`, end to end, against a fork of Celo mainnet and
/// a local Supabase. Step 1's "done when" for the money path:
///
///   1. a due run is delivered, recorded at the amount that arrived (after the
///      fee), and its nonce is kept on the executor lease;
///   2. a run that reverts after it was signed is recorded as failed, never as
///      delivered (the sender revokes the allowance while it sits in the
///      mempool, at a higher fee, so it is mined first);
///   3. an invocation killed after broadcasting leaves a row the next pass
///      settles from its hash;
///   4. an invocation killed before sending leaves a row the next pass fails
///      as abandoned, and the schedule then runs again.
///
/// Needs, on this machine:
///   anvil --fork-url https://forno.celo.org --port 8546
///   supabase start -x studio,imgproxy,realtime,storage-api,logflare,vector,edge-runtime,mailpit,supavisor,postgres-meta
///
///   deno run --allow-all scripts/fork-e2e-runs.ts
///
/// It signs with the real executor key, so it refuses unless the RPC is anvil
/// and the database is local, and it writes only to that local database.
import postgres from "npm:postgres@3.4.5";
import { encodeFunctionData, type Hex, parseAbi, toHex } from "npm:viem@2";

const RPC = "http://127.0.0.1:8546";
const FN = "http://127.0.0.1:8000/";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const env: Record<string, string> = {};
for (const line of (await Deno.readTextFile(".env")).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
}

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

if (!/anvil/i.test(await rpc<string>("web3_clientVersion").catch(() => ""))) {
  console.error(`refusing: ${RPC} is not anvil. Start the fork first.`);
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
const V5 = env.REMESSO_EXECUTOR_ADDRESS as Hex;
const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";
const SENDER = "0x5b156fe262b54c236563428c56839d8457a5542c";
const DEST = "0xfd1a3980f7473bdfe7461e78adde78c33d7b006b";
const AMOUNT = 20_000n; // 0.02 USA₮; the backend minimum is lifted for the test
const NET = "19950"; // less 25bps, rounded up as V5 rounds the fee

const abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function createSchedule(address destination, uint128 amountIn, uint64 interval, uint96 minRateE6, uint32 maxRuns, uint64 expiresAt, uint64 firstRunAt, uint8 payoutType, address token, address payoutToken, address trigger, uint16 triggersLeft) returns (uint256)",
  "function nextScheduleId() view returns (uint256)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// A block a second, like Celo. Anvil otherwise mines only when a transaction
/// arrives, so a run waiting for two confirmations would never get its second.
/// Paused (no blocks at all) while a test stages what goes into the next one.
const mining = (on: boolean) => rpc("evm_setIntervalMining", [on ? 1 : 0]);

async function mined(hash: Hex) {
  for (let i = 0; i < 100; i++) {
    const r = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await sleep(200);
  }
  throw new Error(`${hash} was never mined`);
}
async function inMempool(hash: string) {
  for (let i = 0; i < 150; i++) {
    if (await rpc("eth_getTransactionByHash", [hash])) return;
    await sleep(100);
  }
  throw new Error(`${hash} never reached the node`);
}
async function sendAs(from: string, to: string, data: Hex, fees: Record<string, string> = {}, wait = true) {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from, to, data, ...fees }]);
  if (wait && (await mined(hash)).status !== "0x1") throw new Error(`setup transaction ${hash} failed`);
  return hash;
}
const approve = (amount: bigint, fees: Record<string, string> = {}, wait = true) =>
  sendAs(SENDER, USAT, encodeFunctionData({ abi, functionName: "approve", args: [V5, amount] }), fees, wait);
async function warp(secs: number) {
  await rpc("evm_increaseTime", [secs]);
  await rpc("evm_mine");
}

await rpc("evm_setAutomine", [false]);
await mining(true);

// --- fork: two schedules, due now ------------------------------------------
await rpc("anvil_impersonateAccount", [SENDER]);
await rpc("anvil_setBalance", [SENDER, toHex(10n ** 18n)]);
await approve(AMOUNT * 50n);
const head = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
const ids: bigint[] = [];
for (let i = 0; i < 2; i++) {
  await sendAs(SENDER, V5, encodeFunctionData({
    abi,
    functionName: "createSchedule",
    args: [DEST, AMOUNT, 300n, 0n, 10, BigInt(head.timestamp) + 7n * 86_400n, 0n, 2, USAT, ZERO, ZERO, 0],
  }));
  const next = await rpc<Hex>("eth_call", [{ to: V5, data: encodeFunctionData({ abi, functionName: "nextScheduleId" }) }, "latest"]);
  ids.push(BigInt(next) - 1n);
}
console.log(`fork: schedules #${ids[0]} and #${ids[1]}, 0.02 USA₮ every 5 minutes`);

// --- local database: the mirror rows the app would have written --------------
await sql`truncate public.runs, public.schedules, public.recipients, public.senders, public.executor_leases cascade`;
const [sender] = await sql`insert into public.senders (wallet_address) values (${SENDER}) returning id`;
const [recipient] = await sql`
  insert into public.recipients (sender_id, display_name, payout_type, wallet_address)
  values (${sender.id}, 'fork test', 'direct', ${DEST}) returning id`;
const rows: string[] = [];
for (const [i, id] of ids.entries()) {
  const [row] = await sql`
    insert into public.schedules (sender_id, recipient_id, onchain_id, chain_id, amount_in, interval_seconds,
      min_rate_e6, max_runs, expires_at, next_run_at, status, executor_address, token_address)
    values (${sender.id}, ${recipient.id}, ${id.toString()}, 42220, ${AMOUNT.toString()}, 300, 0, 10,
      now() + interval '7 days', now() + interval '1 day', 'active', ${V5}, ${USAT})
    returning id`;
  rows.push(row.id);
}
const [s1, s2] = rows;

// --- the function, as the cron would call it --------------------------------
let fn: Deno.ChildProcess | null = null;
async function start() {
  fn = new Deno.Command("deno", {
    args: ["run", "--allow-all", "supabase/functions/execute-due-runs/index.ts"],
    env: {
      SUPABASE_URL: status.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      CELO_RPC_URL: RPC,
      REMESSO_EXECUTOR_ADDRESS: V5,
      EXECUTOR_PRIVATE_KEY: env.EXECUTOR_PRIVATE_KEY,
      CNGN_API_KEY: env.CNGN_API_KEY,
      CNGN_ENCRYPTION_KEY: env.CNGN_ENCRYPTION_KEY,
      CNGN_SSH_PRIVATE_KEY: env.CNGN_SSH_PRIVATE_KEY,
      ATTRIBUTION_CODE: env.ATTRIBUTION_CODE ?? "",
      MIN_RUN_AMOUNT_USD: "0",
    },
    stdout: "null",
    stderr: "null",
  }).spawn();
  // A plain connection, not a request: the handler ignores the method, so any
  // request would start a pass.
  for (let i = 0; i < 100; i++) {
    try {
      (await Deno.connect({ hostname: "127.0.0.1", port: 8000 })).close();
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("execute-due-runs did not start");
}
/// Killed, and waited for: until it has exited it still holds the port, and a
/// readiness check would connect to the dying process.
async function stop() {
  const p = fn;
  fn = null;
  if (!p) return;
  try {
    p.kill("SIGKILL");
  } catch { /* already gone */ }
  await p.status;
}
const pass = () => fetch(FN, { method: "POST" }).then((r) => r.json());
const latestRun = async (schedule: string) =>
  (await sql`select * from public.runs where schedule_id = ${schedule} order by started_at desc limit 1`)[0];
/// The newest row of `schedule` once it has a hash, then once that hash is at
/// the node: the hash is saved before the broadcast, so seeing it in the
/// database doesn't yet mean the transaction was sent.
async function waitForBroadcast(schedule: string, after: Date) {
  for (let i = 0; i < 150; i++) {
    const r = await latestRun(schedule);
    if (r?.tx_hash && new Date(r.started_at) > after) {
      await inMempool(r.tx_hash);
      return r;
    }
    await sleep(200);
  }
  throw new Error("the run never got a hash");
}
const leaseNonce = async () => (await sql`select last_nonce from public.executor_leases`)[0]?.last_nonce;

await start();

// 1. A due run -----------------------------------------------------------
console.log("\n1. a due run");
await sql`update public.schedules set next_run_at = now() - interval '1 minute' where id = ${s1}`;
const p1 = await pass();
const r1 = await latestRun(s1);
check(r1?.status === "delivered", `recorded delivered (${r1?.status})`);
check(r1?.amount_out === NET, `amount_out is what arrived: ${r1?.amount_out}`);
check(Boolean(r1?.tx_hash && r1?.block_number && r1?.gas_used), "hash, block and gas recorded");
const nonce1 = await leaseNonce();
check(nonce1 !== undefined && nonce1 !== null, `the lease keeps the mined nonce (${nonce1})`);
const [m1] = await sql`select next_run_at from public.schedules where id = ${s1}`;
check(new Date(m1.next_run_at).getTime() > Date.now(), "the mirror's next date moved on");
check(Array.isArray(p1.results), "the pass answered");

// 2. A run that reverts after it was signed -----------------------------------
console.log("\n2. a run that reverts on-chain");
await warp(301);
await sql`update public.schedules set next_run_at = now() - interval '1 minute' where id = ${s1}`;
await mining(false);
let mark = new Date();
const p2 = pass();
const signed = await waitForBroadcast(s1, mark);
// Higher tip than the run, so anvil orders it first: the run then finds no
// allowance and reverts, though it simulated cleanly when it was signed.
const revoke = await approve(
  0n,
  { maxPriorityFeePerGas: toHex(500n * 10n ** 9n), maxFeePerGas: toHex(1000n * 10n ** 9n) },
  false,
);
await inMempool(revoke);
await rpc("evm_mine");
await mining(true);
await p2;
const r2 = await latestRun(s1);
const rec2 = await rpc<{ status: string }>("eth_getTransactionReceipt", [signed.tx_hash]);
check(rec2?.status === "0x0", "the run was mined and reverted");
check(r2?.status === "failed", `recorded failed, not delivered (${r2?.status})`);
check(r2?.failure_reason === `run reverted on-chain in ${signed.tx_hash}`, `reason: ${r2?.failure_reason}`);
check(Boolean(r2?.block_number && r2?.gas_used), "its block and gas are kept");
check(Number(await leaseNonce()) === Number(nonce1) + 1, "a reverted run's nonce still counts as used");

// 3. Killed after broadcasting --------------------------------------------
console.log("\n3. an invocation killed after broadcasting");
await approve(AMOUNT * 50n);
await warp(301);
await sql`update public.schedules set next_run_at = now() - interval '1 minute' where id = ${s1}`;
// Two minutes after the reverted run's failure, so the backoff is over.
await sql`update public.runs set settled_at = now() - interval '2 minutes' where schedule_id = ${s1} and status = 'failed'`;
await mining(false);
mark = new Date();
pass().catch(() => {}); // the connection dies with the function
const sent = await waitForBroadcast(s1, mark);
await stop();
await rpc("evm_mine");
await mining(true);
check(sent.status === "swapping", "the dead invocation left the row swapping, with its hash");
await start();
await sql`update public.runs set started_at = now() - interval '11 minutes' where id = ${sent.id}`;
await sql`update public.executor_leases set expires_at = now() - interval '1 second'`; // as if its TTL ran out
const p3 = await pass();
const r3 = (await sql`select * from public.runs where id = ${sent.id}`)[0];
check(p3.recovered?.some((x: { run: string; action: string }) => x.run === sent.id && x.action === "settle"), "the next pass recovered it");
check(r3.status === "delivered" && r3.amount_out === NET, `settled from its receipt: ${r3.status}, ${r3.amount_out}`);

// 4. Killed before sending ------------------------------------------------
console.log("\n4. an invocation killed before sending");
const [ghost] = await sql`
  insert into public.runs (schedule_id, sender_id, attempt, amount_in, status, started_at)
  values (${s2}, ${sender.id}, 1, ${AMOUNT.toString()}, 'pending', now() - interval '20 minutes')
  returning id`;
await sql`update public.schedules set next_run_at = now() - interval '1 minute' where id = ${s2}`;
const p4 = await pass();
const r4 = (await sql`select * from public.runs where id = ${ghost.id}`)[0];
check(p4.recovered?.some((x: { run: string }) => x.run === ghost.id), "the next pass looked at it");
check(r4.status === "failed" && r4.failure_reason === "abandoned before sending", `failed as abandoned (${r4.failure_reason})`);
// The one-minute backoff after a failure, passed.
await sql`update public.runs set settled_at = now() - interval '2 minutes' where id = ${ghost.id}`;
await pass();
const r5 = await latestRun(s2);
check(r5.id !== ghost.id && r5.status === "delivered" && r5.amount_out === NET, `the schedule ran again: ${r5.status}, ${r5.amount_out}`);

await stop();
await sql.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
