/// Standard Webhooks (standardwebhooks.com), the scheme Svix speaks. Self signs
/// its deliveries to us with it, and Remesso signs its own deliveries with it.
///
///   signed    = `${webhook-id}.${webhook-timestamp}.${body}`
///   key       = base64-decode(secret without its `whsec_` prefix)
///   signature = base64(HMAC-SHA256(key, signed)), sent as `v1,<sig>`,
///               space-separated when a secret is mid-rotation
///
/// The timestamp window is what stops a captured delivery being replayed
/// later. Web Crypto and nothing else, so the SDK imports this file as it is,
/// in Node, Deno, Bun or a browser. `standard-webhooks.test.ts` holds it to the
/// `svix` and `standardwebhooks` libraries.

export const TOLERANCE_SECONDS = 5 * 60;

/// A fresh signing secret: 32 random bytes as `whsec_`-prefixed base64.
export function generateSecret(): string {
  return `whsec_${bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/// `v1,<signature>` of `body` under one secret. Throws on a malformed secret:
/// that is the sender's mistake, not something to swallow.
export async function sign(secret: string, id: string, timestampSeconds: number, body: string): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestampSeconds}.${body}`));
  return `v1,${bytesToBase64(new Uint8Array(mac))}`;
}

/// The three headers for one attempt at a delivery. With more than one secret
/// (a rotation in progress) there is one signature per secret, so a receiver
/// holding either one verifies. The id stays the same on every attempt; the
/// timestamp, and so the signature, are new each time.
export async function signedHeaders(
  secrets: string[],
  id: string,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const signatures = await Promise.all(secrets.map((s) => sign(s, id, timestampSeconds, body)));
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestampSeconds),
    "webhook-signature": signatures.join(" "),
  };
}

/// Whether `raw` was signed with `secret` within the tolerance. Reads the
/// `webhook-*` headers, or the `svix-*` names Svix sends the same values
/// under. False, never a throw, for anything malformed.
export async function verify(
  raw: string,
  headers: Headers | Record<string, string>,
  secret: string,
  { nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = TOLERANCE_SECONDS } = {},
): Promise<boolean> {
  const get = (name: string) =>
    headers instanceof Headers ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()] ?? null;
  const id = get("webhook-id") ?? get("svix-id");
  const ts = get("webhook-timestamp") ?? get("svix-timestamp");
  const sigs = get("webhook-signature") ?? get("svix-signature");
  if (!id || !ts || !sigs || !secret) return false;

  const sent = Number(ts);
  if (!Number.isInteger(sent) || Math.abs(nowSeconds - sent) > toleranceSeconds) return false;

  let expected: string;
  try {
    expected = (await sign(secret, id, sent, raw)).slice(3);
  } catch {
    return false;
  }
  return sigs.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    return version === "v1" && sig !== undefined && timingSafeEqual(expected, sig);
  });
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  if (!bytes.length) throw new Error("webhook secret is empty");
  return await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
