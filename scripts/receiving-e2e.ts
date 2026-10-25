/// The receiving side end to end: the real `index-events`, `payment-events`
/// and `request-payment`, against a local Supabase and Celo mainnet, read
/// only. Mainnet's own history is the fixture: V5 schedule #1 was created on
/// 2026-10-16 and ran once, delivering 0.9975 USA₮ after the fee.
///
///   supabase start -x studio,imgproxy,realtime,storage-api,logflare,vector,edge-runtime,mailpit,supavisor,postgres-meta
///   deno run --allow-all scripts/receiving-e2e.ts
///
/// It checks:
///   1. the indexer backfills both contracts from their deployment blocks to
///      the head, and records schedule #1 and its run exactly;
///   2. `payment-events` serves them by address, after a cursor;
///   3. a request answered by schedule #1 reads accepted, then paid, while an
///      older schedule, a reused one, and a request made after it are refused;
///   4. a policy payment carrying a request's reference in its memo binds it;
///   5. a reorg under the cursor marks a not-final event removed.
///
/// It signs nothing and writes only to the local database. It refuses unless
/// the Supabase API is local.
import postgres from "npm:postgres@3.4.5";

const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const FN = "http://127.0.0.1:8000/";
const V5 = "0x3c357af3300f383ea49b6d6ed8e084199a92bed8";
const ALLOWANCE = "0xa6351faeeb097698289586c4d6188530300db209";
const SENDER = "0x5b156fe262b54c236563428c56839d8457a5542c";
const DEST = "0xfd1a3980f7473bdfe7461e78adde78c33d7b006b";
const RUN_TX = "0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72";

