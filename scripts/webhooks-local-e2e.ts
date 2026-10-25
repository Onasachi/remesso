/// Webhooks end to end on a local Supabase (Phase 3.3): a signed subscribe
/// with its challenge, deliveries queued from `payment_events`, signed,
/// retried under the same id and verified, then finalized and removed
/// messages, a cancelled message, rotation, the 24-hour window, replay,
/// revoke, and refusals (a replayed nonce, a duplicate, a silent endpoint,
/// the limit).
///
///   supabase start -x studio,imgproxy,realtime,storage-api,logflare,vector,edge-runtime,mailpit,supavisor,postgres-meta
///   supabase migration up --local
///   deno run --allow-all scripts/webhooks-local-e2e.ts
///
/// The receiver is plain HTTP on localhost, so the test hands the handler and
/// the worker its own transport in place of `safe-fetch`, which refuses both
/// on purpose. Its rows use chain id 1337 and are removed at the end.
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";
import { verifyTypedData } from "npm:viem@2";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2/accounts";
import { verify } from "../supabase/functions/_shared/standard-webhooks.ts";
import { webhookTypedData, type WebhookActionName } from "../supabase/functions/_shared/webhook-actions.ts";
import { runDeliveries } from "../supabase/functions/deliver-webhooks/worker.ts";
import { handle } from "../supabase/functions/webhooks/handler.ts";

const status = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command("supabase", { args: ["status", "-o", "json"], stderr: "null" }).output()).stdout,
));
if (status.API_URL !== "http://127.0.0.1:54321") {
  console.error("refusing: the local Supabase API is not running on 127.0.0.1:54321");
  Deno.exit(1);
}
const db = createClient(status.API_URL, status.SERVICE_ROLE_KEY);
const sql = postgres("postgresql://postgres:postgres@127.0.0.1:54322/postgres", { onnotice: () => {} });

// ---- a receiver that records what it is sent ----
type Hit = { path: string; headers: Record<string, string>; body: string };
const hits: Hit[] = [];
let mode: "echo" | "ok" | "fail" | "fail-once" | "silent" = "echo";
const failedOnce = new Set<string>();
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
  const body = await req.text();
  const headers = Object.fromEntries(req.headers);
  hits.push({ path: new URL(req.url).pathname, headers, body });
  const msg = JSON.parse(body);
  if (msg.type === "webhook.verification") {
    return mode === "silent" ? new Response("not me") : Response.json({ challenge: msg.data.challenge });
  }
  if (mode === "fail") return new Response("down", { status: 500 });
  if (mode === "fail-once" && !failedOnce.has(headers["webhook-id"])) {
    failedOnce.add(headers["webhook-id"]);
    return new Response("try later", { status: 503 });
  }
  return new Response("ok");
});
const HOST = "https://hooks.remesso.test";
const local = (url: string) => url.replace(HOST, `http://127.0.0.1:${server.addr.port}`);
const transport = async (url: string, headers: Record<string, string>, body: string) => {
  const r = await fetch(local(url), { method: "POST", headers, body });
  return { status: r.status, text: await r.text() };
};
const deliver = () => runDeliveries(db, transport);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

// ---- a receiving wallet and its signed requests ----
const wallet = privateKeyToAccount(generatePrivateKey());
const recipient = wallet.address.toLowerCase();
let n = 0;
async function action(act: WebhookActionName, url: string, extra: Record<string, unknown> = {}) {
  const a = { recipient: wallet.address, url, chainId: 42220, action: act, nonce: `test-nonce-${Date.now()}-${n++}`, expiry: Math.floor(Date.now() / 1000) + 600 };
  return { ...a, ...extra, signature: await wallet.signTypedData(webhookTypedData(a)) };
}
const call = async (body: unknown) => {
  const res = await handle(new Request("http://local/webhooks", { method: "POST", body: JSON.stringify(body) }), {
    db,
    verify: (args) => verifyTypedData(args),
    challenge: transport,
  });
  return { status: res.status, body: await res.json() };
};

