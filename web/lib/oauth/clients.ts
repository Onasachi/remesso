/// Which apps may ask a person for access to their Remesso agent, and where
/// the answer may be sent.
///
/// Claude identifies itself with a Client ID Metadata Document: its client_id
/// is an HTTPS URL serving a JSON document that lists its redirect URIs, so no
/// registration is stored here. Only Anthropic's hosts are accepted for now —
/// this authorizes an agent that can spend, and a self-asserted document from
/// anywhere would let any site that can phish a consent click collect a token.

const ALLOWED_CLIENT_HOSTS = new Set(["claude.ai", "claude.com", "www.claude.ai", "www.claude.com"]);
const CACHE = new Map<string, { at: number; doc: ClientDoc }>();
const CACHE_MS = 60 * 60 * 1000;

export type ClientDoc = { client_id: string; client_name?: string; redirect_uris: string[] };
export type Client = { id: string; host: string; name: string; redirectUris: string[] };

export async function loadClient(clientId: string): Promise<Client> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new Error("client_id must be the URL of a client metadata document");
  }
  if (url.protocol !== "https:" || !ALLOWED_CLIENT_HOSTS.has(url.hostname)) {
    throw new Error(`client ${url.hostname} is not allowed to connect to Remesso`);
  }
  const hit = CACHE.get(clientId);
  let doc = hit && Date.now() - hit.at < CACHE_MS ? hit.doc : undefined;
  if (!doc) {
    const res = await fetch(clientId, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`could not read the client document (${res.status})`);
    doc = (await res.json()) as ClientDoc;
    // The document must name itself, or it could be a copy served elsewhere.
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) throw new Error("the client document does not describe this client");
    CACHE.set(clientId, { at: Date.now(), doc });
  }
  return { id: clientId, host: url.hostname, name: doc.client_name ?? url.hostname, redirectUris: doc.redirect_uris };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/// Exact match, except that loopback redirects ignore the port: Claude Code
/// listens on whichever port is free (RFC 8252 7.3, and localhost likewise).
export function redirectAllowed(client: Client, redirectUri: string): boolean {
  let want: URL;
  try {
    want = new URL(redirectUri);
  } catch {
    return false;
  }
  return client.redirectUris.some((r) => {
    if (r === redirectUri) return true;
    try {
      const have = new URL(r);
      return (
        LOOPBACK.has(have.hostname) && have.hostname === want.hostname && have.protocol === "http:" &&
        want.protocol === "http:" && have.pathname === want.pathname
      );
    } catch {
      return false;
    }
  });
}
