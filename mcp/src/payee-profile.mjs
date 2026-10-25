// An agent's payee profile, from its ERC-8004 registration file: the copy the
// local wallet carries. The rules and their reasons are in
// web/lib/payee-profile.ts, whose test pins them (docs/agent-to-agent.md, 3d;
// docs/AGENTS.md). It never yields an address to pay: that comes only from
// the registry's getAgentWallet.

export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export function uriSource(uri) {
  const u = String(uri).trim();
  if (u.startsWith("data:")) {
    const comma = u.indexOf(",");
    if (comma < 0) return { kind: "unsupported", reason: "a data: URI without data" };
    const meta = u.slice(5, comma);
    const body = u.slice(comma + 1);
    try {
      const json = /;base64$/i.test(meta) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
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

export function payeeProfile(doc) {
  if (!doc || typeof doc !== "object") return { profile: null, note: "the registration file isn't a JSON object" };
  const list = Array.isArray(doc.services) ? doc.services : Array.isArray(doc.endpoints) ? doc.endpoints : [];
  const entry = list.find((s) => s && typeof s === "object" && s.name === "remesso");
  if (!entry) return { profile: null, note: "no remesso entry in its services" };
  if (String(entry.version ?? "") !== "1") {
    return { profile: null, note: `a remesso entry of version ${String(entry.version ?? "none")}, which this reader doesn't implement` };
  }
  const assets = (Array.isArray(entry.assets) ? entry.assets : [])
    .filter((a) => a && typeof a === "object" && CAIP2.test(String(a.network)) && ADDRESS.test(String(a.asset)))
    .map((a) => ({ network: a.network, asset: a.asset }));
  const ref = entry.reference;
  return {
    profile: {
      version: "1",
      endpoint: typeof entry.endpoint === "string" && entry.endpoint.startsWith("https://") ? entry.endpoint : null,
      assets,
      reference: ref && typeof ref.required === "boolean" ? { required: ref.required } : null,
    },
  };
}
