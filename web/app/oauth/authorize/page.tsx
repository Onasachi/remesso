import { redirect } from "next/navigation";
import { loadClient, redirectAllowed } from "@/lib/oauth/clients";
import { SCOPE, hostedEnabled } from "@/lib/oauth/server";
import { AuthorizeFlow } from "./AuthorizeFlow";

/// Where Claude sends a person to let it act as their hosted Remesso agent.
///
/// The request is checked here, on the server, before anything renders. A bad
/// client or redirect is shown as an error on this page and never redirected
/// to, because a redirect is exactly what an attacker would want to steer.
export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function Problem({ text }: { text: string }) {
  return (
    <div className="stagger mt-10">
      <h1 className="font-display text-[30px] leading-[1.1] text-ink">This sign-in link can&apos;t be used.</h1>
      <p className="mt-4 max-w-md text-[16px] leading-relaxed text-ink-2">{text}</p>
    </div>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Params }) {
  if (!hostedEnabled()) return <Problem text="Hands-free payments through Claude are not open yet." />;

  const clientId = one(searchParams.client_id);
  const redirectUri = one(searchParams.redirect_uri);
  let client;
  try {
    client = await loadClient(clientId);
  } catch (e) {
    return <Problem text={(e as Error).message} />;
  }
  if (!redirectAllowed(client, redirectUri)) return <Problem text="The app asked to send the answer somewhere it never registered." />;

  // From here the redirect is trusted, so request errors go back to the app.
  const state = one(searchParams.state);
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    redirect(u.toString());
  };
  if (one(searchParams.response_type) !== "code") back("unsupported_response_type", "only the code flow is supported");
  const challenge = one(searchParams.code_challenge);
  if (!challenge || one(searchParams.code_challenge_method) !== "S256") back("invalid_request", "PKCE with S256 is required");
  const scope = one(searchParams.scope) || SCOPE;
  if (!scope.split(" ").every((s) => s === SCOPE || s === "offline_access")) back("invalid_scope", `the only scope is ${SCOPE}`);

  return (
    <AuthorizeFlow
      clientId={client.id}
      clientHost={client.host}
      redirectUri={redirectUri}
      redirectHost={new URL(redirectUri).host}
      state={state}
      codeChallenge={challenge}
      scope={scope}
    />
  );
}
