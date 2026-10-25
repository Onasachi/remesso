/// The `webhooks` API, with its outside world passed in: the database, how a
/// typed-data signature is checked, and how the challenge reaches an endpoint.
/// `index.ts` wires the real ones (viem against Celo, `safe-fetch`); a local
/// test can wire its own.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getAddress } from "npm:viem@2";
import { generateSecret, signedHeaders } from "../_shared/standard-webhooks.ts";
import {
  checkAction,
  MAX_ACTION_TTL_SECS,
  WEBHOOK_ACTIONS,
  WEBHOOK_DOMAIN,
  WEBHOOK_TYPES,
  type WebhookAction,
  webhookTypedData,
} from "../_shared/webhook-actions.ts";
import { RETRY_DELAYS_SECS } from "../deliver-webhooks/plan.ts";

export type Deps = {
  db: SupabaseClient;
  /// viem's `publicClient.verifyTypedData`: an EOA by recovery, a smart
  /// account through ERC-1271.
  verify: (args: { address: `0x${string}`; signature: `0x${string}` } & ReturnType<typeof webhookTypedData>) => Promise<boolean>;
  /// POST the verification message to the endpoint, through `safe-fetch`.
  challenge: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; text: string }>;
  nowSecs?: () => number;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/// How far back `replay` reaches, in days, at most.
const MAX_REPLAY_DAYS = 7;

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") return json(DESCRIPTION);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  // Cheapest first: the shape, then whether the nonce is spent, then the
  // signature, which may cost an eth_call for a smart account.
  const now = (deps.nowSecs ?? (() => Math.floor(Date.now() / 1000)))();
  const c = checkAction(body, now);
  if (!c.ok) return json({ error: c.error }, 400);
  const a = c.action;
  const address = a.recipient.toLowerCase();

  const { data: spent, error: nErr } = await deps.db
    .from("webhook_nonces").select("nonce").eq("address", address).eq("nonce", a.nonce).maybeSingle();
  if (nErr) return json({ error: "could not check the nonce" }, 500);
  if (spent) return json({ error: "this nonce was already used; sign again with a new one" }, 409);

  const { signature, ...unsigned } = a;
  let valid: boolean;
  try {
    valid = await deps.verify({ address: getAddress(a.recipient), signature, ...webhookTypedData(unsigned) });
  } catch (e) {
    console.error("webhooks: signature check failed", (e as Error).message);
    return json({ error: "could not check the signature" }, 502);
  }
  if (!valid) return json({ error: "the signature is not from the recipient address" }, 401);

  // Spent only now, so a forged request can't burn someone's nonce. Atomic:
  // of two identical requests in flight, one gets here.
  const { data: fresh, error: uErr } = await deps.db.rpc("use_webhook_nonce", {
    p_address: address,
    p_nonce: a.nonce,
    p_expires_at: new Date(a.expiry * 1000).toISOString(),
  });
  if (uErr) return json({ error: "could not record the nonce" }, 500);
  if (!fresh) return json({ error: "this nonce was already used; sign again with a new one" }, 409);

  switch (a.action) {
    case "subscribe":
      return await subscribe(a, deps);
    case "rotate":
      return await rotate(a, deps);
    case "revoke":
      return await revoke(a, deps);
    case "replay":
      return await replay(a, body, deps);
  }
}

/// A subscription becomes active only once its endpoint proves it wants the
/// messages: it must answer a verification POST with the challenge in it.
/// Otherwise anyone could point an address's deliveries at a server that
/// never asked for them.
async function subscribe(a: WebhookAction, { db, challenge }: Deps): Promise<Response> {
  const secret = generateSecret();
  const { data, error } = await db
    .rpc("create_webhook_subscription", { p_address: a.recipient.toLowerCase(), p_url: a.url, p_secret: secret })
    .single<{ subscription_id: string | null; problem: string | null }>();
  if (error || !data) return json({ error: "could not create the subscription" }, 500);
  if (data.problem === "already_subscribed") {
    return json({ error: "this url is already subscribed for this address", detail: "rotate its secret or revoke it" }, 409);
  }
  if (data.problem === "limit") {
    return json({ error: "this address already has 5 webhook subscriptions", detail: "revoke one first" }, 429);
  }

  const code = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const message = JSON.stringify({
    type: "webhook.verification",
    timestamp: new Date().toISOString(),
    data: { challenge: code, recipient: a.recipient.toLowerCase(), url: a.url },
  });
  // Signed with the new secret like every later message. The endpoint can't
  // check this one yet: the secret is only returned once it has answered.
  const headers = { "content-type": "application/json", ...(await signedHeaders([secret], `msg_verify_${code}`, message)) };
  let problem = "";
  try {
    const res = await challenge(a.url, headers, message);
    if (res.status < 200 || res.status >= 300) problem = `the endpoint answered ${res.status}`;
    else if (!echoes(res.text, code)) problem = "the answer didn't contain the challenge";
  } catch (e) {
    problem = (e as Error).message;
  }
  if (problem) {
    await db.rpc("discard_webhook_subscription", { p_id: data.subscription_id });
    return json({
      error: "the endpoint didn't confirm the subscription",
      detail: problem,
      how: 'answer the webhook.verification POST with a 2xx and the challenge, as the whole body or as {"challenge": "..."}',
    }, 400);
  }

  const { error: aErr } = await db.rpc("activate_webhook_subscription", { p_id: data.subscription_id });
  if (aErr) return json({ error: "could not activate the subscription" }, 500);
  return json({
    ok: true,
    subscription: data.subscription_id,
    recipient: a.recipient.toLowerCase(),
    url: a.url,
    state: "active",
    secret,
    note: "Shown once. Verify every delivery's webhook-signature with it (Standard Webhooks).",
  }, 201);
}

