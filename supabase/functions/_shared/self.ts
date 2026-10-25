/// Self (self.xyz) identity verification — a hand-rolled client.
///
/// Why not `@selfxyz/enterprise-sdk`: it is Node-only and imports
/// `@selfxyz/core` at module load for an optional proof verifier we never call,
/// which drags a ZK/ethers dependency tree into every cold start. The part we
/// use is two authenticated HTTP calls and a Svix signature check. This file is
/// written against the SDK's own source (v0.4.1): same base URL, same paths,
/// same field names.
///
/// Verification is optional in Remesso and gates nothing. The contract checks
/// `msg.sender`; nothing here can move, block or redirect a payment.
import { SELF_API } from "./config.ts";
import { verify as verifyStandardWebhook } from "./standard-webhooks.ts";

export type SessionStatus = "pending" | "valid" | "invalid" | "error" | "expired";

export type Session = {
  id: string;
  verificationUrl: string;
  expiresAt: string;
};

export type SessionDetail = {
  id: string;
  status: SessionStatus;
  completedAt: string | null;
  expiresAt: string;
  externalUuid: string;
  proofAttributes: Record<string, unknown> | null;
};

/// The one event that carries a result. Unlike `SessionDetail` it also carries
/// the nullifier, which is the only field that tells two accounts apart as the
/// same person.
export type VerificationCompleted = {
  type: "verification.completed";
  verification_id: string;
  external_uuid: string;
  environment: "test" | "live";
  status: Exclude<SessionStatus, "pending">;
  reason?: string;
  proof_attributes: Record<string, unknown>;
  nullifier: string | null;
  verified_at: string;
};

export class SelfError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
  /// The SDK does not retry, and neither do we; this only tells the caller
  /// whether asking again later is worth it.
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SELF_API.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SELF_API.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new SelfError(
      res.status,
      err?.message ?? `Self ${res.status}: ${text.slice(0, 200) || res.statusText}`,
      err?.code,
    );
  }
  return json as T;
}

/// `externalUuid` is echoed back verbatim in the webhook. We pass our own
/// verification row id, so a delivery maps to exactly one row without trusting
/// anything else in the payload.
export function createSession(input: {
  externalUuid: string;
  successUrl?: string;
  failureUrl?: string;
}): Promise<Session> {
  return request<Session>("POST", "/v1/sessions", {
    flowId: SELF_API.flowId,
    externalUuid: input.externalUuid,
    // Long enough to install the Self app and scan a passport from scratch,
    // short enough that an abandoned link stops working the same day.
    expiresInSeconds: 3600,
    ...(input.successUrl ? { successUrl: input.successUrl } : {}),
    ...(input.failureUrl ? { failureUrl: input.failureUrl } : {}),
  });
}

export function getSession(id: string): Promise<SessionDetail> {
  return request<SessionDetail>("GET", `/v1/sessions/${encodeURIComponent(id)}`);
}

/// Svix signature check ("Standard Webhooks"), which is what Self's SDK
/// delegates to. The scheme lives in `standard-webhooks.ts`, shared with the
/// webhooks Remesso sends: `${id}.${timestamp}.${rawBody}` under HMAC-SHA256,
/// `v1,<sig>`, within five minutes. `self.test.ts` checks it against the
/// `svix` library itself.
export function verifyWebhook(
  raw: string,
  headers: Headers,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  return verifyStandardWebhook(raw, headers, secret, { nowSeconds });
}
