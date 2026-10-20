import { authorizationServerMetadata, hostedEnabled, protectedResourceMetadata } from "@/lib/oauth/server";

/// Both discovery documents, served at their /.well-known paths by rewrites in
/// next.config.mjs: the App Router ignores path segments that begin with a dot.
///   /.well-known/oauth-protected-resource[/mcp] -> ?doc=resource
///   /.well-known/oauth-authorization-server     -> ?doc=server
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  // While hands-free payments are switched off there is nothing to sign in
  // to, and a 404 here keeps Claude from offering a sign-in that cannot work.
  if (!hostedEnabled()) return new Response("not found", { status: 404 });
  // Behind a rewrite the request still carries the original path, and the
  // destination's ?doc= may not arrive, so the path decides.
  const url = new URL(req.url);
  const server = url.pathname.includes("oauth-authorization-server") || url.searchParams.get("doc") === "server";
  const body = server ? authorizationServerMetadata(req) : protectedResourceMetadata(req);
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
