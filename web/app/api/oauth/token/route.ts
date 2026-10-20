import { ACCESS_TTL, SCOPE, hostedEnabled, issuerFor, oauthError, resourceFor } from "@/lib/oauth/server";
import { newRefresh, useRefresh } from "@/lib/oauth/sessions";
import { pkceMatches, sign, verify, type Claims } from "@/lib/oauth/tokens";

/// Token endpoint for Claude, a public client: PKCE instead of a secret.
/// Claude sends application/x-www-form-urlencoded (RFC 6749 4.1.3), and must
/// get an answer inside 10 seconds (30 for a refresh).
export const dynamic = "force-dynamic";

type Code = Claims & { sub: string; pid: string; email: string; cid: string; ru: string; cc: string; aud: string };

async function issue(req: Request, p: { sub: string; pid: string; cid: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  const access = sign({
    typ: "at",
    iss: issuerFor(req),
    aud: resourceFor(req),
    sub: p.sub,
    pid: p.pid,
    email: p.email,
    scope: SCOPE,
    exp: now + ACCESS_TTL,
  });
  return new Response(
    JSON.stringify({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: await newRefresh(p),
      scope: SCOPE,
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" } },
  );
}

export async function POST(req: Request) {
  if (!hostedEnabled()) return oauthError("invalid_request", "hands-free payments are not open yet");
  const form = new URLSearchParams(await req.text());
  const grant = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";

  if (grant === "authorization_code") {
    const code = verify<Code>(form.get("code") ?? "", "code");
    if (!code) return oauthError("invalid_grant", "the code is invalid or has expired");
    if (code.cid !== clientId) return oauthError("invalid_grant", "the code was issued to another client");
    if (code.ru !== form.get("redirect_uri")) return oauthError("invalid_grant", "redirect_uri does not match");
    if (code.aud !== resourceFor(req)) return oauthError("invalid_grant", "the code was issued for another resource");
    if (!pkceMatches(form.get("code_verifier") ?? "", code.cc)) return oauthError("invalid_grant", "PKCE verification failed");
    return issue(req, { sub: code.sub, pid: code.pid, cid: code.cid, email: code.email });
  }

  if (grant === "refresh_token") {
    // Rotated on every use; an old one presented again ends the session.
    const r = await useRefresh(form.get("refresh_token") ?? "", clientId);
    if (!r) return oauthError("invalid_grant", "the sign-in has ended; sign in again");
    return issue(req, { sub: r.sub, pid: r.pid, cid: r.cid, email: r.email });
  }

  return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
}
