import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createServer } from "node:net";
import { assertDevPortAvailable, assertLocalAnvil, localDevUrl, startDev } from "../src/dev.ts";

Deno.test("local development rejects every external signing RPC and deceptive URL", () => {
  for (const url of ["https://forno.celo.org", "http://example.com", "http://127.0.0.1.example.com", "http://localhost.example.com",
    "https://127.0.0.1:8546", "http://user:secret@127.0.0.1", "http://127.0.0.1:8546/private", "http://127.0.0.1:8546?url=https://forno.celo.org", "file:///tmp/rpc"]) {
    assertThrows(() => localDevUrl(url), Error);
  }
  for (const url of ["http://127.0.0.1:18546", "http://localhost:18546", "http://[::1]:18546/"]) assertEquals(localDevUrl(url).protocol, "http:");
});

Deno.test("development network guard reads Anvil identity and Celo chain before permitting writes", async () => {
  const methods: string[] = [];
  const fake = ((_: RequestInfo | URL, init?: RequestInit) => {
    const method = JSON.parse(String(init?.body)).method;
    methods.push(method);
    return Promise.resolve(Response.json({ result: method === "web3_clientVersion" ? "anvil/v1.4.4" : "0xa4ec" }));
  }) as typeof fetch;
  await assertLocalAnvil("http://127.0.0.1:18546", fake);
  assertEquals(methods.sort(), ["eth_chainId", "web3_clientVersion"]);
  let contacted = false;
  await assertRejects(() => assertLocalAnvil("https://forno.celo.org", (() => { contacted = true; throw new Error("no external request permitted"); }) as typeof fetch));
  assertEquals(contacted, false);
});

Deno.test("development guard refuses local production nodes, wrong chains and RPC failures", async () => {
  for (const [version, chain] of [["Geth/v1.0", "0xa4ec"], ["anvil/v1.4.4", "0x539"]]) {
    const fake = ((_: RequestInfo | URL, init?: RequestInit) => {
      const method = JSON.parse(String(init?.body)).method;
      return Promise.resolve(Response.json({ result: method === "web3_clientVersion" ? version : chain }));
    }) as typeof fetch;
    await assertRejects(() => assertLocalAnvil("http://127.0.0.1:18546", fake), Error, "expected Anvil on Celo");
  }
  await assertRejects(() => assertLocalAnvil("http://127.0.0.1:18546", (() => Promise.resolve(Response.json({ error: { message: "not available" } }))) as typeof fetch));
});

Deno.test("development transport failures identify the RPC method and local endpoint without retrying", async () => {
  let calls = 0;
  const timeout = (() => { calls++; return Promise.reject(new DOMException("aborted", "TimeoutError")); }) as typeof fetch;
  const error = await assertRejects(() => assertLocalAnvil("http://127.0.0.1:18546", timeout), Error);
  assertEquals(error.message.includes("development RPC web3_clientVersion at http://127.0.0.1:18546/"), true);
  assertEquals(error.message.includes("timed out after 10000ms"), true);
  assertEquals(calls, 2); // The two independent guard reads; neither is retried.
  await assertRejects(() => assertLocalAnvil("http://127.0.0.1:18546", (() => Promise.resolve(new Response("busy", { status: 503 }))) as typeof fetch), Error, "HTTP 503");
});

Deno.test("development port collision fails without closing the existing listener", async () => {
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  try {
    const address = other.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    await assertRejects(() => assertDevPortAvailable(address.port), Error, "unavailable");
    assertEquals(other.listening, true);
  } finally { await new Promise<void>((resolve) => other.close(() => resolve())); }
});

Deno.test("development validates ports and cancellation before launching a child", async () => {
  for (const port of [0, -1, 80, 65536, 18546.5]) await assertRejects(() => assertDevPortAvailable(port), Error, "integers");
  await assertRejects(() => startDev({ rpcPort: 18546, httpPort: 18546 }), Error, "must differ");
  const cancelled = new AbortController(); cancelled.abort();
  await assertRejects(() => startDev({ signal: cancelled.signal }), Error, "cancelled");
});
