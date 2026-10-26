// The SDK against Remesso's endpoints, with fetch faked: what it signs must be
// what the backend verifies (checked with the backend's own files), and what
// comes back is read as the endpoints answer it (a recorded payment-events
// page). Plus the webhook handler, agent lookup and the Node extras.
//   deno test --config packages/remesso-sdk/deno.json --unstable-sloppy-imports --allow-read --allow-write --allow-env --allow-net=127.0.0.1 packages/remesso-sdk/test/
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createServer } from "node:http";
import { type Address, toHex, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signedHeaders } from "../../../supabase/functions/_shared/standard-webhooks.ts";
import { checkAction, webhookTypedData } from "../../../supabase/functions/_shared/webhook-actions.ts";
import { checkDecline, declineTypedData } from "../../../supabase/functions/_shared/request-decline.ts";
import { createRemesso, EXECUTOR, token, RemessoError, webhookHandler, type WebhookMessage } from "../src/index.ts";
import { fileStore, toNodeListener } from "../src/node.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // a well-known test key, no funds
const account = privateKeyToAccount(KEY);
const FN = "https://remesso.test/functions/v1";

/// A fetch that records what it was sent and answers from `reply`.
function fakeFetch(reply: (url: string, body: Record<string, unknown> | null) => unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    return new Response(JSON.stringify(reply(url, body)), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

Deno.test("webhook subscribe: signed as the backend checks it", async () => {
  const f = fakeFetch(() => ({ ok: true, subscription: "s1", recipient: account.address.toLowerCase(), url: "https://me.example/hook", state: "active", secret: "whsec_x" }));
  const r = createRemesso({ account, functionsUrl: FN, fetch: f.fetch });
  const out = await r.webhooks.subscribe({ url: "https://me.example/hook" });
  assertEquals(out.secret, "whsec_x");
  const body = f.calls[0].body!;
  assertEquals(f.calls[0].url, `${FN}/webhooks`);
  // The backend's own shape check, then its signature check.
  const c = checkAction(body, Math.floor(Date.now() / 1000));
  assert(c.ok, !c.ok ? c.error : "");
  const { signature, ...unsigned } = c.action;
  assert(await verifyTypedData({ address: account.address, signature, ...webhookTypedData(unsigned) }));
  assertEquals(body.action, "subscribe");
});

Deno.test("decline: signed as request-payment checks it, as payer or as an agent under a policy", async () => {
  const id = "1ab0c6d4-0000-4000-8000-000000000001";
  const f = fakeFetch(() => ({ ok: true, id, status: "declined" }));
  const r = createRemesso({ account, functionsUrl: FN, fetch: f.fetch });
  await r.requests.decline(id);
  await r.requests.decline(id, { policyId: 7 });
  for (const call of f.calls) {
    const c = checkDecline(call.body!, Math.floor(Date.now() / 1000));
    assert(c.ok, !c.ok ? c.error : "");
    assert(await verifyTypedData({ address: account.address, signature: c.decline.signature, ...declineTypedData(c.decline.id, c.decline.expiry) }));
  }
  assertEquals(f.calls[1].body!.agent, account.address);
  assertEquals(f.calls[1].body!.policy_id, "7");
});

Deno.test("requests: create returns the reference; the backend's errors become codes", async () => {
  const id = "bf0305f6-1ec5-4d42-9352-a09c84aa5f18";
  const f = fakeFetch(() => ({ ok: true, id, link: "https://remesso.xyz/schedules/new?to=0x", status: "pending" }));
  const r = createRemesso({ account, functionsUrl: FN, fetch: f.fetch });
  const made = await r.requests.create({ payer: "0x000000000000000000000000000000000000dEaD", amount: "5", token: "usat", every: "month" });
  assertEquals(made.reference, "bf0305f61ec54d429352a09c84aa5f18");
  assertEquals(f.calls[0].body!.to, account.address); // to this account by default
  assertEquals(f.calls[0].body!.token, "USA₮");

  const missing = createRemesso({ account, functionsUrl: FN, fetch: fakeFetch(() => ({ error: "no such request" }), 404).fetch });
  const e = await assertRejects(() => missing.requests.get(id), RemessoError);
  assertEquals(e.code, "not_found");
  const full = createRemesso({ account, functionsUrl: FN, fetch: fakeFetch(() => ({ error: "this payer has 10 requests waiting" }), 429).fetch });
  assertEquals((await assertRejects(() => full.requests.create({ payer: account.address }), RemessoError)).code, "refused");
  const taken = createRemesso({ account, functionsUrl: FN, fetch: fakeFetch(() => ({ error: "this url is already subscribed for this address" }), 409).fetch });
  assertEquals((await assertRejects(() => taken.webhooks.subscribe({ url: "https://me.example/hook" }), RemessoError)).code, "conflict");
});

Deno.test("answer: retried while the backend hasn't seen the new schedule, as on mainnet", async () => {
  const id = "339b4d63-feb7-4e20-b96e-4e62f93efa28";
  let asked = 0;
  const fetch = (async () => {
    asked++;
    return asked === 1
      ? new Response(JSON.stringify({ error: "that schedule hasn't been seen on-chain yet; try again in a minute" }), { status: 409 })
      : new Response(JSON.stringify({ ok: true, id, status: "accepted", signed: { changed: [] } }), { status: 200 });
  }) as typeof globalThis.fetch;
  const r = createRemesso({ account, functionsUrl: FN, fetch });
  const out = await r.requests.answer(id, 2n, undefined, { waitMs: 10_000 });
  assertEquals([out.status, asked], ["accepted", 2]);
  // The second mainnet run's 500, then the answer: retried too.
  let tries = 0;
  const flaky = (async () =>
    ++tries === 1
      ? new Response(JSON.stringify({ error: "could not record the answer" }), { status: 500 })
      : new Response(JSON.stringify({ ok: true, id, status: "accepted", signed: { changed: [] } }), { status: 200 })) as typeof globalThis.fetch;
  assertEquals((await createRemesso({ account, functionsUrl: FN, fetch: flaky }).requests.answer(id, 2n, undefined, { waitMs: 10_000 })).status, "accepted");
  // Anything else the backend refuses is not retried.
  const refuse = (async () => new Response(JSON.stringify({ error: "that schedule can't answer this request: not from the payer" }), { status: 409 })) as typeof globalThis.fetch;
  const e = await assertRejects(() => createRemesso({ account, functionsUrl: FN, fetch: refuse }).requests.answer(id, 2n), RemessoError);
  assertEquals(e.code, "conflict");
});

Deno.test("reads of something just created wait for a node that has seen it", async () => {
  let reads = 0;
  const empty = { owner: "0x0000000000000000000000000000000000000000", agent: "0x0000000000000000000000000000000000000000", token: "0x0000000000000000000000000000000000000000" };
  const full = { owner: account.address, agent: account.address, token: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", expiresAt: 9_999_999_999n, allowlistOnly: false, revoked: false, perPayment: 1n, perDay: 1n, spentInWindow: 0n, windowStart: 0n };
  const chain = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "policy") return ++reads < 3 ? empty : full; // a lagging node, twice
      if (functionName === "remainingToday") return 1n;
      return 0n; // balanceOf, allowance
    },
  };
  const r = createRemesso({ publicClient: chain as never });
  const p = await r.policies.get(7);
  assertEquals([p.owner, p.symbol, reads >= 3], [account.address, "USDT", true]);
});