const status = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command("supabase", { args: ["status", "-o", "json"], stderr: "null" }).output()).stdout,
));
if (status.API_URL !== "http://127.0.0.1:54321") {
  console.error("refusing: the local Supabase API is not running on 127.0.0.1:54321");
  Deno.exit(1);
}
const sql = postgres(DB_URL, { onnotice: () => {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

/// One function at a time on :8000, as the platform would run it.
async function serve(name: string) {
  const p = new Deno.Command("deno", {
    args: ["run", "--allow-all", `supabase/functions/${name}/index.ts`],
    env: { SUPABASE_URL: status.API_URL, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, CELO_RPC_URL: "https://forno.celo.org" },
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
const post = (body: unknown) => fetch(FN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

await sql`truncate public.payment_events, public.payment_requests cascade`;
await sql`update public.chain_cursors set block_number = 80268720, block_hash = null where contract = ${V5}`;
await sql`update public.chain_cursors set block_number = 80467201, block_hash = null where contract = ${ALLOWANCE}`;

// --- 1. backfill to the head -------------------------------------------
console.log("1. the indexer backfills both contracts");
let stop = await serve("index-events");
let pass: Record<string, unknown> = {};
for (let i = 0; i < 40; i++) {
  pass = await (await post({})).json();
  const results = pass.results as { at?: string; reads?: number; error?: string }[];
  if (results.some((r) => r.error)) {
    console.log("   pass error:", JSON.stringify(results));
    break;
  }
  if (results.every((r) => r.reads === 0)) break;
}
const cursors = await sql`select contract, block_number, block_hash from public.chain_cursors where chain_id = 42220`;
const head = BigInt(String(pass.head));
check(cursors.every((c) => BigInt(c.block_number) >= head - 10n && c.block_hash), `both cursors reached the head (${head}) with a block hash`);

const [created] = await sql`select * from public.payment_events where contract = ${V5} and kind = 'schedule_created' and ref_id = 1`;
check(created?.from_address === SENDER && created?.to_address === DEST && created?.amount === "997500",
  `schedule #1 created: ${created?.from_address?.slice(0, 8)}… pays ${created?.to_address?.slice(0, 8)}… ${created?.amount} a run, after the fee`);
const [run] = await sql`select * from public.payment_events where contract = ${V5} and kind = 'run' and ref_id = 1`;
check(run?.tx_hash === RUN_TX && run.amount === "997500" && run.amount_in === "1000000" && run.run_number === 1 && run.early === false,
  "its run: the right transaction, 997,500 delivered of 1,000,000, run 1, not early");
check(run?.token === "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771" && run.final === true, "paid in USA₮, and final");
const policies = await sql`select ref_id from public.payment_events where contract = ${ALLOWANCE} and kind = 'policy_created' order by ref_id`;
check(policies.length >= 6, `every policy created on the allowance contract is recorded (${policies.map((p) => p.ref_id).join(", ")})`);
const paid = await sql`select count(*)::int as n from public.payment_events where contract = ${ALLOWANCE} and kind = 'policy_payment'`;
console.log(`   (${paid[0].n} policy payments on mainnet so far)`);
await stop();

// --- 2. reads by address --------------------------------------------------
console.log("\n2. payment-events serves them by address");
stop = await serve("payment-events");
const page = await (await fetch(`${FN}?address=${DEST}&role=to&kind=run`)).json();
check(page.events?.length >= 1 && page.events[0].txHash === RUN_TX && page.events[0].amount === "997500", "the run, by recipient, amount as an exact string");
const later = await (await fetch(`${FN}?address=${DEST}&role=to&kind=run&after=${page.next}`)).json();
check(later.events?.length === 0, "nothing after the last seq");
const bad = await fetch(`${FN}?address=nope`);
check(bad.status === 400, "a bad address is a 400");
await bad.body?.cancel();
await stop();

// --- 3. a request answered by a schedule --------------------------------------
console.log("\n3. a request answered by schedule #1");
const [req1] = await sql`
  insert into public.payment_requests (payer_address, to_address, amount, token_symbol, interval_seconds, max_runs, created_at)
  values (${SENDER}, ${DEST}, '0.9975', 'USA₮', 300, 1, '2026-10-15T00:00:00Z') returning id`;
const [req2] = await sql`
  insert into public.payment_requests (payer_address, to_address, amount, token_symbol, created_at)
  values (${SENDER}, ${DEST}, '1', 'USA₮', '2026-10-15T01:00:00Z') returning id`;
const [req3] = await sql`
  insert into public.payment_requests (payer_address, to_address, amount, token_symbol)
  values (${SENDER}, ${DEST}, '1', 'USA₮') returning id`;
stop = await serve("request-payment");
const answered = await (await post({ action: "answer", id: req1.id, schedule: "1" })).json();
check(answered.ok && answered.status === "accepted", `answered: ${answered.status ?? answered.error}`);
const st = await (await post({ action: "status", id: req1.id })).json();
check(st.status === "accepted" && st.payment?.state === "paid" && st.payment.txs[0]?.txHash === RUN_TX && st.payment.txs[0].final === true,
  `status: ${st.status}, payment ${st.payment?.state} with the run's transaction`);
const reused = await post({ action: "answer", id: req2.id, schedule: "1" });
const reusedBody = await reused.json();
check(reused.status === 409 && /another request/.test(reusedBody.error), `a schedule answers one request: ${reusedBody.error}`);
const tooOld = await post({ action: "answer", id: req3.id, schedule: "1" });
const tooOldBody = await tooOld.json();
check(tooOld.status === 409 && /before the request/.test(tooOldBody.error), `an older schedule can't answer a newer request: ${tooOldBody.error}`);
const inbox = await (await post({ action: "list", payer: SENDER })).json();
check(inbox.requests?.length === 2 && inbox.requests.every((r: { id: string }) => r.id !== req1.id), "the inbox lists the two still open, not the answered one");
const [{ reference }] = await sql`select reference from public.payment_requests where id = ${req2.id}`;
check(inbox.requests.some((r: { reference: string }) => r.reference === reference && reference.length === 32), "each with its 32-character reference");
await stop();

// --- 4. a policy payment carrying the reference ----------------------------------
console.log("\n4. a policy payment with the request's reference in its memo");
const memoHex = `0x${[...reference].map((c: string) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
await sql`
  insert into public.payment_events (chain_id, tx_hash, log_index, contract, kind, ref_id, from_address, to_address, agent, token,
    amount, memo, memo_text, block_number, block_hash, block_time, final)
  values (42220, '0x00000000000000000000000000000000000000000000000000000000000e2e01', 0, ${ALLOWANCE}, 'policy_payment', 3,
    ${SENDER}, ${DEST}, '0x00000000000000000000000000000000000000ee', '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771',
    1000000, ${memoHex}, ${reference}, 1, '0xb10c', now(), true)`;
stop = await serve("index-events");
const bindPass = await (await post({})).json();
check(bindPass.requestsBound === 1, `the next pass bound it (${bindPass.requestsBound})`);
const [r2] = await sql`select status, bound_tx_hash from public.payment_requests where id = ${req2.id}`;
check(r2.status === "accepted" && r2.bound_tx_hash?.endsWith("e2e01"), `request accepted, bound to the payment (${r2.status})`);

// --- 5. a reorg under the cursor -------------------------------------------------
console.log("\n5. a reorg under the cursor");
const [cur] = await sql`select block_number, block_hash from public.chain_cursors where contract = ${V5}`;
await sql`
  insert into public.payment_events (chain_id, tx_hash, log_index, contract, kind, ref_id, from_address, to_address, token,
    amount, block_number, block_hash, block_time, final)
  values (42220, '0x00000000000000000000000000000000000000000000000000000000000e2e02', 0, ${V5}, 'run', 99,
    ${SENDER}, ${DEST}, '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', 1, ${cur.block_number}, '0xold', now(), false)`;
const [{ seq: seqBefore }] = await sql`select seq from public.payment_events where tx_hash like '%e2e02'`;
// The chain no longer has the block the cursor remembers.
await sql`update public.chain_cursors set block_hash = '0x00000000000000000000000000000000000000000000000000000000deadbeef' where contract = ${V5}`;
await post({});
const [ghost] = await sql`select removed, seq from public.payment_events where tx_hash like '%e2e02'`;
check(ghost.removed === true && BigInt(ghost.seq) > BigInt(seqBefore), "the not-final event above the finalized block is marked removed, with a new seq");
const [stillThere] = await sql`select removed from public.payment_events where tx_hash = ${RUN_TX}`;
check(stillThere.removed === false, "a final event is untouched");
const [after] = await sql`select block_number, block_hash from public.chain_cursors where contract = ${V5}`;
check(after.block_hash !== "0x00000000000000000000000000000000000000000000000000000000deadbeef", "and the cursor read on again from the finalized block");
await stop();

await sql.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
