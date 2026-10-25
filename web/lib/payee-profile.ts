/// An agent's payee profile: the `remesso` entry in the `services` list of its
/// ERC-8004 registration file (docs/agent-to-agent.md, 3d; docs/AGENTS.md).
///
/// It says which tokens the agent accepts and whether a payment must carry a
/// reference. It never says where to pay: the registration file can be
/// rewritten by the token's owner at any time, so the address comes only from
/// the registry's `getAgentWallet`, which only the wallet's own signature can
/// set. Nothing here returns an address to pay.
///
/// Pure, so both servers read files the same way. The local MCP wallet carries
/// a copy (`mcp/src/payee-profile.mjs`).

export type PayeeProfile = {
  version: "1";
  /// Remesso's request service, where a payer checks and answers a request.
  endpoint: string | null;
  /// The tokens accepted: the chain as CAIP-2, and the token's address.
  assets: { network: string; asset: string }[];
  /// Whether a payment must carry the payee's request id. Null: none needed.
  reference: { required: boolean } | null;
};

/// Where a token URI's JSON is: inline in a `data:` URI, or at a URL to fetch
/// (an `ipfs:` URI through a public gateway).
export type UriSource =
  | { kind: "inline"; json: string }
  | { kind: "fetch"; url: string }
  | { kind: "unsupported"; reason: string };

export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export function uriSource(uri: string): UriSource {
  const u = uri.trim();
  if (u.startsWith("data:")) {
    const comma = u.indexOf(",");
    if (comma < 0) return { kind: "unsupported", reason: "a data: URI without data" };
    const meta = u.slice(5, comma);
    const body = u.slice(comma + 1);
    try {
      const json = /;base64$/i.test(meta)
        ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))
        : decodeURIComponent(body);
      return { kind: "inline", json };
    } catch {
      return { kind: "unsupported", reason: "a data: URI that doesn't decode" };
    }
  }
  if (u.startsWith("https://")) return { kind: "fetch", url: u };
  if (u.startsWith("ipfs://")) {
    const path = u.slice(7).replace(/^ipfs\//, "");
    if (!/^[a-zA-Z0-9]+(\/[^\s?#]*)?$/.test(path)) return { kind: "unsupported", reason: "an ipfs: URI that isn't a CID" };
    return { kind: "fetch", url: `${IPFS_GATEWAY}${path}` };
  }
  return { kind: "unsupported", reason: `${u.split(":")[0] || "an empty"} URIs aren't read` };
}

const CAIP2 = /^eip155:\d{1,12}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/// The `remesso` entry of a registration file, under the reader's rules:
/// unknown fields are ignored, and a version this reader doesn't implement
/// counts as no profile at all.
export function payeeProfile(doc: unknown): { profile: PayeeProfile | null; note?: string } {
  if (!doc || typeof doc !== "object") return { profile: null, note: "the registration file isn't a JSON object" };
  const d = doc as Record<string, unknown>;
  // `services` replaced `endpoints` in the spec on 2026-01-25; older files use the old name.
  const list = Array.isArray(d.services) ? d.services : Array.isArray(d.endpoints) ? d.endpoints : [];
  const entry = list.find((s) => s && typeof s === "object" && (s as Record<string, unknown>).name === "remesso") as
    | Record<string, unknown>
    | undefined;
  if (!entry) return { profile: null, note: "no remesso entry in its services" };
  if (String(entry.version ?? "") !== "1") {
    return { profile: null, note: `a remesso entry of version ${String(entry.version ?? "none")}, which this reader doesn't implement` };
  }
  const assets = (Array.isArray(entry.assets) ? entry.assets : [])
    .filter((a): a is { network: string; asset: string } =>
      !!a && typeof a === "object" && CAIP2.test(String((a as Record<string, unknown>).network)) &&
      ADDRESS.test(String((a as Record<string, unknown>).asset)))
    .map((a) => ({ network: a.network, asset: a.asset }));
  const ref = entry.reference as Record<string, unknown> | undefined;
  return {
    profile: {
      version: "1",
      endpoint: typeof entry.endpoint === "string" && entry.endpoint.startsWith("https://") ? entry.endpoint : null,
      assets,
      reference: ref && typeof ref.required === "boolean" ? { required: ref.required } : null,
    },
  };
}
