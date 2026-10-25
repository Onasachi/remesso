/// Pins the signed decline: what a payer signs, and what request-payment
/// refuses before it ever asks the chain.
///
/// Verified offline with viem's `verifyTypedData` utility, which checks a plain
/// key's signature. request-payment uses the public client's version, which
/// does the same for a plain key and also handles ERC-1271 smart accounts.
///
///   deno test supabase/functions/_shared/request-decline.test.ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { verifyTypedData } from "npm:viem@2";
import { generatePrivateKey, privateKeyToAccount } from "npm:viem@2/accounts";
import { checkDecline, declineTypedData, MAX_DECLINE_TTL_SECS } from "./request-decline.ts";

const NOW = 1_800_000_000;
const ID = "5f0c2a2e-8d55-4c1e-9a77-2f1f3c0e9b11";
const OTHER_ID = "0b9e5d71-3c2a-4f8e-8a10-77c4f2d9e6a3";

const payer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

async function signed(by = payer, id = ID, expiry = NOW + 600) {
  return { id, expiry, signature: await by.signTypedData(declineTypedData(id, expiry)) };
}

async function verifies(address: `0x${string}`, body: Record<string, unknown>) {
  const c = checkDecline(body, NOW);
  if (!c.ok) return false;
  return await verifyTypedData({
    address,
    ...declineTypedData(c.decline.id, c.decline.expiry),
    signature: c.decline.signature,
  });
}

Deno.test("the payer's own signed decline verifies", async () => {
  assert(await verifies(payer.address, await signed()));
});

Deno.test("a signature over another request id is refused", async () => {
  const body = await signed();
  assertFalse(await verifies(payer.address, { ...body, id: OTHER_ID }));
});

Deno.test("a signature from anyone but the payer is refused", async () => {
  assertFalse(await verifies(payer.address, await signed(stranger)));
});

Deno.test("a changed expiry no longer matches the signature", async () => {
  const body = await signed();
  assertFalse(await verifies(payer.address, { ...body, expiry: body.expiry + 60 }));
});

Deno.test("the action is part of what is signed", async () => {
  // A signature over the same request with another action must not decline it.
  const typed = declineTypedData(ID, NOW + 600);
  const signature = await payer.signTypedData({ ...typed, message: { ...typed.message, action: "accept" } });
  assertFalse(await verifies(payer.address, { id: ID, expiry: NOW + 600, signature }));
});

Deno.test("an expired decline is refused before any signature check", async () => {
  const body = await signed(payer, ID, NOW - 1);
  const c = checkDecline(body, NOW);
  assertFalse(c.ok);
  if (!c.ok) assertEquals(c.error, "this signed decline has expired");
  assertFalse(checkDecline({ ...body, expiry: NOW }, NOW).ok, "expiring this second is already too late");
});

Deno.test("an expiry more than a day ahead is refused", async () => {
  const body = await signed(payer, ID, NOW + MAX_DECLINE_TTL_SECS + 1);
  assertFalse(checkDecline(body, NOW).ok);
  assert(checkDecline({ ...body, expiry: NOW + MAX_DECLINE_TTL_SECS }, NOW).ok, "exactly a day is allowed");
});

Deno.test("malformed input is refused", async () => {
  const good = await signed();
  for (const bad of [
    { ...good, id: "not-a-uuid" },
    { ...good, id: undefined },
    { ...good, expiry: "soon" },
    { ...good, expiry: NOW + 0.5 },
    { ...good, signature: "0x1234" },
    { ...good, signature: good.signature.slice(2) },
    { ...good, signature: undefined },
  ]) {
    assertFalse(checkDecline(bad as Record<string, unknown>, NOW).ok, JSON.stringify(bad));
  }
});
