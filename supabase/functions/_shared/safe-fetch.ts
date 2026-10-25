/// Fetching a URL somebody else chose, without letting it reach inside our
/// network (docs/agent-to-agent.md, 3c; OWASP's SSRF prevention cheat sheet).
///
/// A webhook endpoint, or an agent's ERC-8004 metadata URI, is a URL anyone can
/// set. Fetched naively, `https://169.254.169.254/…`, or a name that resolves
/// to 10.0.0.1, turns our function into a probe of whatever it can reach. So:
///
///   - HTTPS only, no credentials in the URL, and no redirects: a 3xx is a
///     failure, never followed;
///   - the name is resolved first, and every address it resolves to must be
///     public. No private, loopback, link-local, CGNAT, unique-local,
///     multicast, unspecified, documentation or benchmark ranges, in IPv4 or
///     IPv6, and none smuggled inside an IPv6 form that embeds IPv4;
///   - the connection goes to an address that was checked, so DNS can't answer
///     one thing to the check and another to the connect (rebinding). It is a
///     TCP connection to the checked IP, then TLS with the URL's hostname, so
///     the certificate is still verified against the name;
///   - a timeout over the whole exchange, and a cap on the response.
///
/// fetch() can't be pinned: `Deno.createHttpClient` has no resolver option.
/// So the request is written as HTTP/1.1 over the pinned TLS connection,
/// which is all a webhook POST or a metadata GET needs. Where the runtime has
/// no `Deno.startTls`, it falls back to fetch() straight after the check,
/// which leaves a rebinding window between the two lookups; the fix then is
/// an egress proxy that enforces the same address rules itself.

export class SafeFetchError extends Error {
  override name = "SafeFetchError";
}

export type SafeRequest = { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string };
export type SafeResponse = { status: number; headers: Headers; text: string };
type Raw = { status: number; headers: Headers; body: Uint8Array };

/// How the bytes travel once the address is checked. Swappable for tests.
export type Transport = (ip: string, url: URL, req: SafeRequest, limits: Limits) => Promise<Raw>;
export type Limits = { timeoutMs: number; maxBytes: number };

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

export async function safeFetch(
  url: string,
  req: SafeRequest = {},
  opts: Partial<Limits> & { resolve?: (host: string) => Promise<string[]>; transport?: Transport } = {},
): Promise<SafeResponse> {
  const limits = { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES };
  const u = checkUrl(url);
  const host = bare(u.hostname);
  const ips = isIp(host) ? [host] : await (opts.resolve ?? resolveAll)(host);
  if (!ips.length) throw new SafeFetchError(`${host} doesn't resolve`);
  // Every answer, not just the first: a name that answers one public and one
  // private address is refused, or a second lookup could get the private one.
  const inside = ips.find((ip) => !isPublicIp(ip));
  if (inside) {
    throw new SafeFetchError(
      isIp(host) ? `${host} isn't a public address` : `${host} resolves to ${inside}, which isn't a public address`,
    );
  }

  const ip = ips.find((a) => parseIPv4(a) !== null) ?? ips[0];
  const res = await (opts.transport ?? pinned)(ip, u, req, limits);
  if (res.status >= 300 && res.status < 400) {
    throw new SafeFetchError(`refused a redirect (${res.status}) from ${u.host}`);
  }
  return { status: res.status, headers: res.headers, text: new TextDecoder().decode(res.body) };
}

/// The URL as we will call it: HTTPS, a host, no credentials.
export function checkUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SafeFetchError("not a URL");
  }
  if (u.protocol !== "https:") throw new SafeFetchError("only https URLs are fetched");
  if (u.username || u.password) throw new SafeFetchError("a URL with credentials isn't fetched");
  if (!u.hostname) throw new SafeFetchError("the URL has no host");
  return u;
}

async function resolveAll(host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.allSettled([Deno.resolveDns(host, "A"), Deno.resolveDns(host, "AAAA")]);
  const ips = [...(a.status === "fulfilled" ? a.value : []), ...(aaaa.status === "fulfilled" ? aaaa.value : [])];
  if (!ips.length && a.status === "rejected" && aaaa.status === "rejected") {
    throw new SafeFetchError(`${host} doesn't resolve`);
  }
  return ips;
}

// ---- addresses ----

const bare = (host: string) => host.replace(/^\[|\]$/g, "");
const isIp = (s: string) => parseIPv4(s) !== null || parseIPv6(s) !== null;

