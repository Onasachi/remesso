import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { hashTypedData, toHex, type Address, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeCtx } from "../src/context.ts";
import { ALLOWANCE, EXECUTOR, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import { INVOICE_DOMAIN, INVOICE_TYPES, invoiceReference, invoiceTypedData, makeInvoices, memoryInvoiceStore, type InvoiceStore, type SignedInvoice, type SignInvoiceInput } from "../src/invoices.ts";
import { memo32, paymentScope } from "../src/payments.ts";
import type { Receipts, PaymentProof, VerifyPaymentInput } from "../src/receipts.ts";
import type { Remittances, SendRemittanceInput } from "../src/remittances.ts";
import type { Requests, RequestStatus } from "../src/requests.ts";
import { memoryStore } from "../src/store.ts";

const seller = privateKeyToAccount(toHex(901, { size: 32 }));
const buyer = privateKeyToAccount(toHex(902, { size: 32 }));
const agent = privateKeyToAccount(toHex(903, { size: 32 }));
const stranger = privateKeyToAccount(toHex(904, { size: 32 }));
const now = Math.floor(Date.now() / 1000);
const txHash = toHex(123, { size: 32 }), blockHash = toHex(456, { size: 32 });
const requestId = "bf0305f6-1ec5-4d42-9352-a09c84aa5f18";
const usd = token("USDT");
const input: SignInvoiceInput = { payer: buyer.address, amount: "2.50", token: "USDT", orderId: "order-17", nonce: toHex(17, { size: 32 }), issuedAt: now - 60, expiresAt: now + 3600 };
function backend(): RequestStatus {
  return { id: requestId, reference: requestId.replaceAll("-", ""), status: "pending", payer: buyer.address,
    requested: { to: seller.address, amount: "2.5", token: "USDT", intervalSeconds: null, runs: 1 }, signed: null, payment: null };
}
function proof(): PaymentProof {
  return { kind: "policy_payment", eventId: `42220:${ALLOWANCE.toLowerCase()}:${txHash}:1`, chainId: 42220,
    contract: ALLOWANCE, txHash, logIndex: 1, blockNumber: 101n, blockHash, from: buyer.address, to: seller.address,
    token: usd.address as Address, amount: 2_500_000n, finality: "finalized", policyId: 7n, agent: agent.address,
    memo: memo32(requestId.replaceAll("-", "")), callerVerified: true };
}
function fixture(options: { signer?: typeof seller | null; store?: InvoiceStore; request?: RequestStatus; proof?: PaymentProof; timestamp?: bigint;
  chain?: number; code?: `0x${string}`; contractValid?: boolean; sendFailure?: boolean; blockHash?: `0x${string}`; quoteIssue?: string } = {}) {
  const account = options.signer === undefined ? seller : options.signer;
  const calls = { sign: 0, create: 0, request: 0, quote: 0, send: [] as SendRemittanceInput[], verify: [] as VerifyPaymentInput[], contract: 0 };
  const pub = { getChainId: async () => options.chain ?? 42220, getCode: async () => options.code,
    readContract: async () => { calls.contract++; return options.contractValid ? "0x1626ba7e" : "0xffffffff"; },
    getBlock: async () => ({ number: 101n, hash: options.blockHash ?? blockHash, timestamp: options.timestamp ?? BigInt(now) }),
  } as unknown as PublicClient;
  const wallet = account ? { getChainId: async () => options.chain ?? 42220,
    signTypedData: async (typed: Parameters<typeof account.signTypedData>[0]) => { calls.sign++; return await account.signTypedData(typed); },
  } as unknown as WalletClient : null;
  const ctx = makeCtx({ pub, account, wallet, endpoints: { requestPayment: "https://sdk.test/requests", paymentEvents: "https://sdk.test/events", webhooks: "https://sdk.test/webhooks" },
    appOrigin: "https://sdk.test", fetch, dataSuffix: undefined, store: memoryStore() });
  const api = makeInvoices(ctx, { store: options.store,
    requests: { get: async () => { calls.request++; return options.request ?? backend(); },
      create: async () => { calls.create++; return { id: requestId, reference: requestId.replaceAll("-", ""), link: "https://sdk.test/invoice", status: "pending" }; },
    } as unknown as Requests,
    remittances: {
      quote: async () => { calls.quote++; return { canSend: !options.quoteIssue, grossDebit: 2_506_266n, issues: options.quoteIssue ? [{ code: "run_limits", message: options.quoteIssue }] : [] }; },
      send: async (terms: SendRemittanceInput) => { calls.send.push(terms); if (options.sendFailure) throw new RemessoError("http", "unknown broadcast outcome");
      return { funding: "policy", status: "confirmed", payer: buyer.address, fee: 0n, hash: txHash, policyId: 7n,
        to: seller.address, amount: 2_500_000n, token: usd.address, sent: "2.5 USDT", explorer: `https://sdk.test/tx/${txHash}` }; },
    } as unknown as Remittances,
    receipts: { verify: async (terms: VerifyPaymentInput) => { calls.verify.push(terms); return options.proof ?? proof(); } } as Receipts,
  });
  return { api, calls, ctx };
}
function change(invoice: SignedInvoice, key: string, value: unknown): SignedInvoice {
  return { ...invoice, message: { ...invoice.message, [key]: value } } as SignedInvoice;
}

Deno.test("signed invoices serialize losslessly and independently verify exact EIP-712 terms", async () => {
  const { api } = fixture(), signed = await api.sign(input), read = fixture({ signer: null });
  const json = JSON.parse(JSON.stringify(signed)) as SignedInvoice;
  const verified = await read.api.verify(json);
  assertEquals(json.message.amount, "2500000");
  assertEquals(json.domain, INVOICE_DOMAIN);
  assertEquals([verified.amount, verified.amountDecimal, verified.payer, verified.recipient, verified.orderId], [2_500_000n, "2.5", buyer.address, seller.address, input.orderId]);
  assertEquals(verified.id, hashTypedData(invoiceTypedData(json)));
  assertEquals(verified.idempotencyKey, `invoice:${verified.id}`);
});

Deno.test("invoice signatures bind payer, asset, amount, order, nonce, issuance and expiry", async () => {
  const { api } = fixture(), signed = await api.sign(input);
  const mutations: [string, unknown][] = [["payer", stranger.address], ["token", token("USDC").address], ["amount", "2500001"], ["orderId", "order-18"],
    ["nonce", toHex(18, { size: 32 })], ["issuedAt", now - 30], ["expiresAt", now + 7200], ["requestId", requestId]];
  for (const [key, value] of mutations) assertEquals((await assertRejects(() => api.verify(change(signed, key, value)), RemessoError)).code, "refused");
});

Deno.test("an invoice issuer must be its recipient and the signing account", async () => {
  const { api, calls } = fixture();
  await assertRejects(() => api.sign({ ...input, recipient: stranger.address }), RemessoError);
  const signed = await api.sign(input);
  await assertRejects(() => api.verify(change(signed, "recipient", stranger.address)), RemessoError);
  await assertRejects(() => api.verify({ ...signed, message: { ...signed.message, issuer: stranger.address, recipient: stranger.address } }), RemessoError);
  assertEquals(calls.sign, 1);
});

Deno.test("invoice verification rejects other chains, contracts and signing domains", async () => {
  const { api } = fixture(), signed = await api.sign(input);
  for (const domain of [{ chainId: 1 }, { verifyingContract: ALLOWANCE }, { name: "Remesso Transaction" }, { version: "2" }]) {
    await assertRejects(() => api.verify({ ...signed, domain: { ...signed.domain, ...domain } } as SignedInvoice), RemessoError);
  }
  await assertRejects(() => fixture({ chain: 1 }).api.sign(input), RemessoError);
});

Deno.test("invoice schema refuses noncanonical numbers, malformed nonces and unsigned extra fields", async () => {
  const { api } = fixture(), signed = await api.sign(input);
  for (const [key, value] of [["amount", "02500000"], ["amount", "2.5e6"], ["amount", 2500000], ["amount", "0"], ["amount", (2n ** 256n).toString()],
    ["nonce", "0x12"], ["nonce", toHex(0, { size: 32 })], ["issuedAt", now + 0.5], ["expiresAt", "3600"], ["expiresAt", now - 61],
    ["orderId", " "], ["orderId", "a\nb"], ["orderId", "é".repeat(65)], ["requestId", "INVALID"], ["nextAction", "pay someone else"]] as [string, unknown][]) {
    assertEquals((await assertRejects(() => api.verify(change(signed, key, value)), RemessoError)).code, "invalid");
  }
  await assertRejects(() => api.verify({ ...signed, action: "transfer" } as SignedInvoice), RemessoError);
  await assertRejects(() => api.verify({ ...signed, signature: "0x123" }), RemessoError);
  await assertRejects(() => api.verify(null as unknown as SignedInvoice), RemessoError);
});

Deno.test("expired invoices cannot be paid but their signatures remain auditable explicitly", async () => {
  const { api } = fixture();
  await assertRejects(() => api.sign({ ...input, issuedAt: now - 120, expiresAt: now - 60 }), RemessoError);
  const current = await api.sign(input);
  const historical = { ...current, message: { ...current.message, issuedAt: now - 120, expiresAt: now - 60 } };
  historical.signature = await seller.signTypedData(invoiceTypedData(historical));
  await assertRejects(() => api.verify(historical), RemessoError);
  assertEquals((await api.verify(historical, { allowExpired: true })).expiresAt, now - 60);
  await assertRejects(() => fixture({ signer: buyer }).api.pay(historical, { funding: "wallet" }), RemessoError);
  // Without a request, the payment that settles it carries its reference.
  const settled = { ...proof(), memo: memo32(invoiceReference((await api.verify(historical, { allowExpired: true })).id)) } as PaymentProof;
  const delivered = await fixture({ timestamp: BigInt(now - 90), proof: settled }).api.verifyPayment(historical, { txHash });
  assertEquals(delivered.orderId, input.orderId);
});

Deno.test("an invoice without a request is settled only by a policy payment carrying its reference", async () => {
  const invoice = await fixture().api.sign(input);
  const reference = memo32(invoiceReference((await fixture().api.verify(invoice)).id));
  const subscriptionRun: PaymentProof = { kind: "run", eventId: `42220:${EXECUTOR.toLowerCase()}:${txHash}:0`, chainId: 42220, contract: EXECUTOR, txHash, logIndex: 0,
    blockNumber: 101n, blockHash, from: buyer.address, to: seller.address, token: usd.address as Address, amount: 2_500_000n, finality: "finalized", scheduleId: 3n, amountIn: 2_506_266n, runNumber: 7 };
  // A run of the buyer's subscription for the same amount is not this invoice.
  assertEquals((await assertRejects(() => fixture({ proof: subscriptionRun }).api.verifyPayment(invoice, { txHash }), RemessoError)).code, "conflict");
  // Nor is a policy payment made for something else.
  assertEquals((await assertRejects(() => fixture({ proof: { ...proof(), memo: memo32("another order") } as PaymentProof }).api.verifyPayment(invoice, { txHash }), RemessoError)).code, "conflict");
  const f = fixture({ proof: { ...proof(), memo: reference } as PaymentProof });
  assertEquals((await f.api.verifyPayment(invoice, { txHash, policyId: 7n })).orderId, input.orderId);
  assertEquals(memo32(f.calls.verify[0].memo), reference);
  // And paying it from a policy carries that reference.
  const agentSide = fixture({ signer: agent });
  await agentSide.api.pay(invoice, { funding: "policy", policyId: 7n });
  assertEquals(memo32(agentSide.calls.send[0].memo), reference);
  // A wallet can't carry it, so a wallet is refused before anything is reserved or sent.
  const buyerSide = fixture({ signer: buyer });
  assertEquals((await assertRejects(() => buyerSide.api.pay(invoice, { funding: "wallet" }), RemessoError)).code, "refused");
  assertEquals([buyerSide.calls.quote, buyerSide.calls.send.length], [0, 0]);
});

Deno.test("an invoice that can't be paid now is refused before it is reserved to a route", async () => {
  const invoice = await fixture().api.sign({ ...input, requestId }), store = memoryInvoiceStore();
  const wallet = fixture({ signer: buyer, store, quoteIssue: "the gross debit is outside this token's executor run limits" });
  assertEquals((await assertRejects(() => wallet.api.pay(invoice, { funding: "wallet" }), RemessoError)).code, "refused");
  assertEquals(wallet.calls.send.length, 0);
  // The refusal left no reservation: another route can still pay it.
  const policy = fixture({ signer: agent, store });
  await policy.api.pay(invoice, { funding: "policy", policyId: 7n });
  assertEquals(policy.calls.send.length, 1);
});

Deno.test("invoice nonce defaults are random and fixed terms reconstruct the same replay key", async () => {
  const { api } = fixture();
  const a = await api.sign({ ...input, nonce: undefined }), b = await api.sign({ ...input, nonce: undefined });
  assertNotEquals(a.message.nonce, b.message.nonce);
  assertNotEquals((await api.verify(a)).id, (await api.verify(b)).id);
  const c = await api.sign(input), d = await api.sign(input);
  assertEquals((await api.verify(c)).id, (await api.verify(d)).id);
});

Deno.test("create validates before side effects then binds the returned backend request", async () => {
  const { api, calls } = fixture();
  await assertRejects(() => api.create({ ...input, orderId: "" }), RemessoError);
  assertEquals(calls.create, 0);
  const invoice = await api.create(input);
  assertEquals([calls.create, calls.request, calls.sign, invoice.message.requestId], [1, 1, 1, requestId]);
  await api.create({ ...input, requestId });
  assertEquals(calls.create, 1);
});

Deno.test("backend invoice terms are checked before signing or paying", async () => {
  const valid = await fixture().api.sign({ ...input, requestId });
  for (const requested of [{ amount: "3" }, { to: stranger.address }, { token: "USDC" }, { intervalSeconds: 86400 }, { runs: 2 }, { amount: null }]) {
    const r = backend(); r.requested = { ...r.requested, ...requested };
    const f = fixture({ request: r, signer: buyer });
    await assertRejects(() => f.api.pay(valid, { funding: "wallet" }), RemessoError);
    assertEquals(f.calls.send.length, 0);
    const signer = fixture({ request: r });
    await assertRejects(() => signer.api.sign({ ...input, requestId }), RemessoError);
    assertEquals(signer.calls.sign, 0);
  }
  const r = backend(); r.payer = stranger.address;
  await assertRejects(() => fixture({ request: r }).api.sign({ ...input, requestId }), RemessoError);
  const changedReference = backend(); changedReference.reference = "another-reference";
  await assertRejects(() => fixture({ request: changedReference }).api.sign({ ...input, requestId }), RemessoError);
});

Deno.test("wallet invoice sends require the named payer and force exact signed terms", async () => {
  const invoice = await fixture().api.sign({ ...input, requestId }), f = fixture({ signer: buyer });
  const result = await f.api.pay(invoice, { funding: "wallet" });
  const verified = await f.api.verify(invoice);
  assertEquals(result.invoiceId, verified.id);
  assertEquals(f.calls.send, [{ funding: "wallet", to: seller.address, amount: "2.5", token: usd.address, idempotencyKey: verified.idempotencyKey, requestId, validUntil: invoice.message.expiresAt }]);
  const wrong = fixture({ signer: stranger });
  assertEquals((await assertRejects(() => wrong.api.pay(invoice, { funding: "wallet" }), RemessoError)).code, "refused");
  assertEquals(wrong.calls.send.length, 0);
});

Deno.test("policy invoice sends constrain the funds owner, not the agent's own wallet", async () => {
  const invoice = await fixture().api.sign({ ...input, requestId }), f = fixture({ signer: agent });
  await f.api.pay(invoice, { funding: "policy", policyId: 7n });
  assertEquals(f.calls.send[0].payer, buyer.address);
  assertEquals(f.calls.send[0].policyId, 7n);
  assertEquals(f.calls.send[0].requestId, requestId);
});

Deno.test("shared invoice reservation refuses cross-funding, cross-agent and cross-policy replay", async () => {
  const invoice = await fixture().api.sign({ ...input, requestId }), store = memoryInvoiceStore();
  const owner = fixture({ signer: buyer, store }), delegate = fixture({ signer: agent, store });
  await owner.api.pay(invoice, { funding: "wallet" });
  await owner.api.pay(invoice, { funding: "wallet" });
  assertEquals((await assertRejects(() => delegate.api.pay(invoice, { funding: "policy", policyId: 7 }), RemessoError)).code, "key_reused");
  const secondStore = memoryInvoiceStore(), a = fixture({ signer: agent, store: secondStore }), b = fixture({ signer: stranger, store: secondStore });
  await a.api.pay(invoice, { funding: "policy", policyId: 7 });
  await assertRejects(() => a.api.pay(invoice, { funding: "policy", policyId: 8 }), RemessoError);
  await assertRejects(() => b.api.pay(invoice, { funding: "policy", policyId: 7 }), RemessoError);
  assertEquals([delegate.calls.send.length, b.calls.send.length], [0, 0]);
});

Deno.test("failed or uncertain sends retain their immutable invoice reservation", async () => {
  const invoice = await fixture().api.sign({ ...input, requestId }), store = memoryInvoiceStore();
  const a = fixture({ signer: agent, store, sendFailure: true });
  await assertRejects(() => a.api.pay(invoice, { funding: "policy", policyId: 7 }), RemessoError);
  await assertRejects(() => fixture({ signer: buyer, store }).api.pay(invoice, { funding: "wallet" }), RemessoError);
  const resumed = fixture({ signer: agent, store });
  await resumed.api.pay(invoice, { funding: "policy", policyId: 7 });
  assertEquals(resumed.calls.send.length, 1);
});

Deno.test("invalid invoice funding options fail before reserving or sending", async () => {
  let reserved = 0;
  const invoice = await fixture().api.sign(input), f = fixture({ signer: buyer, store: { reserve: async () => { reserved++; } } });
  for (const options of [{ funding: "auto" }, { funding: "wallet", policyId: 7 }, { funding: "policy", policyId: -1 }, { funding: "policy", policyId: "07" }, { funding: "wallet", payer: stranger.address }]) {
    await assertRejects(() => f.api.pay(invoice, options as never), RemessoError);
  }
  assertEquals([reserved, f.calls.send.length], [0, 0]);
});

Deno.test("invoice verification supports deployed ERC-1271 issuers on the correct chain", async () => {
  const signed = await fixture().api.sign(input);
  const contractInvoice = { ...signed, message: { ...signed.message, issuer: stranger.address, recipient: stranger.address }, signature: "0x1234" as const };
  const smart = fixture({ signer: null, code: "0x6000", contractValid: true });
  assertEquals((await smart.api.verify(contractInvoice)).issuer, stranger.address);
  assertEquals(smart.calls.contract, 1);
  await assertRejects(() => fixture({ signer: null, code: "0x6000", contractValid: false }).api.verify(contractInvoice), RemessoError);
  await assertRejects(() => fixture({ signer: null, chain: 1, code: "0x6000", contractValid: true }).api.verify(contractInvoice), RemessoError);
});

Deno.test("invoice payment verification requires exact receipt terms and defaults to finalized", async () => {
  const invoice = await fixture().api.sign({ ...input, requestId }), f = fixture({ signer: null });
  const result = await f.api.verifyPayment(invoice, { txHash, policyId: 7 });
  assertEquals([result.invoiceId, result.orderId, result.payment.eventId], [(await f.api.verify(invoice)).id, input.orderId, proof().eventId]);
  assertEquals(f.calls.verify, [{ txHash, policyId: 7, from: buyer.address, to: seller.address, token: usd.address,
    amount: "2.5", finality: "finalized", memo: requestId.replaceAll("-", "") }]);
});

Deno.test("bound invoices refuse another request's policy memo or an unbound schedule", async () => {
  const invoice = await fixture().api.sign({ ...input, requestId });
  await assertRejects(() => fixture({ proof: { ...proof(), memo: memo32("another") } as PaymentProof }).api.verifyPayment(invoice, { txHash }), RemessoError);
  const run: PaymentProof = { ...proof(), kind: "run", contract: EXECUTOR, scheduleId: 8n, amountIn: 2_506_266n, runNumber: 1 };
  await assertRejects(() => fixture({ proof: run }).api.verifyPayment(invoice, { txHash, scheduleId: 8 }), RemessoError);
  const request = backend(); request.payment = { state: "paid", schedule: { contract: EXECUTOR, id: "8" }, txs: [{ txHash, amount: "2.5", final: true, blockTime: new Date().toISOString() }], reason: null };
  const paid = await fixture({ proof: run, request }).api.verifyPayment(invoice, { txHash, scheduleId: 8 });
  assertEquals(paid.payment.kind, "run");
});

Deno.test("invoice receipt must be canonical and included within its signed validity window", async () => {
  const invoice = await fixture().api.sign(input);
  const settled = { ...proof(), memo: memo32(invoiceReference((await fixture().api.verify(invoice)).id)) } as PaymentProof;
  // Five minutes before issue is a fast clock, more is an older payment; at expiry is late.
  for (const timestamp of [BigInt(input.issuedAt! - 301), BigInt(input.expiresAt)]) {
    assertEquals((await assertRejects(() => fixture({ timestamp, proof: settled }).api.verifyPayment(invoice, { txHash }), RemessoError)).code, "refused");
  }
  assertEquals((await fixture({ timestamp: BigInt(input.issuedAt! - 1), proof: settled }).api.verifyPayment(invoice, { txHash })).orderId, input.orderId);
  await assertRejects(() => fixture({ blockHash: toHex(999, { size: 32 }), proof: settled }).api.verifyPayment(invoice, { txHash }), RemessoError);
});

Deno.test("invoice type definition is stable and excludes the signature from replay identity", () => {
  assertEquals(INVOICE_TYPES.Invoice.map((field) => field.name), ["issuer", "payer", "recipient", "token", "amount", "orderId", "nonce", "issuedAt", "expiresAt", "requestId"]);
});

Deno.test("a paid invoice retried after it expires reports its payment; an unpaid one stays refused", async () => {
  const { api } = fixture();
  const signed = await api.sign(input);
  const historical = { ...signed, message: { ...signed.message, issuedAt: now - 120, expiresAt: now - 60 } };
  historical.signature = await seller.signTypedData(invoiceTypedData(historical));
  const f = fixture({ signer: agent });
  const terms = await f.api.verify(historical, { allowExpired: true });
  assertEquals((await assertRejects(() => f.api.pay(historical, { funding: "policy", policyId: 7n }), RemessoError)).message, "the invoice has expired");
  // Paid while it was valid. Before: the retry answered "expired" and never looked.
  await f.ctx.store.save({ key: terms.idempotencyKey, deployment: paymentScope(f.ctx), owner: buyer.address, policyId: "7", to: seller.address, units: "2500000",
    token: usd.address as Address, memo: memo32(invoiceReference(terms.id)), hash: txHash, nonce: 1, raw: "0x01", status: "confirmed", at: new Date().toISOString() });
  const paid = await f.api.pay(historical, { funding: "policy", policyId: 7n });
  assertEquals([paid.status, f.calls.send.length], ["confirmed", 1]);
});

Deno.test("payment options that can't work are refused before the invoice is reserved", async () => {
  const invoice = await fixture().api.sign({ ...input, requestId }), store = memoryInvoiceStore();
  const wallet = fixture({ signer: buyer, store });
  // The payment debits 2.506266 with its fee; a 2.5 cap can never pay it.
  assertEquals((await assertRejects(() => wallet.api.pay(invoice, { funding: "wallet", maxDebit: "2.5" }), RemessoError)).code, "refused");
  assertEquals((await assertRejects(() => wallet.api.pay(invoice, { funding: "wallet", waitMs: 0 }), RemessoError)).code, "invalid");
  assertEquals(wallet.calls.send.length, 0);
  // Before: the cap was checked only after reserving, and this route was refused as key_reused.
  const policy = fixture({ signer: agent, store });
  await policy.api.pay(invoice, { funding: "policy", policyId: 7n });
  assertEquals(policy.calls.send.length, 1);
});
