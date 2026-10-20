/// The connector's authorization server: one scope, `wallet`, which lets Claude
/// act as the person's hosted Remesso agent within the limits they set
/// on-chain. Everything else the connector does needs no sign-in at all.
///
/// The person is identified by a Supabase email code, not a wallet signature:
/// MiniPay cannot sign messages, and a link opened from the Claude app lands in
/// a browser with no wallet. The money side never depends on this identity —
/// the agent spends only through a RemessoAgentAllowance policy that the owner
/// of the funds signs in their own wallet.

import { createClient } from "@supabase/supabase-js";

export const SCOPE = "wallet";
export const ACCESS_TTL = 60 * 60; // an hour; Claude refreshes ahead of expiry
export const CODE_TTL = 120;

/// The issuer and the resource follow the host that answered, so a preview
/// deployment or `next dev` issues tokens for itself, never for production.
export const issuerFor = (req: Request) => new URL(req.url).origin;
export const resourceFor = (req: Request) => `${issuerFor(req)}/mcp`;

export function hostedEnabled(): boolean {
  return process.env.HOSTED_AGENT_ENABLED === "1";
}

/// Invite-only until the legal question is answered: when HOSTED_AGENT_EMAILS
/// is set, only those addresses can finish signing in. Unset means open to all.
export function invited(email: string): boolean {
  const list = (process.env.HOSTED_AGENT_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(email.trim().toLowerCase());
}

export function protectedResourceMetadata(req: Request) {
  return {
    resource: resourceFor(req),
    authorization_servers: [issuerFor(req)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Remesso",
  };
}

export function authorizationServerMetadata(req: Request) {
  const iss = issuerFor(req);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/api/oauth/token`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // Claude's client is public: PKCE, no secret. Advertising both of these
    // is what makes Claude identify itself with its metadata document.
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  };
}

/// A Supabase client that keeps nothing between calls: the server only ever
/// checks a token it is handed or exchanges a refresh token it holds sealed.
export function supabaseServer() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export const oauthError = (error: string, description: string, status = 400) =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
