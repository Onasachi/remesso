import { handleRpc } from "@/lib/mcp/protocol";
import { remessoTools, SERVER } from "@/lib/mcp/tools";

/// The Remesso connector: add `https://remesso.crackedstudios.xyz/mcp` in
/// claude.ai (Customize > Connectors > Add custom connector) and it follows the
/// person to Claude on desktop, iOS and Android. Claude reaches it from
/// Anthropic's servers, so it is a public, authless MCP endpoint; see
/// lib/mcp/tools.ts for why it needs no sign-in and holds no keys.
///
/// Streamable HTTP without a session: every POST carries one JSON-RPC message
/// and gets one JSON answer, so it runs as an ordinary serverless function with
/// nothing to keep between requests.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  // Links in tool results point back at whichever deployment answered, so a
  // preview deployment links to itself rather than to production.
  const origin = new URL(req.url).origin;
  const out = await handleRpc(msg as Parameters<typeof handleRpc>[0], remessoTools(origin), SERVER);
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
