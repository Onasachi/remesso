import { handleRpc } from "@/lib/mcp/protocol";
import { remessoTools, SERVER, serverIcons } from "@/lib/mcp/tools";
import { HOSTED_TOOL_NAMES, hostedTools } from "@/lib/mcp/hosted";
import { SCOPE, hostedEnabled, issuerFor, resourceFor } from "@/lib/oauth/server";
import { verify, type Claims } from "@/lib/oauth/tokens";

/// The Remesso connector: add `https://remesso.xyz/mcp` in
/// claude.ai (Customize > Connectors > Add custom connector) and it follows the
/// person to Claude on desktop, iOS and Android. Claude reaches it from
/// Anthropic's servers, so it is a public MCP endpoint; see lib/mcp/tools.ts
/// for why most of it needs no sign-in and holds no keys.
///
/// Sign-in is lazy. Everyone gets the link tools. The hosted agent's tools
/// (lib/mcp/hosted.ts) need a signed-in person, and calling one without a
/// token gets a 401 here, before any tool runs, which is the only answer that
/// makes Claude show its Connect card and retry after sign-in. A 200 with an
/// error inside would just be read out as text.
///
/// Streamable HTTP without a session: every POST carries one JSON-RPC message
/// and gets one JSON answer, so it runs as an ordinary serverless function with
/// nothing to keep between requests.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Access = Claims & { sub: string; aud: string; iss: string; scope: string };

/// The signed-in person's id, or null. A token for another resource, another
/// issuer or without the wallet scope counts as no token.
function person(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const t = verify<Access>(m[1], "at");
  if (!t || t.aud !== resourceFor(req) || t.iss !== issuerFor(req) || !String(t.scope).split(" ").includes(SCOPE)) return null;
  return t.sub;
}

export async function POST(req: Request) {
  let msg: unknown;
  try {
    msg = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  // Batches left the protocol in 2025-06-18; answering one message at a time
  // keeps every request small and its cost bounded.
  if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "send one JSON-RPC message per request" } }, 400);
  }
  const rpc = msg as Parameters<typeof handleRpc>[0];
  const who = hostedEnabled() ? person(req) : null;

  if (hostedEnabled() && !who && rpc.method === "tools/call" && HOSTED_TOOL_NAMES.has(String(rpc.params?.name))) {
    const origin = issuerFor(req);
    return json(
      { error: "invalid_token", error_description: "Sign in to Remesso to use your hands-free agent" },
      401,
      {
        "www-authenticate":
          `Bearer error="invalid_token", error_description="Sign in to Remesso to use your hands-free agent", ` +
          `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`,
      },
    );
  }

  // Links in tool results point back at whichever deployment answered, so a
  // preview deployment links to itself rather than to production.
  const origin = new URL(req.url).origin;
  const tools = [...remessoTools(origin), ...(hostedEnabled() ? hostedTools(origin, who) : [])];
  const out = await handleRpc(rpc, tools, { ...SERVER, icons: serverIcons(origin) });
  return out === undefined ? new Response(null, { status: 202 }) : json(out);
}

/// No server-to-client stream is offered; the spec's answer to a GET is 405.
export function GET() {
  return new Response("Remesso MCP endpoint: POST JSON-RPC here. Add this URL as a custom connector in Claude.", {
    status: 405,
    headers: { allow: "POST" },
  });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
