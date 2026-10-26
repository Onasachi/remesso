/// Webhooks: Remesso announces payments to an address at that address's own
/// server, signed the Standard Webhooks way. Only the address manages its
/// subscriptions, by EIP-712 signature, and an endpoint must echo a challenge
/// before it receives anything.
///
/// Deliveries: `payment.received` as soon as the indexer sees a payment (not
/// final yet), `payment.finalized` once Celo's finalized block passes it, and
/// `payment.removed` if a reorg undoes one you were told about. A failed
/// delivery is retried with the same `webhook-id` for 24 hours.
import { type Address, bytesToHex } from "viem";
import type { Ctx } from "./context.js";
import { ALLOWANCE, CHAIN_ID, checksum, EXECUTOR } from "./deployment.js";
import { RemessoError } from "./errors.js";
import { verify } from "./vendor/standard-webhooks.js";
import { WEBHOOK_DOMAIN, type WebhookActionName, webhookTypedData } from "./vendor/webhook-actions.js";

export type WebhookType = "payment.received" | "payment.finalized" | "payment.removed";

/// One delivery. Amounts are base units as strings, after the fee. Only
/// payments (schedule runs and policy payments) are delivered, and every one
/// has a payer, a recipient, a token and an amount.
export type WebhookMessage = {
  /** The `webhook-id`: the same on every retry, so dedupe on it. */
  id: string;
  type: WebhookType;
  timestamp: string;
  data: {
    chainId: number;
    contract: Address;
    /** Set for a schedule run. */
    schedule?: string;
    /** Set for a policy payment. */
    policy?: string;
    from: Address;
    to: Address;
    token: Address;
    amount: string;
    amountIn?: string | null;
    runNumber?: number | null;
    early?: boolean;
    memo?: string | null;
    memoText?: string | null;
    txHash: `0x${string}`;
    logIndex: number;
    blockNumber: number;
    blockHash: `0x${string}`;
    blockTime: string;
    final: boolean;
    removed: boolean;
  };
};

type Secrets = string | string[] | undefined;

export type WebhookHandlerOptions = {
  /**
   * The signing secret `subscribe` returned, or both during a rotation. A
   * function is read on every delivery, so the secret can arrive after the
   * handler starts: it is only known once the endpoint has answered the challenge.
   */
  secret?: Secrets | (() => Secrets | Promise<Secrets>);
  /** The address or addresses you subscribe. Challenges for any other are refused. */
  recipient: string | string[];
  /** Called per verified attempt. Deduplicate `message.id` with your business action. Throw to retry. */
  onPayment(message: WebhookMessage): void | Promise<void>;
};

const TYPES: WebhookType[] = ["payment.received", "payment.finalized", "payment.removed"];

/// Whether `raw` was signed with any of `secrets` within five minutes.
export async function verifyWebhook(raw: string, headers: Headers | Record<string, string>, secrets: string | string[]): Promise<boolean> {
  const h = headers instanceof Headers ? headers : new Headers(headers);
  for (const s of [secrets].flat()) if (s && await verify(raw, h, s)) return true;
  return false;
}

/// A verified delivery, parsed. Throws for a bad signature or a body that
/// isn't a Remesso payment message.
export async function parseWebhook(raw: string, headers: Headers | Record<string, string>, secrets: string | string[]): Promise<WebhookMessage> {
  if (!(await verifyWebhook(raw, headers, secrets))) throw new RemessoError("refused", "the webhook signature doesn't verify");
  let body: Omit<WebhookMessage, "id">;
  try { body = JSON.parse(raw); } catch { throw new RemessoError("invalid", "the signed webhook isn't JSON"); }
  const data = body?.data;
  const address = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
  const hash = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
  const uint = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const ref = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);
  if (!body || !TYPES.includes(body.type) || typeof body.timestamp !== "string" || !Number.isFinite(Date.parse(body.timestamp)) ||
      !data || data.chainId !== CHAIN_ID || !address(data.contract) || !address(data.from) || !address(data.to) || !address(data.token) ||
      !ref(data.amount) || !hash(data.txHash) || !hash(data.blockHash) || !uint(data.logIndex) || !uint(data.blockNumber) ||
      typeof data.blockTime !== "string" || !Number.isFinite(Date.parse(data.blockTime)) || typeof data.final !== "boolean" || typeof data.removed !== "boolean" ||
      !(ref(data.schedule) && data.policy == null && data.contract.toLowerCase() === EXECUTOR.toLowerCase() ||
        ref(data.policy) && data.schedule == null && data.contract.toLowerCase() === ALLOWANCE.toLowerCase()) ||
      (body.type === "payment.finalized" && (!data.final || data.removed)) ||
      (body.type === "payment.removed" ? !data.removed : data.removed)) {
    throw new RemessoError("invalid", "the signed body isn't a valid Remesso payment message");
  }
  const h = headers instanceof Headers ? headers : new Headers(headers);
  const id = h.get("webhook-id");
  if (!id) throw new RemessoError("invalid", "the webhook has no event id");
  return { id, type: body.type, timestamp: body.timestamp, data };
}

