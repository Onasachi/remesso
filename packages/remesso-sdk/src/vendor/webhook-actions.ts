// Copied from supabase/functions/_shared/webhook-actions.ts by scripts/build-sdk.ts. Edit the original and re-run;
// `build-sdk.ts --check` fails while the two differ.
/// A signed request to manage the webhooks for a receiving address.
///
/// A subscription decides where payments to an address are announced, so only
/// that address may change it. Without a signature, anyone could fill an
/// address's subscription slots, or point its deliveries at their own server
/// (docs/agent-to-agent.md, 3c). The wallet signs EIP-712 over the address,
/// the endpoint, the chain, the action, a nonce and an expiry. Smart accounts
/// sign through ERC-1271: `webhooks` verifies with viem's `verifyTypedData`,
/// which covers both.
///
/// Pure, like `request-decline.ts`: the typed data, and the checks that need
/// neither the database nor the chain. The SDK imports this same definition,
/// so a receiver signs exactly what we verify.

/// No verifying contract: nothing on-chain checks this signature.
export const WEBHOOK_DOMAIN = { name: "Remesso", version: "1", chainId: 42220 } as const;

export const WEBHOOK_TYPES = {
  WebhookAction: [
    { name: "recipient", type: "address" },
    { name: "url", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "action", type: "string" },
    { name: "nonce", type: "string" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/// subscribe: start announcing payments to `recipient` at `url`.
/// rotate:    replace the signing secret (the old one keeps signing for a day).
/// revoke:    stop.
/// replay:    send failed deliveries again.
export const WEBHOOK_ACTIONS = ["subscribe", "rotate", "revoke", "replay"] as const;
export type WebhookActionName = (typeof WEBHOOK_ACTIONS)[number];

/// Long enough to sign and send, short enough that a signature found later is
/// worthless. The nonce stops a replay inside the window.
export const MAX_ACTION_TTL_SECS = 60 * 60;
export const MAX_URL_LENGTH = 512;

export type WebhookAction = {
  recipient: `0x${string}`;
  url: string;
  chainId: number;
  action: WebhookActionName;
  nonce: string;
  expiry: number;
  signature: `0x${string}`;
};

/// The message a recipient signs for `action`.
export function webhookTypedData(a: Omit<WebhookAction, "signature">) {
  return {
    domain: WEBHOOK_DOMAIN,
    types: WEBHOOK_TYPES,
    primaryType: "WebhookAction" as const,
    message: {
      recipient: a.recipient,
      url: a.url,
      chainId: BigInt(a.chainId),
      action: a.action,
      nonce: a.nonce,
      expiry: BigInt(a.expiry),
    },
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
/// 65 bytes for a plain key; a smart account's ERC-1271 signature can be
/// longer, so only an absurd size is refused.
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){65,4096}$/;

/// An endpoint URL as we will call it: HTTPS, a hostname, no credentials, no
/// fragment. Where it resolves to is `safe-fetch`'s question, asked at call
/// time.
export function endpointProblem(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return `url must be at most ${MAX_URL_LENGTH} characters`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "url must be a URL";
  }
  if (u.protocol !== "https:") return "url must be https";
  if (u.username || u.password) return "url must not carry credentials";
  if (u.hash) return "url must not have a fragment";
  if (!u.hostname) return "url must have a host";
  return null;
}

/// Everything about an action that can be checked without the database or the
/// chain. `nowSecs` is a parameter so tests can hold the clock still.
export function checkAction(
  body: Record<string, unknown>,
  nowSecs: number,
): { ok: true; action: WebhookAction } | { ok: false; error: string } {
  const action = String(body.action ?? "");
  if (!(WEBHOOK_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: `action must be one of ${WEBHOOK_ACTIONS.join(", ")}` };
  }

  const recipient = String(body.recipient ?? "");
  if (!ADDRESS.test(recipient)) return { ok: false, error: "recipient must be a 0x address" };

  const url = String(body.url ?? "");
  const bad = endpointProblem(url);
  if (bad) return { ok: false, error: bad };

  if (Number(body.chainId) !== WEBHOOK_DOMAIN.chainId) {
    return { ok: false, error: `chainId must be ${WEBHOOK_DOMAIN.chainId} (Celo mainnet)` };
  }

  const nonce = String(body.nonce ?? "");
  if (!NONCE.test(nonce)) return { ok: false, error: "nonce must be 8 to 128 letters, digits, - or _" };

  const expiry = Number(body.expiry);
  if (!Number.isSafeInteger(expiry)) return { ok: false, error: "expiry must be unix seconds" };
  if (expiry <= nowSecs) return { ok: false, error: "this signed request has expired" };
  if (expiry > nowSecs + MAX_ACTION_TTL_SECS) return { ok: false, error: "expiry must be within an hour" };

  const signature = String(body.signature ?? "");
  if (!SIGNATURE.test(signature)) return { ok: false, error: "signature must be a hex signature" };

  return {
    ok: true,
    action: {
      recipient: recipient as `0x${string}`,
      url,
      chainId: WEBHOOK_DOMAIN.chainId,
      action: action as WebhookActionName,
      nonce,
      expiry,
      signature: signature as `0x${string}`,
    },
  };
}