/// Whether `ip` is a public unicast address we may connect to. Anything that
/// doesn't parse is not.
export function isPublicIp(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return publicV4(v4);
  const v6 = parseIPv6(ip);
  return v6 !== null && publicV6(v6);
}

/// IPv4 ranges that are not the public internet (IANA special-purpose
/// registry), as [first address, prefix length].
const V4_BLOCKED: Array<[number, number]> = [
  [ip4(0, 0, 0, 0), 8], //         "this network"
  [ip4(10, 0, 0, 0), 8], //        private
  [ip4(100, 64, 0, 0), 10], //     carrier-grade NAT
  [ip4(127, 0, 0, 0), 8], //       loopback
  [ip4(169, 254, 0, 0), 16], //    link-local, and every cloud's metadata service
  [ip4(172, 16, 0, 0), 12], //     private
  [ip4(192, 0, 0, 0), 24], //      IETF protocol assignments
  [ip4(192, 0, 2, 0), 24], //      documentation
  [ip4(192, 88, 99, 0), 24], //    6to4 relay anycast
  [ip4(192, 168, 0, 0), 16], //    private
  [ip4(198, 18, 0, 0), 15], //     benchmarking
  [ip4(198, 51, 100, 0), 24], //   documentation
  [ip4(203, 0, 113, 0), 24], //    documentation
  [ip4(224, 0, 0, 0), 4], //       multicast
  [ip4(240, 0, 0, 0), 4], //       reserved, and broadcast
];