Deno.test("events: the recorded payment-events page, read and paged by seq", async () => {
  const page = JSON.parse(await Deno.readTextFile(new URL("./fixtures/payment-events.json", import.meta.url)));
  const f = fakeFetch((url) => (new URL(url).searchParams.get("after") === "0" ? page : { events: [], next: page.next }));
  const r = createRemesso({ functionsUrl: FN, fetch: f.fetch });
  const to = "0xfd1a3980f7473bdfe7461e78adde78c33d7b006b";
  const { events, next } = await r.events.list({ address: to, role: "to", kinds: ["run"] });
  const q = new URL(f.calls[0].url).searchParams;
  assertEquals([q.get("address"), q.get("role"), q.get("kind")], [to, "to", "run"]);
  const run = events.find((e) => e.kind === "run")!;
  assertEquals([run.amount, run.amountIn, run.final], ["997500", "1000000", true]);
  assertEquals(next, page.next);

  const stop = new AbortController();
  const seen: number[] = [];
  for await (const e of r.events.watch({ address: to, intervalMs: 10, signal: stop.signal })) {
    seen.push(e.seq);
    if (seen.length === page.events.length) stop.abort();
  }
  assertEquals(seen, page.events.map((e: { seq: number }) => e.seq));
});

Deno.test("webhook handler: challenge only for our address; deliveries verified; failures retried", async () => {
  const secret = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
  const got: WebhookMessage[] = [];
  let fail = false;
  const handle = webhookHandler({
    secret: () => secret,
    recipient: account.address,
    onPayment: (m) => {
      if (fail) throw new Error("db down");
      got.push(m);
    },
  });
  const post = (body: string, headers: Record<string, string> = {}) =>
    handle(new Request("https://me.example/hook", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));

  const verification = (recipient: string) => JSON.stringify({ type: "webhook.verification", timestamp: new Date().toISOString(), data: { challenge: "c0ffee", recipient, url: "https://me.example/hook" } });
  const ok = await post(verification(account.address.toLowerCase()));
  assertEquals([ok.status, await ok.json()], [200, { challenge: "c0ffee" }]);
  assertEquals((await post(verification("0x000000000000000000000000000000000000dead"))).status, 403);

  const body = JSON.stringify({
    type: "payment.received",
    timestamp: new Date().toISOString(),
    data: { chainId: 42220, contract: EXECUTOR, schedule: "1", from: account.address, to: account.address.toLowerCase(), token: token("USDT").address, amount: "997500", amountIn: "1000000", runNumber: 1, early: false, txHash: toHex(1, { size: 32 }), logIndex: 11, blockNumber: 80271047, blockHash: toHex(2, { size: 32 }), blockTime: "2026-10-16T17:30:05Z", final: false, removed: false },
  });
  const signed = await signedHeaders([secret], "msg_1", body);
  const delivered = await post(body, signed);
  assertEquals(delivered.status, 200);
  assertEquals([got[0].id, got[0].type, got[0].data.amount], ["msg_1", "payment.received", "997500"]);

  assertEquals((await post(body, { ...signed, "webhook-signature": "v1,AAAA" })).status, 401);
  // Mid-rotation: signed with the old and the new secret, verified by either.
  const other = "whsec_" + btoa("fedcba9876543210fedcba9876543210");
  assertEquals((await post(body, await signedHeaders([other, secret], "msg_2", body))).status, 200);
  fail = true;
  assertEquals((await post(body, await signedHeaders([secret], "msg_3", body))).status, 500);
  const noSecret = webhookHandler({ recipient: account.address, onPayment: () => {} });
  assertEquals((await noSecret(new Request("https://x/", { method: "POST", body }))).status, 503);
});

