/// Tokens for the connector's sign-in, signed and sealed with one server
/// secret (`OAUTH_SECRET`), so the authorization server keeps no table.
///
/// - Authorization codes and access tokens are HS256 JWTs: short-lived, and
///   checked on every request without a lookup.
/// - The refresh token Claude holds is the person's Supabase refresh token,
///   sealed with AES-256-GCM. Refreshing exchanges it with Supabase, which
///   rotates it, detects reuse and honours sign-out, so none of that has to be
///   rebuilt here. Sealing keeps the Supabase token itself out of Claude's hands.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function secret(): Buffer {
  const s = process.env.OAUTH_SECRET ?? "";
  // 32 random bytes, base64: anything shorter is a configuration mistake, and
  // signing tokens with it would be worse than refusing to start.
  if (s.length < 40) throw new Error("OAUTH_SECRET is missing or too short");
  return Buffer.from(s, "base64");
}
/// Separate keys for signing and sealing, derived from the one secret.
const subkey = (purpose: string) => createHash("sha256").update(secret()).update(purpose).digest();

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export type Claims = Record<string, unknown> & { exp: number; typ: string };

export function sign(claims: Claims): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iat: Math.floor(Date.now() / 1000), ...claims }));
  const mac = createHmac("sha256", subkey("jwt")).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64u(mac)}`;
}

/// The claims, or null for anything forged, malformed, of another type or expired.
export function verify<T extends Claims>(token: string, typ: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const want = createHmac("sha256", subkey("jwt")).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as T;
    if (claims.typ !== typ) return null;
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", subkey("seal"), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), enc]));
}

export function unseal(sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    const d = createDecipheriv("aes-256-gcm", subkey("seal"), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/// PKCE S256: BASE64URL(SHA256(verifier)) must equal the challenge.
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const got = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}
