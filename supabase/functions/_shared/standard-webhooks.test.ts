/// Holds our Standard Webhooks signing and verifying to the reference
/// libraries: `svix` (what Self signs with, and what most receivers verify
/// with) and `standardwebhooks` (the spec's own implementation).
///
/// A round trip against ourselves would pass even with the signed content
/// wrong in a self-consistent way, so every case crosses a library boundary:
/// they sign and we verify, or we sign and they verify.
///
///   deno test --allow-env supabase/functions/_shared/standard-webhooks.test.ts
import { assert, assertEquals, assertFalse, assertMatch } from "jsr:@std/assert@1";
import { Webhook as Svix } from "npm:svix@1.92.2";
import { Webhook as StandardWebhook } from "npm:standardwebhooks@1.0.0";
import { generateSecret, sign, signedHeaders, TOLERANCE_SECONDS, verify } from "./standard-webhooks.ts";

const SECRET = "whsec_" + btoa("remesso-standard-webhooks-secret");
const BODY = JSON.stringify({ type: "payment.received", timestamp: "2026-10-25T09:00:00.000Z", data: { amount: "997500" } });
const now = () => Math.floor(Date.now() / 1000);

Deno.test("svix's signature verifies here, under either header name", async () => {
  const at = new Date();
  const sig = new Svix(SECRET).sign("msg_1", at, BODY);
  const ts = String(Math.floor(at.getTime() / 1000));
  assert(await verify(BODY, new Headers({ "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sig }), SECRET));
  assert(await verify(BODY, { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": sig }, SECRET));
});

Deno.test("ours verifies in svix and in standardwebhooks", async () => {
  const headers = await signedHeaders([SECRET], "msg_2", BODY);
  new StandardWebhook(SECRET).verify(BODY, headers); // throws if wrong
  new Svix(SECRET).verify(BODY, {
    "svix-id": headers["webhook-id"],
    "svix-timestamp": headers["webhook-timestamp"],
    "svix-signature": headers["webhook-signature"],
  });
});

Deno.test("a generated secret works in both libraries", async () => {
  const secret = generateSecret();
  assertMatch(secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
  const headers = await signedHeaders([secret], "msg_3", BODY);
  new StandardWebhook(secret).verify(BODY, headers);
});

Deno.test("mid-rotation, a receiver with either secret verifies", async () => {
  const next = generateSecret();
  const headers = await signedHeaders([next, SECRET], "msg_4", BODY);
  assertEquals(headers["webhook-signature"].split(" ").length, 2);
  new StandardWebhook(SECRET).verify(BODY, headers);
  new StandardWebhook(next).verify(BODY, headers);
  assert(await verify(BODY, headers, SECRET));
  assert(await verify(BODY, headers, next));
});

Deno.test("the same id, a new timestamp: a retry's signature differs and still verifies", async () => {
  const first = await signedHeaders([SECRET], "msg_5", BODY, now() - 60);
  const retry = await signedHeaders([SECRET], "msg_5", BODY, now());
  assertEquals(first["webhook-id"], retry["webhook-id"]);
  assert(first["webhook-signature"] !== retry["webhook-signature"]);
  assert(await verify(BODY, retry, SECRET));
});

Deno.test("refused: an altered body, another secret, an old or future timestamp", async () => {
  const headers = await signedHeaders([SECRET], "msg_6", BODY);
  assertFalse(await verify(BODY.replace("997500", "997501"), headers, SECRET));
  assertFalse(await verify(BODY, headers, "whsec_" + btoa("a-different-endpoint-secret")));
  const t = Number(headers["webhook-timestamp"]);
  assertFalse(await verify(BODY, headers, SECRET, { nowSeconds: t + TOLERANCE_SECONDS + 1 }));
  assertFalse(await verify(BODY, headers, SECRET, { nowSeconds: t - TOLERANCE_SECONDS - 1 }));
});

Deno.test("refused, never thrown: missing headers, an empty or malformed secret, an unknown version", async () => {
  const headers = await signedHeaders([SECRET], "msg_7", BODY);
  assertFalse(await verify(BODY, new Headers(), SECRET));
  assertFalse(await verify(BODY, headers, ""));
  assertFalse(await verify(BODY, headers, "whsec_not base64!!"));
  assertFalse(await verify(BODY, { ...headers, "webhook-signature": headers["webhook-signature"].replace("v1,", "v2,") }, SECRET));
});

Deno.test("sign is the plain v1 form both libraries produce", async () => {
  const at = new Date();
  const ts = Math.floor(at.getTime() / 1000);
  assertEquals(await sign(SECRET, "msg_8", ts, BODY), new Svix(SECRET).sign("msg_8", at, BODY));
});
