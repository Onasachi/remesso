import { ACCESS_TTL, SCOPE, hostedEnabled, issuerFor, oauthError, resourceFor, supabaseServer } from "@/lib/oauth/server";
import { pkceMatches, seal, sign, unseal, verify, type Claims } from "@/lib/oauth/tokens";

/// Token endpoint for Claude, a public client: PKCE instead of a secret.
/// Claude sends application/x-www-form-urlencoded (RFC 6749 4.1.3), and must
/// get an answer inside 10 seconds (30 for a refresh).
export const dynamic = "force-dynamic";

type Code = Claims & { sub: string; email: string; cid: string; ru: string; cc: string; aud: string; rt: string };
type Refresh = { rt: string; cid: string; sub: string; email: string };

function issue(req: Request, r: Refresh) {
  const now = Math.floor(Date.now() / 1000);
  const access = sign({
    typ: "at",
    iss: issuerFor(req),
    aud: resourceFor(req),
    sub: r.sub,
    email: r.email,
    scope: SCOPE,
    exp: now + ACCESS_TTL,
  });
  return new Response(
    JSON.stringify({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: seal(JSON.stringify(r)),
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
    const rt = unseal(code.rt);
    if (!rt) return oauthError("invalid_grant", "the code is damaged");
    return issue(req, { rt, cid: code.cid, sub: code.sub, email: code.email });
  }

  if (grant === "refresh_token") {
    const raw = unseal(form.get("refresh_token") ?? "");
    let r: Refresh | null = null;
    try {
      r = raw ? (JSON.parse(raw) as Refresh) : null;
    } catch {
      r = null;
    }
    if (!r || r.cid !== clientId) return oauthError("invalid_grant", "unknown refresh token");
    // Supabase rotates the token and refuses a reused or signed-out one, so a
    // stolen copy stops working as soon as either party refreshes.
    const { data, error } = await supabaseServer().auth.refreshSession({ refresh_token: r.rt });
    if (error || !data.session || data.session.user.id !== r.sub) {
      return oauthError("invalid_grant", "the sign-in has ended; sign in again");
    }
    return issue(req, { ...r, rt: data.session.refresh_token });
  }

  return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
}
