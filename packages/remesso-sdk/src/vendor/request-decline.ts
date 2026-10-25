// Copied from supabase/functions/_shared/request-decline.ts by scripts/build-sdk.ts. Edit the original and re-run;
// `build-sdk.ts --check` fails while the two differ.
/// A payer declining a payment request, by signature.
///
/// The app can't decline for anyone. An anonymous session's claimed wallet
/// proves nothing and MiniPay can't sign, so a dismissal in the app only hides
/// a request for that session. An agent holds a key, so it can sign a decline,
/// and a signed decline is the only kind a requester is ever told about
/// (docs/agent-to-agent.md, 1d and step 3).
///
/// Pure: the typed data, and the checks that need neither the database nor
/// the chain. `request-payment` verifies the signature with
/// `publicClient.verifyTypedData`, which also handles ERC-1271 smart accounts;
/// the tests verify offline. The SDK imports this same definition, so a payer
/// signs exactly what we verify.

/// No verifying contract: nothing on-chain checks this signature. The request
/// id, the action and the expiry are what bind it.
export const DECLINE_DOMAIN = { name: "Remesso", version: "1", chainId: 42220 } as const;

export const DECLINE_TYPES = {
  PaymentRequestAction: [
    { name: "request", type: "string" },
    { name: "action", type: "string" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/// How far ahead a signed decline may expire. Long enough for an agent to sign
/// it and send it, short enough that a signature found later is worthless.
export const MAX_DECLINE_TTL_SECS = 24 * 60 * 60;

export type Decline = { id: string; expiry: number; signature: `0x${string}` };

/// The message a payer signs to decline request `id`. The id is signed as the
/// caller sends it; request-payment returns it lowercase.
export function declineTypedData(id: string, expiry: number) {
  return {
    domain: DECLINE_DOMAIN,
    types: DECLINE_TYPES,
    primaryType: "PaymentRequestAction" as const,
    message: { request: id, action: "decline", expiry: BigInt(expiry) },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// 65 bytes for a plain key; a smart account's ERC-1271 signature can be
/// longer, so only an absurd size is refused.
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){65,4096}$/;

/// Everything about a decline that can be checked without the database or the
/// chain. `nowSecs` is a parameter so tests can hold the clock still.
export function checkDecline(
  body: Record<string, unknown>,
  nowSecs: number,
): { ok: true; decline: Decline } | { ok: false; error: string } {
  const id = String(body.id ?? "");
  if (!UUID.test(id)) return { ok: false, error: "id must be a payment request id" };

  const expiry = Number(body.expiry);
  if (!Number.isSafeInteger(expiry)) return { ok: false, error: "expiry must be unix seconds" };
  if (expiry <= nowSecs) return { ok: false, error: "this signed decline has expired" };
  if (expiry > nowSecs + MAX_DECLINE_TTL_SECS) return { ok: false, error: "expiry must be within a day" };

  const signature = String(body.signature ?? "");
  if (!SIGNATURE.test(signature)) return { ok: false, error: "signature must be a hex signature" };

  return { ok: true, decline: { id, expiry, signature: signature as `0x${string}` } };
}
