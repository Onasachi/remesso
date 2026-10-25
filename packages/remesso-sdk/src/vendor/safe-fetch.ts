// Copied from web/lib/safe-fetch.ts by scripts/build-sdk.ts. Edit the original and re-run;
// `build-sdk.ts --check` fails while the two differ.
/// Fetch a stranger's URL without letting it reach anything private.
///
/// `find_agent` reads an agent's ERC-8004 registration file, and that URI is
/// whatever the agent's owner set: it could point at a cloud metadata address,
/// a router's admin page, or a service on the machine doing the fetching. So,
/// following OWASP's SSRF guidance (docs/agent-to-agent.md, 3c):
///   - HTTPS only, on the default port, with no credentials and no redirects;
///   - the name is resolved first, and every address it resolves to must be
///     public: no private, loopback, link-local, CGNAT, unique-local,
///     multicast, unspecified, reserved, documentation or benchmark range, in
///     IPv4 or IPv6, IPv4 inside IPv6 included;
///   - the connection goes to the address that was checked (node's `lookup`
///     hook), so DNS can't be switched under the check, while TLS still
///     verifies the certificate against the name;
///   - 5 seconds and 256 KB at most.
///
/// The Edge Functions have their own under the same rules
/// (`supabase/functions/_shared/safe-fetch.ts`); the local MCP wallet carries
/// a copy (`mcp/src/safe-fetch.mjs`), since its bundle can't import from here.
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";

function v4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const o = parts.map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function v4Public([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  return a < 224; // multicast, reserved and broadcast above
}

/// Eight 16-bit groups, or null. Handles `::`, a zone id and a dotted-quad tail.
function v6Groups(raw: string): number[] | null {
  let s = raw.split("%")[0].toLowerCase();
  const last = s.lastIndexOf(":");
  const tail = s.slice(last + 1);
  if (tail.includes(".")) {
    const o = v4Octets(tail);
    if (!o) return null;
    s = `${s.slice(0, last + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v6Public(g: number[]): boolean {
  const zero = (n: number) => g.slice(0, n).every((x) => x === 0);
  const inner = () => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (zero(8)) return false; // ::
  if (zero(7) && g[7] === 1) return false; // ::1
  if (zero(5) && g[5] === 0xffff) return v4Public(inner()); // ::ffff:a.b.c.d
  if (zero(6)) return v4Public(inner()); // ::a.b.c.d, deprecated
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Public(inner()); // NAT64
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return false; // 100::/64, discard-only
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return false; // documentation, Teredo
  if (g[0] === 0x2002) return false; // 6to4 carries an IPv4 we'd have to trust
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false; // link-local, site-local
  return (g[0] & 0xff00) !== 0xff00; // multicast
}

/// Whether an address is safe to connect to: public, in either family.
export function isPublicIp(ip: string): boolean {
  if (ip.includes(":")) {
    const g = v6Groups(ip.replace(/^\[|\]$/g, ""));
    return g !== null && v6Public(g);
  }
  const o = v4Octets(ip);
  return o !== null && v4Public(o);
}

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;

/// The body of `raw`, as text, under the rules above. Throws, naming the rule,
/// on anything else.
export async function safeFetchText(raw: string): Promise<string> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("only https URLs are fetched");
  if (url.username || url.password) throw new Error("a URL with credentials in it is refused");
  if (url.port && url.port !== "443") throw new Error("only the default HTTPS port is fetched");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const found: LookupAddress[] = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!found.length) throw new Error(`${host} doesn't resolve`);
  const bad = found.find((a) => !isPublicIp(a.address));
  if (bad) throw new Error(`${host} resolves to ${bad.address}, which isn't a public address`);
  const pinned = found[0];
  // The connection goes to the address just checked. Newer Node asks for every
  // address at once (`all`), older for one.
  const pin: LookupFunction = (_name, opts, cb) => {
    if (opts.all) cb(null, [pinned]);
    else cb(null, pinned.address, pinned.family);
  };

  return await new Promise<string>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json, text/plain;q=0.5", "user-agent": "remesso-find-agent" },
        lookup: pin,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`${host} answered ${status}${status >= 300 && status < 400 ? ", a redirect, which isn't followed" : ""}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) req.destroy(new Error(`${host} sent more than ${MAX_BYTES / 1024} KB`));
          else chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`${host} didn't answer within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}