// ---- events, as index-events would write them ----
let tx = 0;
async function event(kind: "run" | "policy_payment") {
  const hash = `0x${(++tx).toString(16).padStart(64, "0")}`;
  await sql`
    insert into public.payment_events (chain_id, tx_hash, log_index, contract, kind, ref_id, from_address, to_address, token,
      amount, amount_in, memo, memo_text, run_number, early, block_number, block_hash, block_time)
    values (1337, ${hash}, 0, '0x3c357af3300f383ea49b6d6ed8e084199a92bed8', ${kind}, 7, '0x5b156fe262b54c236563428c56839d8457a5542c',
      ${recipient}, '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', 997500, ${kind === "run" ? 1000000 : null},
      ${kind === "policy_payment" ? "0x" + "61".repeat(32) : null}, ${kind === "policy_payment" ? "a".repeat(32) : null},
      ${kind === "run" ? 1 : null}, ${kind === "run" ? false : null}, ${100 + tx}, ${"0x" + "b".repeat(63) + (tx % 10)}, now())`;
  return hash;
}
const touch = (hash: string, change: "final" | "removed") =>
  change === "final"
    ? sql`update public.payment_events set final = true, seq = nextval('public.payment_events_seq') where chain_id = 1337 and tx_hash = ${hash}`
    : sql`update public.payment_events set removed = true, seq = nextval('public.payment_events_seq') where chain_id = 1337 and tx_hash = ${hash}`;
const deliveryRows = (hash: string) => sql`select * from public.webhook_deliveries where chain_id = 1337 and tx_hash = ${hash} order by created_at`;
const sentTo = (path: string, type: string) => hits.filter((h) => h.path === path && JSON.parse(h.body).type === type);

