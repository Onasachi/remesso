/// Signed, exact one-off invoices. Their signature authorizes invoice terms,
/// never a transfer: paying still needs a wallet or a delegated policy.
import { formatUnits, hashTypedData, parseAbi, toHex, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";
import type { Ctx } from "./context.js";
import { CHAIN_ID, checksum, EXECUTOR, token as tokenOf, toUnits } from "./deployment.js";
import { RemessoError } from "./errors.js";
import { memo32, priorPayment } from "./payments.js";
import type { PaymentProof, Receipts } from "./receipts.js";
import type { Remittances, RemittanceResult } from "./remittances.js";
import type { Requests, RequestStatus } from "./requests.js";
import { remittanceScope } from "./wallet-remittances.js";

/** A separate domain from transaction and request-decline signatures. */
export const INVOICE_DOMAIN = Object.freeze({ name: "Remesso Invoice", version: "1", chainId: CHAIN_ID, verifyingContract: EXECUTOR } as const);
export const INVOICE_TYPES = Object.freeze({ Invoice: [
  { name: "issuer", type: "address" }, { name: "payer", type: "address" },
  { name: "recipient", type: "address" }, { name: "token", type: "address" },
  { name: "amount", type: "uint256" }, { name: "orderId", type: "string" },
  { name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" }, { name: "requestId", type: "string" },
] } as const);
export type InvoiceMessage = {
  issuer: Address;
  /** Funds owner, including when a different policy agent signs the payment. */
  payer: Address;
  recipient: Address;
  token: Address;
  /** Exact recipient amount, serialized as a canonical base-unit integer. */
  amount: string;
  orderId: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  /** Lowercase backend UUID, or empty for an offline invoice. */
  requestId: string;
};
export type UnsignedInvoice = { version: 1; domain: typeof INVOICE_DOMAIN; message: InvoiceMessage };
export type SignedInvoice = UnsignedInvoice & { signature: Hex };
export type SignInvoiceInput = {
  payer: string;
  /** Decimal recipient amount, e.g. "2.50". */
  amount: string;
  token: string;
  orderId: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Defaults to this signer; V1 requires the recipient to sign its invoice. */
  recipient?: string;
  /** Defaults to 32 random bytes. Reconstructing an invoice requires the same nonce and issuedAt. */
  nonce?: Hex;
  issuedAt?: number;
  /** Bind an existing exact one-off backend request, checked before signing. */
  requestId?: string;
};
export type VerifiedInvoice = {
  id: Hex;
  /** Stable across signature encodings: derived from the EIP-712 terms hash. */
  idempotencyKey: string;
  issuer: Address;
  payer: Address;
  recipient: Address;
  token: Address;
  amount: bigint;
  amountDecimal: string;
  orderId: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  requestId?: string;
};
export type PayInvoiceOptions = { funding: "wallet"; policyId?: never; waitMs?: number; maxDebit?: string } | { funding: "policy"; policyId?: bigint | number | string; waitMs?: number; maxDebit?: string };
export type VerifyInvoicePaymentInput = {
  txHash: Hex;
  policyId?: bigint | number | string;
  scheduleId?: bigint | number | string;
  /** Finalized by default. Included evidence may be reorganized. */
  finality?: "included" | "finalized";
};
export type InvoicePaymentProof = { invoiceId: Hex; orderId: string; payment: PaymentProof };
export type InvoiceReservation = { funding: "wallet" | "policy"; signer: string; payer: string; key: string; policyId?: string };
/** Must reserve atomically across workers. Existing identical reservations are accepted; changed routes are refused. */
export interface InvoiceStore { reserve(invoiceId: string, reservation: InvoiceReservation): Promise<void> }
/** Process-local only. Configure a shared durable adapter for production workers/restarts. */
export function memoryInvoiceStore(): InvoiceStore {
  const rows = new Map<string, InvoiceReservation>();
  return { async reserve(invoiceId, reservation) {
    const next: InvoiceReservation = { funding: reservation.funding, signer: checksum(reservation.signer).toLowerCase(), payer: checksum(reservation.payer).toLowerCase(), key: reservation.key, ...(reservation.policyId === undefined ? {} : { policyId: reservation.policyId }) };
    const previous = rows.get(invoiceId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(next)) throw new RemessoError("key_reused", "this invoice was reserved by a different funding route, signer or policy");
    rows.set(invoiceId, next);
  } };
}
/** The memo a policy payment carries to settle an invoice made without a backend
 * request: the first 32 hex characters of its id, 128 bits of the signed terms. */
export function invoiceReference(invoiceId: Hex): string {
  if (!/^0x[\da-f]{64}$/i.test(invoiceId)) throw new RemessoError("invalid", "an invoice id is a 32-byte hex hash");
  return invoiceId.slice(2, 34).toLowerCase();
}
/// Clocks differ: an invoice issued a few minutes "in the future" is someone's
/// clock running fast, not a forgery.
const SKEW_S = 300;
const ERC1271 = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bytes32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(message: string): never { throw new RemessoError("invalid", message); }
function shape(v: unknown, keys: readonly string[], label: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) invalid(`${label} must be an object`);
  const found = Object.keys(v);
  if (found.length !== keys.length || found.some((key) => !keys.includes(key))) invalid(`${label} has missing or unknown fields`);
}
function address(value: unknown, name: string): Address {
  if (typeof value !== "string" || !/^0x[\da-f]{40}$/i.test(value)) invalid(`${name} must be an address`);
  const out = checksum(value);
  if (same(out, zeroAddress)) invalid(`${name} must be nonzero`);
  return out;
}
function seconds(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(`${name} must be positive integer Unix seconds`);
  return value;
}
function validate(invoice: unknown, signed: boolean): asserts invoice is SignedInvoice {
  shape(invoice, signed ? ["version", "domain", "message", "signature"] : ["version", "domain", "message"], "invoice");
  if (invoice.version !== 1) invalid("unsupported invoice version");
  shape(invoice.domain, ["name", "version", "chainId", "verifyingContract"], "invoice domain");
  const d = invoice.domain;
  if (d.chainId !== CHAIN_ID) throw new RemessoError("wrong_chain", `invoice signatures are for Celo mainnet (${CHAIN_ID})`);
  if (d.name !== INVOICE_DOMAIN.name || d.version !== INVOICE_DOMAIN.version || typeof d.verifyingContract !== "string" || !same(d.verifyingContract, EXECUTOR)) invalid("invoice has a different signing domain or contract");
  shape(invoice.message, ["issuer", "payer", "recipient", "token", "amount", "orderId", "nonce", "issuedAt", "expiresAt", "requestId"], "invoice message");
  const m = invoice.message;
  const issuer = address(m.issuer, "issuer"), recipient = address(m.recipient, "recipient");
  address(m.payer, "payer");
  const asset = address(m.token, "token"); tokenOf(asset);
  if (!same(issuer, recipient)) invalid("the invoice recipient must sign as its issuer");
  if (typeof m.amount !== "string" || !/^[1-9]\d*$/.test(m.amount) || m.amount.length > 78 || BigInt(m.amount) >= 2n ** 256n) invalid("invoice amount must be a canonical positive uint256 base-unit string");
  if (typeof m.orderId !== "string" || !m.orderId.trim() || new TextEncoder().encode(m.orderId).length > 128 || /[\u0000-\u001f\u007f]/.test(m.orderId)) invalid("orderId must contain 1 to 128 UTF-8 bytes without control characters");
  if (!bytes32(m.nonce) || BigInt(m.nonce) === 0n) invalid("invoice nonce must be nonzero bytes32");
  const issued = seconds(m.issuedAt, "issuedAt"), expiry = seconds(m.expiresAt, "expiresAt");
  if (expiry <= issued) invalid("invoice expiresAt must be after issuedAt");
  if (typeof m.requestId !== "string" || (m.requestId !== "" && !UUID.test(m.requestId))) invalid("requestId must be a lowercase request UUID or empty");
  if (signed && (typeof invoice.signature !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(invoice.signature) || invoice.signature.length > 16_386)) invalid("invoice signature must be hex bytes (at most 8192)");
}
/** Amounts/timestamps are converted only after strict validation; no custom cryptography. */
export function invoiceTypedData(invoice: UnsignedInvoice) {
  const unsigned = { version: invoice?.version, domain: invoice?.domain, message: invoice?.message };
  validate(unsigned, false);
  const m = unsigned.message;
  return { domain: INVOICE_DOMAIN, types: INVOICE_TYPES, primaryType: "Invoice" as const,
    message: { ...m, amount: BigInt(m.amount), issuedAt: BigInt(m.issuedAt), expiresAt: BigInt(m.expiresAt) } };
}
export function makeInvoices(ctx: Ctx, deps: { requests: Requests; remittances: Remittances; receipts: Receipts; store?: InvoiceStore }) {
  const store = deps.store ?? memoryInvoiceStore();
  function details(invoice: SignedInvoice): VerifiedInvoice {
    const m = invoice.message, t = tokenOf(m.token), id = hashTypedData(invoiceTypedData(invoice));
    return { id, idempotencyKey: `invoice:${id}`, issuer: checksum(m.issuer), payer: checksum(m.payer), recipient: checksum(m.recipient),
      token: checksum(m.token), amount: BigInt(m.amount), amountDecimal: formatUnits(BigInt(m.amount), t.decimals),
      orderId: m.orderId, nonce: m.nonce, issuedAt: m.issuedAt, expiresAt: m.expiresAt, ...(m.requestId ? { requestId: m.requestId } : {}) };
  }
  async function requestMatches(invoice: VerifiedInvoice): Promise<RequestStatus | undefined> {
    if (!invoice.requestId) return undefined;
    const request = await deps.requests.get(invoice.requestId), r = request.requested;
    if (request.id !== invoice.requestId || request.reference !== invoice.requestId.replaceAll("-", "") || !same(request.payer, invoice.payer) || !same(r.to, invoice.recipient) || !r.amount || !r.token ||
      tokenOf(r.token).address.toLowerCase() !== invoice.token.toLowerCase() || toUnits(r.amount, tokenOf(invoice.token)) !== invoice.amount ||
      r.intervalSeconds != null || (r.runs != null && r.runs !== 1)) throw new RemessoError("refused", "the backend request differs from the signed invoice's payer, recipient, token, amount or one-off terms");
    return request;
  }
  async function verify(invoice: SignedInvoice, opts: { allowExpired?: boolean } = {}): Promise<VerifiedInvoice> {
    validate(invoice, true);
    const now = Math.floor(Date.now() / 1000);
    if (invoice.message.issuedAt > now + SKEW_S) throw new RemessoError("refused", "the invoice has not been issued yet");
    if (!opts.allowExpired && invoice.message.expiresAt <= now) throw new RemessoError("refused", "the invoice has expired");
    const typed = invoiceTypedData(invoice);
    let valid = false;
    try { valid = await verifyTypedData({ ...typed, address: invoice.message.issuer, signature: invoice.signature }); } catch { /* deployed smart wallets use ERC-1271 below */ }
    if (!valid) {
      const chainId = await ctx.pub.getChainId();
      if (chainId !== CHAIN_ID) throw new RemessoError("wrong_chain", "contract invoice signatures must be verified on Celo mainnet");
      const code = await ctx.pub.getCode({ address: invoice.message.issuer });
      if (code && code !== "0x") {
        const magic = await ctx.pub.readContract({ address: invoice.message.issuer, abi: ERC1271, functionName: "isValidSignature", args: [hashTypedData(typed), invoice.signature] }).catch(() => null);
        valid = magic === "0x1626ba7e";
      }
    }
    if (!valid) throw new RemessoError("refused", "the invoice signature does not belong to its recipient");
    return details(invoice);
  }
  function prepare(input: SignInvoiceInput): UnsignedInvoice {
    const account = ctx.requireAccount();
    if (!ctx.wallet) throw new RemessoError("no_account", "signing an invoice needs a wallet supporting signTypedData");
    if (!input || typeof input.amount !== "string" || typeof input.token !== "string") invalid("invoice amount and token are required strings");
    const t = tokenOf(input.token), recipient = checksum(input.recipient ?? account.address);
    if (!same(recipient, account.address)) throw new RemessoError("refused", "this account may only issue invoices payable to itself");
    const unsigned: UnsignedInvoice = { version: 1, domain: { ...INVOICE_DOMAIN }, message: {
      issuer: account.address, payer: checksum(input.payer), recipient, token: checksum(t.address), amount: toUnits(input.amount, t).toString(),
      orderId: input.orderId, nonce: input.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
      issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000), expiresAt: input.expiresAt, requestId: input.requestId ?? "",
    } };
    validate(unsigned, false);
    const info = details({ ...unsigned, signature: "0x01" }), now = Math.floor(Date.now() / 1000);
    if (info.issuedAt > now + SKEW_S || info.expiresAt <= now) throw new RemessoError("refused", "an invoice must be issued already and expire in the future");
    return unsigned;
  }
  async function sign(input: SignInvoiceInput): Promise<SignedInvoice> {
    const unsigned = prepare(input), account = ctx.requireAccount();
    await requestMatches(details({ ...unsigned, signature: "0x01" }));
    await ctx.assertChain();
    const signature = await ctx.wallet!.signTypedData({ account, ...invoiceTypedData(unsigned) });
    const signed = { ...unsigned, signature };
    await verify(signed);
    return signed;
  }
  return {
    sign,
    /** Create a backend request, then sign its exact terms. */
    async create(input: SignInvoiceInput): Promise<SignedInvoice> {
      const prepared = prepare(input);
      if (input.requestId) return await sign(input);
      const account = ctx.requireAccount();
      const request = await deps.requests.create({ payer: prepared.message.payer, to: account.address, amount: input.amount, token: input.token, runs: 1 });
      return await sign({ ...input, issuedAt: prepared.message.issuedAt, nonce: prepared.message.nonce, requestId: request.id });
    },
    verify,
    /** The immutable reservation pins this invoice to one signer/funding route even after an uncertain send. */
    async pay(invoice: SignedInvoice, options: PayInvoiceOptions): Promise<RemittanceResult & { invoiceId: Hex }> {
      // Expiry is checked below, after any payment already made for it: a retry
      // after the invoice expired must still learn that it was paid.
      const expected = await verify(invoice, { allowExpired: true });
      if (!options || !["wallet", "policy"].includes(options.funding)) invalid("choose wallet or policy invoice funding explicitly");
      if (Object.keys(options).some((key) => !["funding", "policyId", "waitMs", "maxDebit"].includes(key))) invalid("invoice payment options contain unknown fields");
      if (options.waitMs !== undefined && (!Number.isSafeInteger(options.waitMs) || options.waitMs < 1 || options.waitMs > 120_000)) invalid("waitMs must be from 1 to 120000 milliseconds");
      if (options.policyId !== undefined && ((typeof options.policyId === "number" && !Number.isSafeInteger(options.policyId)) || !/^[1-9]\d*$/.test(String(options.policyId)) || BigInt(options.policyId) >= 2n ** 256n)) invalid("invoice policyId must be a canonical positive uint256");
      const account = ctx.requireAccount();
      if (options.funding === "wallet" && !same(account.address, expected.payer)) throw new RemessoError("refused", "this wallet is not the payer named in the invoice");
      if (options.funding === "wallet" && "policyId" in options && options.policyId != null) invalid("wallet invoices cannot select a policy");
      // A schedule carries no memo, so nothing would tie its run to this
      // invoice rather than to any other payment of the same amount.
      if (options.funding === "wallet" && !expected.requestId) {
        throw new RemessoError("refused", "an invoice without a request is paid from a policy, whose payment carries the invoice's reference. To pay from a wallet, the recipient makes the invoice with invoices.create, which adds a request");
      }
      await requestMatches(expected);
      const terms = { to: expected.recipient, amount: expected.amountDecimal, token: expected.token, idempotencyKey: expected.idempotencyKey, requestId: expected.requestId, validUntil: expected.expiresAt };
      const memo = expected.requestId ? undefined : invoiceReference(expected.id);
      // A payment that can't be made now is refused before the invoice is
      // pinned to this route; a retry of a started one is answered as it is.
      const started = options.funding === "policy" ? await priorPayment(ctx, expected.idempotencyKey) : await ctx.remittanceStore?.get(expected.idempotencyKey, remittanceScope(ctx));
      if (!started) {
        if (expected.expiresAt <= Math.floor(Date.now() / 1000)) throw new RemessoError("refused", "the invoice has expired");
        const quote = await deps.remittances.quote(options.funding === "policy"
          ? { funding: "policy", to: terms.to, amount: terms.amount, token: terms.token, requestId: terms.requestId, idempotencyKey: terms.idempotencyKey, payer: expected.payer, ...(options.policyId === undefined ? {} : { policyId: options.policyId }) }
          : { funding: "wallet", to: terms.to, amount: terms.amount, token: terms.token, requestId: terms.requestId, idempotencyKey: terms.idempotencyKey });
        if (!quote.canSend) throw new RemessoError("refused", `this invoice can't be paid this way now: ${quote.issues.map((i) => i.message).join("; ")}`, { issues: quote.issues });
        // Checked before reserving: a cap the payment can't meet would leave the
        // invoice pinned to a route that can never pay it.
        if (options.maxDebit !== undefined && toUnits(options.maxDebit, tokenOf(expected.token)) < quote.grossDebit) {
          throw new RemessoError("refused", `paying this invoice debits more than maxDebit ${options.maxDebit}`, { grossDebit: quote.grossDebit.toString() });
        }
      }
      await store.reserve(expected.id, { funding: options.funding, signer: account.address, payer: expected.payer, key: expected.idempotencyKey,
        ...(options.policyId === undefined ? {} : { policyId: String(options.policyId) }) });
      const paid = await deps.remittances.send(options.funding === "policy"
        ? { ...options, ...terms, payer: expected.payer, ...(memo ? { memo } : {}) } : { ...options, ...terms });
      return { ...paid, invoiceId: expected.id };
    },
    /** Deduplicate BOTH invoiceId and payment.eventId atomically before fulfillment. */
    async verifyPayment(invoice: SignedInvoice, input: VerifyInvoicePaymentInput): Promise<InvoicePaymentProof> {
      const expected = await verify(invoice, { allowExpired: true }), request = await requestMatches(expected);
      const reference = expected.requestId ? expected.requestId.replaceAll("-", "") : invoiceReference(expected.id);
      const payment = await deps.receipts.verify({ ...input, from: expected.payer, to: expected.recipient, token: expected.token,
        amount: expected.amountDecimal, finality: input.finality ?? "finalized",
        ...(input.policyId !== undefined ? { memo: reference } : {}),
      });
      if (request) {
        if (payment.kind === "policy_payment" && !same(payment.memo, memo32(request.reference))) throw new RemessoError("conflict", "the policy payment does not carry this invoice's request reference");
        if (payment.kind === "run" && (!request.payment?.schedule || !same(request.payment.schedule.contract, payment.contract) || request.payment.schedule.id !== String(payment.scheduleId))) throw new RemessoError("conflict", "the schedule has not been bound to this invoice's backend request");
      } else if (payment.kind !== "policy_payment" || !same(payment.memo, memo32(reference))) {
        // Without a request, only the invoice's own reference ties a payment
        // to it: a subscription's run of the same amount is not this invoice.
        throw new RemessoError("conflict", "an invoice without a request is settled only by a policy payment carrying its reference (invoiceReference)");
      }
      const block = await ctx.pub.getBlock({ blockNumber: payment.blockNumber });
      if (!block.hash || !same(block.hash, payment.blockHash)) throw new RemessoError("conflict", "the invoice payment block is no longer canonical");
      if (block.timestamp + BigInt(SKEW_S) < BigInt(expected.issuedAt) || block.timestamp >= BigInt(expected.expiresAt)) throw new RemessoError("refused", "the payment was not included during the invoice's validity window");
      return { invoiceId: expected.id, orderId: expected.orderId, payment };
    },
  };
}
export type Invoices = ReturnType<typeof makeInvoices>;