/// A fetch-style handler, `(Request) => Promise<Response>`, for a Next.js
/// route, Deno, Bun, Cloudflare Workers, or Node through `toNodeListener`
/// from `remesso-sdk/node`. It answers the subscription challenge for your
/// own address, verifies every delivery, and calls `onPayment`.
export function webhookHandler(opts: WebhookHandlerOptions): (req: Request) => Promise<Response> {
  const recipients = new Set([opts.recipient].flat().map((r) => checksum(r).toLowerCase()));
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  return async (req) => {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const raw = await req.text();
    let body: { type?: string; data?: { challenge?: string; recipient?: string } };
    try {
      body = JSON.parse(raw);
      if (!body || typeof body !== "object") return reply(400, { error: "not a webhook message" });
    } catch {
      return reply(400, { error: "not JSON" });
    }

    // The challenge comes before the secret exists, so it can't be checked.
    // Answered only for an address you subscribe: echoing it for anyone would
    // let a stranger point their deliveries here.
    if (body.type === "webhook.verification") {
      const who = String(body.data?.recipient ?? "").toLowerCase();
      if (!recipients.has(who) || !body.data?.challenge) return reply(403, { error: "not an address this endpoint receives for" });
      return reply(200, { challenge: body.data.challenge });
    }

    const secrets = typeof opts.secret === "function" ? await opts.secret() : opts.secret;
    if (!secrets || ![secrets].flat().some(Boolean)) return reply(503, { error: "no signing secret yet" }); // Remesso retries
    let message: WebhookMessage;
    try {
      message = await parseWebhook(raw, req.headers, secrets);
    } catch (e) {
      return reply((e as RemessoError).code === "invalid" ? 400 : 401, { error: (e as Error).message });
    }
    if (!recipients.has(message.data.to.toLowerCase())) return reply(403, { error: "not an address this endpoint receives for" });
    try {
      await opts.onPayment(message);
    } catch (e) {
      return reply(500, { error: (e as Error).message }); // Remesso retries with the same webhook-id
    }
    return reply(200, { ok: true });
  };
}

export function makeWebhooks(ctx: Ctx) {
  async function act(action: WebhookActionName, url: string, recipient: string | undefined, extra: Record<string, unknown> = {}) {
    const account = ctx.requireAccount();
    if (!ctx.wallet) throw new RemessoError("no_account", "managing webhooks needs an account that can sign");
    const who = recipient ? checksum(recipient) : account.address;
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const unsigned = { recipient: who, url, chainId: WEBHOOK_DOMAIN.chainId, action, nonce, expiry };
    const signature = await ctx.wallet.signTypedData({ account, ...webhookTypedData(unsigned) } as never);
    return await ctx.post<Record<string, unknown>>(ctx.endpoints.webhooks, { ...unsigned, signature, ...extra });
  }

  return {
    /// Start receiving this address's payments at `url` (https). The endpoint
    /// must already answer the challenge: run `webhookHandler` there first.
    /// The signing secret is returned once: store it.
    async subscribe(input: { url: string; recipient?: string }) {
      const out = await act("subscribe", input.url, input.recipient);
      return out as { ok: true; subscription: string; recipient: Address; url: string; state: "active"; secret: string };
    },
    /// A new signing secret. The old one keeps signing alongside it for a day.
    async rotate(input: { url: string; recipient?: string }) {
      return await act("rotate", input.url, input.recipient) as { ok: true; secret: string; previousSecretValidUntil: string };
    },
    /// Stop.
    async revoke(input: { url: string; recipient?: string }) {
      return await act("revoke", input.url, input.recipient) as { ok: true; state: "revoked" };
    },
    /// Send failed deliveries from the last `days` (1 to 7) again.
    async replay(input: { url: string; recipient?: string; days?: number }) {
      return await act("replay", input.url, input.recipient, { days: input.days ?? 1 }) as { ok: true; requeued: number; days: number };
    },
  };
}

export type Webhooks = ReturnType<typeof makeWebhooks>;
