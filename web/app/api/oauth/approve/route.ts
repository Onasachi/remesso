import { loadClient, redirectAllowed } from "@/lib/oauth/clients";
import { CODE_TTL, SCOPE, hostedEnabled, invited, resourceFor, supabaseServer } from "@/lib/oauth/server";
import { seal, sign } from "@/lib/oauth/tokens";

/// The consent page's "Allow": everything the page showed is checked again
/// here, because the page runs in a browser and proves nothing. The person is
/// identified by the Supabase session their email code produced; its refresh
/// token travels inside the code, sealed, and becomes Claude's refresh token.
export const dynamic = "force-dynamic";

type Body = {
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  access_token?: string;
  refresh_token?: string;
};

const fail = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } });

export async function POST(req: Request) {
  if (!hostedEnabled()) return fail("hands-free payments are not open yet", 403);
  const b = (await req.json().catch(() => ({}))) as Body;
  if (!b.client_id || !b.redirect_uri || !b.code_challenge || b.code_challenge_method !== "S256") {
    return fail("incomplete authorization request");
  }
  let client;
  try {
    client = await loadClient(b.client_id);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!redirectAllowed(client, b.redirect_uri)) return fail("redirect_uri is not registered for this client");
  if (b.scope && !b.scope.split(" ").every((s) => s === SCOPE || s === "offline_access")) return fail("unknown scope");
  if (!b.access_token || !b.refresh_token) return fail("sign in with your email code first", 401);

  const { data, error } = await supabaseServer().auth.getUser(b.access_token);
  if (error || !data.user?.email) return fail("that sign-in has expired; enter a new code", 401);
  if (!invited(data.user.email)) return fail("Hands-free payments are invite-only for now. The link tools work without signing in.", 403);

  const code = sign({
    typ: "code",
    sub: data.user.id,
    email: data.user.email,
    cid: client.id,
    ru: b.redirect_uri,
    cc: b.code_challenge,
    scope: SCOPE,
    aud: resourceFor(req),
    rt: seal(b.refresh_token),
    exp: Math.floor(Date.now() / 1000) + CODE_TTL,
  });
  const to = new URL(b.redirect_uri);
  to.searchParams.set("code", code);
  if (b.state) to.searchParams.set("state", b.state);
  to.searchParams.set("iss", new URL(req.url).origin); // RFC 9207
  return new Response(JSON.stringify({ redirect: to.toString() }), { headers: { "content-type": "application/json" } });
}