function echoes(text: string, code: string): boolean {
  if (text.trim() === code) return true;
  try {
    return (JSON.parse(text) as { challenge?: unknown })?.challenge === code;
  } catch {
    return false;
  }
}

async function rotate(a: WebhookAction, { db }: Deps): Promise<Response> {
  const secret = generateSecret();
  const { data: until, error } = await db.rpc("rotate_webhook_secret", {
    p_address: a.recipient.toLowerCase(),
    p_url: a.url,
    p_secret: secret,
  });
  if (error) return json({ error: "could not rotate the secret" }, 500);
  if (!until) return json({ error: "no active subscription for this address and url" }, 404);
  return json({
    ok: true,
    secret,
    previousSecretValidUntil: until,
    note: "Shown once. Deliveries carry a signature from each secret until then.",
  });
}

async function revoke(a: WebhookAction, { db }: Deps): Promise<Response> {
  const { data: done, error } = await db.rpc("revoke_webhook_subscription", { p_address: a.recipient.toLowerCase(), p_url: a.url });
  if (error) return json({ error: "could not revoke the subscription" }, 500);
  if (!done) return json({ error: "no subscription for this address and url" }, 404);
  return json({ ok: true, state: "revoked" });
}

/// `days` isn't signed: the worst a changed one does is resend more of the
/// signer's own failed deliveries.
async function replay(a: WebhookAction, body: Record<string, unknown>, { db }: Deps): Promise<Response> {
  const days = Math.min(Math.max(Math.floor(Number(body.days ?? 1)) || 1, 1), MAX_REPLAY_DAYS);
  const { data: n, error } = await db.rpc("replay_webhook_deliveries", {
    p_address: a.recipient.toLowerCase(),
    p_url: a.url,
    p_since: new Date(Date.now() - days * 86_400_000).toISOString(),
  });
  if (error) return json({ error: "could not replay deliveries" }, 500);
  return json({ ok: true, requeued: Number(n ?? 0), days });
}

const DESCRIPTION = {
  name: "Remesso webhooks",
  description:
    "Payments to an address, announced to its own server: every Remesso schedule run and agent policy payment to the address, " +
    "signed the Standard Webhooks way. Only the address manages its subscriptions, by EIP-712 signature.",
  method: "POST",
  input: {
    action: WEBHOOK_ACTIONS.join(" | "),
    recipient: "the receiving address; it signs",
    url: "your https endpoint",
    chainId: WEBHOOK_DOMAIN.chainId,
    nonce: "8 to 128 letters, digits, - or _; once only",
    expiry: `unix seconds, in the future and at most ${MAX_ACTION_TTL_SECS / 60} minutes ahead`,
    signature: "EIP-712 signature by the recipient (ERC-1271 for a smart account)",
    days: `replay only: how far back, 1 to ${MAX_REPLAY_DAYS}`,
  },
  typedData: {
    domain: WEBHOOK_DOMAIN,
    types: WEBHOOK_TYPES,
    primaryType: "WebhookAction",
    message: { recipient: "<address>", url: "<url>", chainId: 42220, action: "<action>", nonce: "<nonce>", expiry: "<unix seconds>" },
  },
  subscribe: {
    verification:
      'Before anything is sent, your url gets a POST {"type":"webhook.verification","data":{"challenge":"..."}}. ' +
      'Answer 2xx with the challenge as the body or as {"challenge":"..."}. The signing secret is returned once, in the response.',
    limit: "5 subscriptions per address",
  },
  deliveries: {
    types: ["payment.received", "payment.finalized", "payment.removed"],
    headers: ["webhook-id", "webhook-timestamp", "webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>"],
    retries: `the same webhook-id each time, after ${RETRY_DELAYS_SECS.map((s) => (s < 3600 ? `${s / 60}m` : `${s / 3600}h`)).join(", ")}, then every 6h, for 24 hours`,
    note: "Amounts are base units, after the fee. final=false until Celo's finalized block passes the event. Check the transaction before releasing goods.",
  },
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json" } });
