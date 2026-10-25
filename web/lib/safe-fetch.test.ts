// (cd web && deno test --allow-net --unstable-sloppy-imports lib/safe-fetch.test.ts)   # from web/: needs its node_modules
//
// Pins which addresses `find_agent` may fetch from. An agent's registration
// URI is set by whoever owns the agent, so a gap here is a way to make our
// server, or a user's machine, request something private on their behalf.
// No network: IP-literal URLs are refused before any connection.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isPublicIp, safeFetchText } from "./safe-fetch";

const REFUSED = [
  // IPv4
  "0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.8.9.10",
  "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1",
  "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1",
  "255.255.255.255",
  // IPv6
  "::", "::1", "[::1]", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "fc00::1", "fd12:3456::1", "ff02::1",
  "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2002:c0a8:101::1", "100::1",
  // IPv4 inside IPv6
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1",
  "64:ff9b::10.0.0.1", "64:ff9b::a9fe:a9fe",
  // Not addresses at all
  "", "localhost", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4x", "1:2:3:4:5:6:7:8:9", "::1::",
];

const ALLOWED = [
  "1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1",
  "198.17.255.255", "198.20.0.1", "223.255.255.255", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e",
  "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:4860:4860::8888",
];

Deno.test("private, internal and reserved addresses are refused", () => {
  for (const ip of REFUSED) assertEquals(isPublicIp(ip), false, `${ip} must be refused`);
});

Deno.test("public addresses pass", () => {
  for (const ip of ALLOWED) assertEquals(isPublicIp(ip), true, `${ip} must be allowed`);
});

Deno.test("URLs are refused by rule before anything connects", async () => {
  await assertRejects(() => safeFetchText("http://example.com/agent.json"), Error, "only https");
  await assertRejects(() => safeFetchText("https://user:pw@example.com/x"), Error, "credentials");
  await assertRejects(() => safeFetchText("https://example.com:8443/x"), Error, "default HTTPS port");
  await assertRejects(() => safeFetchText("https://169.254.169.254/latest/meta-data"), Error, "public address");
  await assertRejects(() => safeFetchText("https://[::ffff:127.0.0.1]/x"), Error, "public address");
  await assertRejects(() => safeFetchText("file:///etc/passwd"), Error, "only https");
});