let secret = "";
try {
  // 1. subscribe ---------------------------------------------------------
  console.log("1. subscribe, with the challenge");
  const sub = await action("subscribe", `${HOST}/a`);
  const s1 = await call(sub);
  secret = s1.body.secret;
  check(s1.status === 201 && /^whsec_/.test(secret), `subscribed (${s1.status}), secret returned once`);
  check(sentTo("/a", "webhook.verification").length === 1, "the endpoint was sent a challenge first");
  check((await call(sub)).status === 409, "the same signed request again is refused (nonce spent)");
  check((await call(await action("subscribe", `${HOST}/a`))).status === 409, "a second subscription for the same url is refused");
  mode = "silent";
  const quiet = await call(await action("subscribe", `${HOST}/quiet`));
  const [{ count: pendingLeft }] = await sql`select count(*)::int from public.webhook_subscriptions where url = ${HOST + "/quiet"}`;
  check(quiet.status === 400 && pendingLeft === 0, "an endpoint that doesn't echo the challenge gets nothing, and nothing is kept");

  // 2. received, retried under the same id -----------------------------------
  console.log("\n2. a payment, a failed attempt, a retry under the same id");
  mode = "fail-once";
  const e1 = await event("run");
  const r1 = await deliver();
  check(r1.queued === 1 && r1.retrying === 1, `queued and the first attempt failed (${JSON.stringify(r1)})`);
  await sql`update public.webhook_deliveries set next_attempt_at = now() where chain_id = 1337 and tx_hash = ${e1}`;
  await new Promise((r) => setTimeout(r, 1100)); // a new second, so a new timestamp
  const r2 = await deliver();
  const attempts = sentTo("/a", "payment.received");
  check(r2.delivered === 1 && attempts.length === 2, "delivered on the retry");
  check(attempts[0].headers["webhook-id"] === attempts[1].headers["webhook-id"], `the same webhook-id both times (${attempts[1].headers["webhook-id"]})`);
  check(
    attempts[0].headers["webhook-timestamp"] !== attempts[1].headers["webhook-timestamp"] &&
      attempts[0].headers["webhook-signature"] !== attempts[1].headers["webhook-signature"],
    "a new timestamp and signature on the retry",
  );
  check(await verify(attempts[1].body, attempts[1].headers, secret), "the delivery verifies with the subscription's secret");
  const p1 = JSON.parse(attempts[1].body);
  check(p1.data.amount === "997500" && p1.data.final === false && p1.data.schedule === "7", "the payload: amount after the fee, not final, the schedule");
  const [d1] = await deliveryRows(e1);
  check(d1.attempts === 2 && d1.delivered_at !== null, "recorded: two attempts, delivered");

  // 3. finalized ----------------------------------------------------------
  console.log("\n3. the same payment turns final");
  mode = "ok";
  await touch(e1, "final");
  await deliver();
  const fin = sentTo("/a", "payment.finalized");
  check(fin.length === 1 && JSON.parse(fin[0].body).data.final === true, "payment.finalized, with final: true");

  // 4. removed after it was announced; removed before -------------------------
  console.log("\n4. reorgs");
  const e2 = await event("policy_payment");
  await deliver();
  await touch(e2, "removed");
  await deliver();
  const gone = sentTo("/a", "payment.removed");
  check(gone.length === 1 && JSON.parse(gone[0].body).data.memoText === "a".repeat(32), "announced then removed: payment.removed, memo and all");
  mode = "fail";
  const e3 = await event("run");
  await deliver(); // queued, the attempt fails, it waits
  await touch(e3, "removed");
  await deliver();
  const [d3] = await deliveryRows(e3);
  check(
    d3.failed_at !== null && /reorg/.test(d3.last_error) && (await deliveryRows(e3)).length === 1,
    "removed before it was delivered: the waiting message is cancelled, nothing more is said",
  );

  // 5. rotation -----------------------------------------------------------
  console.log("\n5. rotate the secret");
  mode = "ok";
  const rot = await call(await action("rotate", `${HOST}/a`));
  const next = rot.body.secret;
  check(rot.status === 200 && next !== secret, "a new secret, shown once");
  await event("run");
  await deliver();
  const last = sentTo("/a", "payment.received").at(-1)!;
  check(last.headers["webhook-signature"].split(" ").length === 2, "two signatures during the grace day");
  check(await verify(last.body, last.headers, secret) && await verify(last.body, last.headers, next), "it verifies with the old secret and the new one");

  // 6. the 24-hour window, and replay -----------------------------------------
  console.log("\n6. retries end after 24 hours; replay starts again");
  mode = "fail";
  const e6 = await event("run");
  await deliver();
  await sql`update public.webhook_deliveries set window_started_at = now() - interval '25 hours', next_attempt_at = now() where chain_id = 1337 and tx_hash = ${e6}`;
  const r6 = await deliver();
  check(r6.failed === 1 && (await deliveryRows(e6))[0].failed_at !== null, "past the window: failed");
  const rep = await call(await action("replay", `${HOST}/a`, { days: 1 }));
  check(rep.status === 200 && rep.body.requeued === 1, "replay re-queues it");
  mode = "ok";
  const r7 = await deliver();
  check(r7.delivered === 1 && (await deliveryRows(e6))[0].delivered_at !== null, "and it is delivered");

  // 7. revoke, and the limit ------------------------------------------------
  console.log("\n7. revoke, and five per address");
  const rev = await call(await action("revoke", `${HOST}/a`));
  const before = hits.length;
  await event("run");
  await deliver();
  check(rev.status === 200 && hits.length === before, "revoked: nothing more is sent");
  check((await call(await action("revoke", `${HOST}/a`))).status === 404, "revoking again: nothing to revoke");
  mode = "echo";
  for (const p of ["b", "c", "d", "e", "f"]) await call(await action("subscribe", `${HOST}/${p}`));
  check((await call(await action("subscribe", `${HOST}/g`))).status === 429, "a sixth subscription is refused");
} finally {
  // Leave the local database as it was.
  for (const p of ["a", "b", "c", "d", "e", "f", "g", "quiet"]) {
    await db.rpc("revoke_webhook_subscription", { p_address: recipient, p_url: `${HOST}/${p}` });
  }
  await sql`delete from public.webhook_deliveries where chain_id = 1337`;
  await sql`delete from public.webhook_subscriptions where address = ${recipient}`;
  await sql`delete from public.webhook_nonces where address = ${recipient}`;
  await sql`delete from public.payment_events where chain_id = 1337`;
  await sql.end();
  await server.shutdown();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
