/// Pins the signed webhook actions: what a receiving wallet signs, and every
/// shape `webhooks` refuses before it asks the database or the chain.
///
///   deno test --allow-env supabase/functions/_shared/webhook-actions.test.ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { verifyTypedData } from "npm:viem@2";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2/accounts";
import { checkAction, endpointProblem, MAX_ACTION_TTL_SECS, type WebhookAction, webhookTypedData } from "./webhook-actions.ts";

const NOW = 1_800_000_000;
const wallet = privateKeyToAccount(generatePrivateKey());
const base = {
  recipient: wallet.address,
  url: "https://agent.example.com/remesso/webhooks?tag=a",
  chainId: 42220,
  action: "subscribe" as const,
  nonce: "a1b2c3d4e5f6a7b8",
  expiry: NOW + 600,
};

async function signed(over: Partial<typeof base> = {}) {
  const a = { ...base, ...over };
  return { ...a, signature: await wallet.signTypedData(webhookTypedData(a)) };
}

Deno.test("a well-formed, signed action passes and verifies against the recipient", async () => {
  const body = await signed();
  const c = checkAction(body, NOW);
  assert(c.ok);
  const { signature, ...rest } = c.action;
  assert(await verifyTypedData({ address: wallet.address, ...webhookTypedData(rest), signature }));
});

Deno.test("the signature covers the url, the action and the nonce", async () => {
  const body = await signed();
  const check = (over: Partial<Omit<WebhookAction, "signature">>) =>
    verifyTypedData({ address: wallet.address, ...webhookTypedData({ ...base, ...over }), signature: body.signature });
  assertFalse(await check({ url: "https://attacker.example.net/hook" }));
  assertFalse(await check({ action: "revoke" }));
  assertFalse(await check({ nonce: "another-nonce-01" }));
  assertFalse(await check({ expiry: NOW + 3000 }));
});

Deno.test("a different wallet's signature doesn't verify", async () => {
  const other = privateKeyToAccount(generatePrivateKey());
  const signature = await other.signTypedData(webhookTypedData(base));
  assertFalse(await verifyTypedData({ address: wallet.address, ...webhookTypedData(base), signature }));
});

Deno.test("refused before any lookup: expiry, chain, action, nonce, signature", async () => {
  const body = await signed();
  const error = (over: Record<string, unknown>) => {
    const c = checkAction({ ...body, ...over }, NOW);
    return c.ok ? "" : c.error;
  };
  assertEquals(error({ expiry: NOW }), "this signed request has expired");
  assertEquals(error({ expiry: NOW + MAX_ACTION_TTL_SECS + 1 }), "expiry must be within an hour");
  assertEquals(error({ chainId: 1 }), "chainId must be 42220 (Celo mainnet)");
  assertEquals(error({ action: "delete" }), "action must be one of subscribe, rotate, revoke, replay");
  assertEquals(error({ nonce: "short" }), "nonce must be 8 to 128 letters, digits, - or _");
  assertEquals(error({ nonce: "has spaces in it" }), "nonce must be 8 to 128 letters, digits, - or _");
  assertEquals(error({ recipient: "0x1234" }), "recipient must be a 0x address");
  assertEquals(error({ signature: "0xdeadbeef" }), "signature must be a hex signature");
});

Deno.test("an endpoint is https with a host, no credentials and no fragment", () => {
  assertEquals(endpointProblem("https://hooks.example.com/x"), null);
  assertEquals(endpointProblem("http://hooks.example.com/x"), "url must be https");
  assertEquals(endpointProblem("https://user:pw@hooks.example.com/x"), "url must not carry credentials");
  assertEquals(endpointProblem("https://hooks.example.com/x#frag"), "url must not have a fragment");
  assertEquals(endpointProblem("not a url"), "url must be a URL");
  assertEquals(endpointProblem("https://example.com/" + "a".repeat(600)), "url must be at most 512 characters");
});
