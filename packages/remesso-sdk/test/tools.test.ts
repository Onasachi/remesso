import { assertEquals } from "@std/assert";
import { toHex } from "viem";
import { RemessoError } from "../src/errors.ts";
import { createAgentTools, toolJson, type AgentToolClient } from "../src/tools.ts";
const address = `0x${"1".repeat(40)}`;
const input = { funding: "wallet", to: address, amount: "2.5", token: "USDT", idempotencyKey: "order-17" };
function fixture(options: { error?: unknown } = {}) {
  const called: unknown[] = [];
  const run = async (...args: unknown[]) => { called.push(args); if (options.error) throw options.error; return { amount: 2_500_000n, at: new Date("2026-01-01T00:00:00Z") }; };
  const client = { remittances: { quote: run, send: run, get: run, listPending: run, reconcile: run }, receipts: { verify: run }, invoices: { verify: run, pay: run } } as unknown as AgentToolClient;
  return { client, called };
}
Deno.test("agent tools publish read/write annotations and JSON schemas without execute functions", () => {
  const { client } = fixture(), api = createAgentTools(client), definitions = api.list();
  assertEquals(definitions.length, 8);
  assertEquals(JSON.parse(JSON.stringify(definitions)).length, 8);
  assertEquals(definitions.find((t) => t.name === "remesso_quote")?.annotations.readOnlyHint, true);
  assertEquals(definitions.find((t) => t.name === "remesso_send")?.annotations.readOnlyHint, false);
  assertEquals(definitions.every((t) => t.inputSchema.additionalProperties === false), true);
  assertEquals(definitions.every((t) => Array.isArray(t.outputSchema.oneOf)), true);
});
Deno.test("agent quote and status tools are read-only and serialize bigint/date results", async () => {
  const { client, called } = fixture(), api = createAgentTools(client);
  assertEquals(await api.call("remesso_quote", input), { ok: true, data: { amount: "2500000", at: "2026-01-01T00:00:00.000Z" }, sideEffects: "none" });
  await api.call("remesso_status", { key: "order-17" });
  await api.call("remesso_pending", {});
  assertEquals(called.length, 3);
});
Deno.test("agent write tools refuse by default and require a true host authorization", async () => {
  const { client, called } = fixture();
  const denied = await createAgentTools(client).call("remesso_send", input);
  assertEquals(denied.ok, false);
  if (denied.ok) throw new Error("write allowed");
  assertEquals([denied.error.code, denied.error.sideEffects, called.length], ["refused", "none", 0]);
  await createAgentTools(client, { authorizeWrite: async () => false, enableWrites: true }).call("remesso_send", input);
  assertEquals(called.length, 0);
  await createAgentTools(client, { authorizeWrite: async ({ name, input: terms }) => name === "remesso_send" && terms.to === address }).call("remesso_send", input);
  assertEquals(called.length, 1);
});
Deno.test("explicit trusted-host write opt-in and reconciliation preserve stable payment keys", async () => {
  const { client, called } = fixture(), api = createAgentTools(client, { enableWrites: true });
  const sent = await api.call("remesso_send", input);
  assertEquals(sent.ok, true);
  if (!sent.ok) throw new Error("refused");
  assertEquals(sent.sideEffects, "possible");
  await api.call("remesso_reconcile", { key: "order-17", funding: "wallet" });
  assertEquals(called, [[input], ["order-17", { funding: "wallet" }]]);
});
Deno.test("agent tools reject missing, malformed and unknown input before authorizing", async () => {
  const { client, called } = fixture(); let authorized = 0;
  const api = createAgentTools(client, { authorizeWrite: () => { authorized++; return true; } });
  for (const terms of [{ ...input, to: "not-address" }, { ...input, amount: 2.5 }, { ...input, idempotencyKey: "" },
    { ...input, extra: "instruction" }, { ...input, waitMs: -1 }, { ...input, amount: "2e6" }, null]) {
    const result = await api.call("remesso_send", terms);
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("invalid accepted");
    assertEquals(result.error.sideEffects, "none");
  }
  assertEquals([authorized, called.length], [0, 0]);
});
Deno.test("authorization callback mutations cannot change the dispatched payment", async () => {
  const { client, called } = fixture();
  await createAgentTools(client, { authorizeWrite: ({ input: terms }) => { (terms as Record<string, unknown>).to = `0x${"2".repeat(40)}`; return true; } }).call("remesso_send", input);
  assertEquals(called, [[input]]);
});
Deno.test("post-write errors report uncertain side effects and safe retry metadata", async () => {
  const error = new RemessoError("timeout", "receipt unavailable", { hash: toHex(17, { size: 32 }), secret: "do-not-return" });
  const result = await createAgentTools(fixture({ error }).client, { enableWrites: true }).call("remesso_send", input);
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assertEquals(result.error, { code: "timeout", message: "receipt unavailable", retryable: true, sideEffects: "unknown", details: { hash: toHex(17, { size: 32 }) } });
});
Deno.test("generic provider errors do not leak private service diagnostics or claim no transfer", async () => {
  const result = await createAgentTools(fixture({ error: new Error("secret provider credential") }).client, { enableWrites: true }).call("remesso_send", input);
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assertEquals([result.error.code, result.error.sideEffects, result.error.message.includes("credential")], ["internal", "unknown", false]);
});
Deno.test("unknown tools fail without dispatching, and JSON conversion is lossless for base units", async () => {
  const { client, called } = fixture();
  const result = await createAgentTools(client).call("not_a_tool", {});
  assertEquals(result.ok, false);
  assertEquals(called.length, 0);
  assertEquals(toolJson({ max: 2n ** 256n - 1n }), { max: (2n ** 256n - 1n).toString() });
});

Deno.test("tool JSON strips account, raw bytes and credential fields recursively", () => {
  assertEquals(toolJson({ amount: 2n, account: { privateKey: "secret" }, nested: { raw: "0xsigned", api_key: "credential", txHash: toHex(17, { size: 32 }) }, url: "https://user:password@rpc.test?api_key=secret" }),
    { amount: "2", nested: { txHash: toHex(17, { size: 32 }) }, url: "https://[redacted]@rpc.test?api_key=[redacted]" });
});
