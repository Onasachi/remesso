/// Pins what `safe-fetch` will and won't connect to.
///
///   deno test --allow-env supabase/functions/_shared/safe-fetch.test.ts
///   SAFE_FETCH_NETWORK=1 deno test --allow-env --allow-net supabase/functions/_shared/safe-fetch.test.ts
///
/// The second also makes one real pinned request to https://example.com/,
/// to prove TCP-to-the-checked-IP plus TLS-with-the-name works end to end.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  encodeRequest,
  isPublicIp,
  parseHttpResponse,
  parseIPv6,
  safeFetch,
  SafeFetchError,
  type Transport,
} from "./safe-fetch.ts";

const ALLOWED = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "172.15.255.255", // just below 172.16/12
  "172.32.0.0", //    just above it
  "100.63.255.255", // just below CGNAT
  "100.128.0.0", //   just above it
  "198.17.255.255",
  "198.20.0.0",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2a00:1450:4001:80b::200e",
  "::ffff:8.8.8.8", // a mapped public IPv4 is that IPv4
  "64:ff9b::808:808", // NAT64 of 8.8.8.8
];

const REFUSED = [
  // IPv4
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.0.1",
  "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1",
  "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1",
  "255.255.255.255",
  // IPv6
  "::", "::1", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:192.168.0.1",
  "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1", "2001::1", "2001:2::1", "2001:10::1",
  "2001:db8::1", "2002:a00:1::1", "2002:808:808::1", "3fff::1", "fc00::1", "fd12:3456::1", "fe80::1",
  "fec0::1", "ff02::1", "5f00::1",
  // not addresses at all
  "1.2.3", "1.2.3.256", "01.2.3.4", "::gggg", "1::2::3", "fe80::1%en0", "", "localhost",
];

Deno.test("public addresses are allowed", () => {
  for (const ip of ALLOWED) assert(isPublicIp(ip), `${ip} should be allowed`);
});

Deno.test("private, local, special and malformed addresses are refused", () => {
  for (const ip of REFUSED) assert(!isPublicIp(ip), `${ip} should be refused`);
});

Deno.test("IPv6 parses with compression and an embedded IPv4", () => {
  assertEquals(parseIPv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assertEquals(parseIPv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assertEquals(parseIPv6("1:2:3:4:5:6:1.2.3.4"), [1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
  assertEquals(parseIPv6("64:ff9b::a00:1"), [0x64, 0xff9b, 0, 0, 0, 0, 0xa00, 1]);
  assertEquals(parseIPv6("1:2:3:4:5:6:7:8:9"), null);
});

const ok200: Transport = () =>
  Promise.resolve({ status: 200, headers: new Headers(), body: new TextEncoder().encode("hi") });

Deno.test("only https, and no credentials in the URL", async () => {
  await assertRejects(() => safeFetch("http://example.com/", {}, { transport: ok200 }), SafeFetchError, "only https");
  await assertRejects(() => safeFetch("https://u:p@example.com/", {}, { transport: ok200 }), SafeFetchError, "credentials");
  await assertRejects(() => safeFetch("ftp://example.com/", {}, { transport: ok200 }), SafeFetchError, "only https");
});

Deno.test("IP literals are judged without a lookup, however they are spelled", async () => {
  for (const url of ["https://127.0.0.1/", "https://[::1]/", "https://0x7f000001/", "https://2130706433/", "https://169.254.169.254/latest"]) {
    await assertRejects(() => safeFetch(url, {}, { transport: ok200 }), SafeFetchError, "isn't a public address", url);
  }
});

Deno.test("every answer must be public; the request goes to one that was checked", async () => {
  await assertRejects(
    () => safeFetch("https://hooks.example.com/", {}, { resolve: () => Promise.resolve(["93.184.216.34", "10.0.0.5"]), transport: ok200 }),
    SafeFetchError,
    "resolves to 10.0.0.5",
  );
  let used = "";
  const spy: Transport = (ip, ...rest) => {
    used = ip;
    return ok200(ip, ...rest);
  };
  const res = await safeFetch("https://hooks.example.com/x", {}, { resolve: () => Promise.resolve(["2606:4700::1", "93.184.216.34"]), transport: spy });
  assertEquals(res.text, "hi");
  assertEquals(used, "93.184.216.34", "IPv4 is preferred");
});

Deno.test("a redirect is a failure, never followed", async () => {
  const redirect: Transport = () =>
    Promise.resolve({ status: 302, headers: new Headers({ location: "https://169.254.169.254/" }), body: new Uint8Array() });
  await assertRejects(
    () => safeFetch("https://hooks.example.com/", {}, { resolve: () => Promise.resolve(["93.184.216.34"]), transport: redirect }),
    SafeFetchError,
    "refused a redirect (302)",
  );
});

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("HTTP/1.1 responses: content-length, chunked, an interim 100, and the size cap", () => {
  const plain = parseHttpResponse(enc("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"), 1024);
  assertEquals([plain.status, new TextDecoder().decode(plain.body)], [200, "hello"]);

  const chunked = parseHttpResponse(enc("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5;ext=1\r\npedia\r\n0\r\n\r\n"), 1024);
  assertEquals(new TextDecoder().decode(chunked.body), "Wikipedia");

  const interim = parseHttpResponse(enc("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n"), 1024);
  assertEquals(interim.status, 204);

  assertThrows(() => parseHttpResponse(enc("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789"), 5), SafeFetchError, "over 5 bytes");
  assertThrows(() => parseHttpResponse(enc("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort"), 1024), SafeFetchError, "ended early");
  assertThrows(() => parseHttpResponse(enc("SSH-2.0-OpenSSH\r\n\r\n"), 1024), SafeFetchError, "not an HTTP/1.1 response");
});

Deno.test("the request carries the host, closes, and refuses header injection", () => {
  const text = new TextDecoder().decode(
    encodeRequest(new URL("https://hooks.example.com:8443/a?b=1"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  );
  assert(text.startsWith("POST /a?b=1 HTTP/1.1\r\nHost: hooks.example.com:8443\r\n"));
  assert(text.includes("Connection: close\r\n") && text.includes("Content-Length: 2\r\n") && text.endsWith("\r\n\r\n{}"));
  assertThrows(() => encodeRequest(new URL("https://x.example/"), { headers: { "x-evil": "a\r\nHost: other" } }), SafeFetchError);
});

Deno.test({
  name: "a real pinned request: TCP to the checked IP, TLS verified against the name",
  ignore: Deno.env.get("SAFE_FETCH_NETWORK") !== "1",
  async fn() {
    const res = await safeFetch("https://example.com/", {}, { timeoutMs: 15_000, maxBytes: 512 * 1024 });
    assertEquals(res.status, 200);
    assert(res.text.toLowerCase().includes("example domain"));
  },
});