function ip4(a: number, b: number, c: number, d: number) {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function publicV4(n: number): boolean {
  return !V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

/// Strict dotted decimal: what DNS answers and what the URL parser normalises
/// every IPv4 spelling (hex, octal, shortened) to. Anything else is not v4.
export function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/// Eight 16-bit groups, or null. `::` compression and a trailing dotted IPv4
/// are understood; a zone (`%eth0`) is refused outright.
export function parseIPv6(s: string): number[] | null {
  if (!s.includes(":") || s.includes("%")) return null;
  let text = s;
  const tail: number[] = [];
  // A trailing dotted IPv4 (::ffff:1.2.3.4) stands for the last two groups.
  const last = text.slice(text.lastIndexOf(":") + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (v4 === null) return null;
    tail.push(v4 >>> 16, v4 & 0xffff);
    text = text.slice(0, text.length - last.length);
    if (!text.endsWith("::")) text = text.slice(0, -1); // drop the separator, keep a "::"
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !rest) return null;
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1) return given === 8 ? [...head, ...tail] : null;
  if (given > 7) return null;
  return [...head, ...new Array(8 - given).fill(0), ...rest, ...tail];
}

function publicV6(w: number[]): boolean {
  const embedded = () => ((w[6] << 16) | w[7]) >>> 0;
  const zeroUntil = (i: number) => w.slice(0, i).every((x) => x === 0);

  // IPv4-mapped (::ffff:a.b.c.d): judged as the IPv4 it carries.
  if (zeroUntil(5) && w[5] === 0xffff) return publicV4(embedded());
  // The well-known NAT64 prefix (64:ff9b::/96) carries an IPv4 too.
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return publicV4(embedded());
  // Global unicast is 2000::/3. Everything outside it is refused: unspecified,
  // loopback, IPv4-compatible, discard-only, unique-local, link-local,
  // site-local, multicast.
  if ((w[0] & 0xe000) !== 0x2000) return false;
  if (w[0] === 0x2001 && w[1] < 0x0200) return false; //  2001::/23 IETF assignments: Teredo, benchmarking, ORCHID
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false; // 2001:db8::/32 documentation
  if (w[0] === 0x2002) return false; //                    2002::/16 6to4, an IPv4 in disguise
  if (w[0] === 0x3fff && w[1] < 0x1000) return false; //   3fff::/20 documentation
  return true;
}

// ---- the pinned exchange ----

/// TCP to the checked address, TLS with the URL's hostname, one HTTP/1.1
/// request with `Connection: close`, read to the end.
const pinned: Transport = async (ip, url, req, { timeoutMs, maxBytes }) => {
  if (typeof Deno.startTls !== "function") return await unpinned(ip, url, req, { timeoutMs, maxBytes });
  const deadline = AbortSignal.timeout(timeoutMs);
  let conn: Deno.Conn | null = null;
  const onAbort = () => {
    try {
      conn?.close();
    } catch { /* already closed */ }
  };
  deadline.addEventListener("abort", onAbort);
  try {
    const tcp = await Deno.connect({ hostname: ip, port: Number(url.port || 443), signal: deadline });
    conn = tcp;
    const tls = await Deno.startTls(tcp, { hostname: bare(url.hostname), alpnProtocols: ["http/1.1"] });
    conn = tls;
    await writeAll(tls, encodeRequest(url, req));
    return parseHttpResponse(await readAll(tls, maxBytes + MAX_HEADER_BYTES), maxBytes);
  } catch (e) {
    if (deadline.aborted) throw new SafeFetchError(`no answer from ${url.host} within ${timeoutMs}ms`);
    if (e instanceof SafeFetchError) throw e;
    throw new SafeFetchError(`could not reach ${url.host}: ${(e as Error).message}`);
  } finally {
    deadline.removeEventListener("abort", onAbort);
    onAbort();
  }
};

/// Only where the runtime can't pin. The name is checked again right before
/// fetch() resolves it, which narrows the rebinding window without closing it.
const unpinned: Transport = async (_ip, url, req, { timeoutMs, maxBytes }) => {
  const res = await fetch(url, {
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length > maxBytes) throw new SafeFetchError(`the response from ${url.host} is over ${maxBytes} bytes`);
  return { status: res.status, headers: res.headers, body };
};

export function encodeRequest(url: URL, req: SafeRequest): Uint8Array {
  const method = req.method ?? "GET";
  const body = req.body === undefined ? null : new TextEncoder().encode(req.body);
  const lines = [
    `${method} ${url.pathname || "/"}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "User-Agent: Remesso/1 (+https://remesso.xyz)",
    "Accept: */*",
    "Connection: close",
  ];
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (/[\r\n:]/.test(k) || /[\r\n]/.test(v)) throw new SafeFetchError(`header ${k} has a line break in it`);
    if (/^(host|connection|content-length|transfer-encoding)$/i.test(k)) continue;
    lines.push(`${k}: ${v}`);
  }
  if (body || method === "POST") lines.push(`Content-Length: ${body?.length ?? 0}`);
  const head = new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n");
  if (!body) return head;
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array) {
  let off = 0;
  while (off < bytes.length) off += await conn.write(bytes.subarray(off));
}

async function readAll(conn: Deno.Conn, cap: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const buf = new Uint8Array(16 * 1024);
  for (;;) {
    const n = await conn.read(buf);
    if (n === null) break;
    total += n;
    if (total > cap) throw new SafeFetchError(`the response is over ${cap} bytes`);
    chunks.push(buf.slice(0, n));
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/// One HTTP/1.1 response: status, headers, and the body, de-chunked. Interim
/// 1xx responses are skipped. Pure, for the tests.
export function parseHttpResponse(raw: Uint8Array, maxBytes: number): Raw {
  let rest = raw;
  for (;;) {
    const end = indexOf(rest, CRLFCRLF);
    if (end < 0) throw new SafeFetchError(rest.length > MAX_HEADER_BYTES ? "response headers too large" : "incomplete response");
    const head = new TextDecoder().decode(rest.subarray(0, end));
    const [statusLine, ...lines] = head.split("\r\n");
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
    if (!m) throw new SafeFetchError("not an HTTP/1.1 response");
    const status = Number(m[1]);
    const headers = new Headers();
    for (const line of lines) {
      const i = line.indexOf(":");
      if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    rest = rest.subarray(end + 4);
    if (status >= 100 && status < 200 && status !== 101) continue;

    let body: Uint8Array;
    if (/chunked/i.test(headers.get("transfer-encoding") ?? "")) body = dechunk(rest);
    else if (headers.has("content-length")) {
      const len = Number(headers.get("content-length"));
      if (!Number.isSafeInteger(len) || len < 0) throw new SafeFetchError("bad content-length");
      if (rest.length < len) throw new SafeFetchError("the response ended early");
      body = rest.subarray(0, len);
    } else body = rest;
    if (body.length > maxBytes) throw new SafeFetchError(`the response is over ${maxBytes} bytes`);
    return { status, headers, body };
  }
}

const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);
const CRLF = new Uint8Array([13, 10]);

function dechunk(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let off = 0;
  for (;;) {
    const eol = indexOf(data.subarray(off), CRLF);
    if (eol < 0) throw new SafeFetchError("the response ended early");
    const size = parseInt(new TextDecoder().decode(data.subarray(off, off + eol)).split(";")[0].trim(), 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new SafeFetchError("bad chunk size");
    off += eol + 2;
    if (size === 0) break;
    if (off + size > data.length) throw new SafeFetchError("the response ended early");
    parts.push(data.subarray(off, off + size));
    off += size + 2;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