Deno.test("agents: the wallet only from getAgentWallet; the profile from the registration file", async () => {
  const doc = (services: unknown[]) => `data:application/json;base64,${btoa(JSON.stringify({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", services }))}`;
  const chain = (wallet: Address, uri: string) => ({
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "getAgentWallet" ? wallet : uri),
  });
  const entry = { name: "remesso", version: "1", endpoint: `${FN}/request-payment`, assets: [{ network: "eip155:42220", asset: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771" }], reference: { required: true } };
  const r1 = createRemesso({ publicClient: chain(account.address, doc([entry])) as never });
  const a = await r1.agents.find(42);
  assertEquals(a.wallet, account.address);
  assertEquals(a.profile?.reference, { required: true });
  assertEquals(a.profile?.assets.length, 1);

  const r2 = createRemesso({ publicClient: chain("0x0000000000000000000000000000000000000000", doc([])) as never });
  const b = await r2.agents.find(43);
  assertEquals([b.wallet, b.note], [null, "it has no agentWallet set, so don't pay it"]);

  const r3 = createRemesso({ publicClient: chain(account.address, "https://example.com/agent.json") as never });
  assert((await r3.agents.find(44)).note?.includes("fetchText"));
});

Deno.test("fileStore: a key has one record, kept in a 0600 file", async () => {
  const dir = await Deno.makeTempDir();
  const store = fileStore(`${dir}/payments.json`);
  const rec = { key: "k1", deployment: "42220:0xa", policyId: "1", to: account.address, units: "10000", token: account.address, memo: toHex(0, { size: 32 }), hash: toHex(1, { size: 32 }), nonce: 1, raw: "0x" as const, status: "sent" as const, at: new Date().toISOString() };
  await store.save(rec);
  await store.save({ ...rec, hash: toHex(2, { size: 32 }), status: "confirmed" });
  assertEquals((await store.byKey("k1", "42220:0xa"))?.status, "confirmed");
  assertEquals((await store.since(0)).length, 1);
  assertEquals((await Deno.stat(`${dir}/payments.json`)).mode! & 0o777, 0o600);
});

Deno.test("toNodeListener: the handler behind node:http answers the challenge", async () => {
  const server = createServer(toNodeListener(webhookHandler({ recipient: account.address, onPayment: () => {} })));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      body: JSON.stringify({ type: "webhook.verification", data: { challenge: "abc123", recipient: account.address } }),
    });
    assertEquals(await res.json(), { challenge: "abc123" });
  } finally {
    await new Promise((res) => server.close(res));
  }
});
