---
title: Run an agent service in production
description: "Workers that share one key, quotes, deadlines, signed invoices, recovery after a crash, local development, managed signers and agent tools."
---

The [agent-to-agent guide](./agent-to-agent.md) covers one buyer and one seller. This page covers what a service needs around them: several workers sharing a key, quotes and deadlines, signed invoices, recovery after a crash, and local development.

The APIs on this page need `remesso-sdk` 0.3.0 or later.

## Try both funding models locally

With Foundry's `anvil` installed and Node 20 or later:

```bash
npx remesso-sdk dev --smoke
```

This forks Celo mainnet into a local Anvil, funds public test accounts on it, starts an in-memory stand-in for Remesso's backend with a webhook receiver, pays once from a wallet and once from a policy, checks both, and cleans up. Without `--smoke` it keeps running and prints the settings and test keys to use. Every transaction goes to the local fork; Celo mainnet only supplies the state it starts from. Never fund the public test keys on a real network.

The stand-in backend isn't Remesso's: its timing, cron and finality are not production's. The same environment is available to a test suite:

```ts
import { startDev } from "remesso-sdk/dev";

const dev = await startDev();
try {
  console.log(dev.sampleInvoice.id, dev.receiverUrl);
  await dev.smoke();
} finally {
  await dev.close();
}
```

## Share journals across workers

Every process that signs with the same key must use the same journals and the same lock, or two workers could each pay the same order. With PostgreSQL (`postgres@3.4.5`), one call gives all four:

```ts
import postgres from "postgres";
import { createRemesso } from "remesso-sdk";
import { createPostgresStorage } from "remesso-sdk/postgres";
import { privateKeyToAccount } from "viem/accounts";

const sql = postgres(process.env.DATABASE_URL!, {
  max: 8,
  connection: { synchronous_commit: "on" },
});
const storage = createPostgresStorage(sql, { namespace: "my-agent-service" });
await storage.initialize(); // Once, before the workers start.

const agent = createRemesso({
  account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`),
  store: storage.paymentStore,
  remittanceStore: storage.remittanceStore,
  invoiceStore: storage.invoiceStore,
  coordinator: storage.coordinator,
});
```

`createRemesso` refuses a `coordinator` without the three stores: with journals in memory, each worker would keep its own record of keys, and a retry on another worker would pay again.

A session lock is held from reading the journal to broadcasting, so connect directly or through session pooling; transaction pooling can't hold it. If the connection is lost, the SDK stops before signing or sending anything more.

`initialize()` creates the SDK's own tables and turns on row-level security; signed transactions are stored in them, so keep them readable only by the server role that owns them. The package's `POSTGRES.md` has complete examples.

### When a transaction isn't sent

Every transaction is saved before it is broadcast. If a broadcast fails, the SDK retries it at once, and before signing anything new it sends again any saved transaction the network still doesn't have, lowest nonce first. So one lost broadcast can't hold up every transaction after it.

A saved transaction that must no longer land is cancelled instead of sent: the SDK signs a transaction that does nothing at the same nonce, and only one of the two can ever be mined. This happens to a policy payment still unsent close to its `validUntil`, and to a contract write (a schedule or a policy) whose caller was told it couldn't be broadcast.

## Quote and bound a payment

```ts
const prepared = await payer.remittances.prepare({
  funding: "wallet",
  to: receiver.address,
  amount: "1",
  token: "USDT",
  idempotencyKey: "order-123",
  maxDebit: "1.01", // The most the payer's balance may lose, fee included; gas is separate.
}, { ttlSeconds: 60 });

console.log(prepared.quote.protocolFee, prepared.quote.approval);
console.log(prepared.quote.gas.steps, prepared.quote.gas.notes);
const sent = await payer.remittances.send(prepared.input);
console.log(sent.status, sent.hash);
```

`quote()` signs nothing. It reports whether the payment can be sent now, why not if it can't, the fee, the approval needed, and simulations and gas estimates for each step. It reserves nothing: another payment can still use the balance, the daily budget or the allowance. A wallet payment's last step can't be simulated before its schedule and approval exist, so its gas is an estimate, not a measurement.

`prepare()` refuses a payment that can't be sent, and returns input with the token, the policy and `maxDebit` fixed, and `startBy` set to when the quote expires.

## Deadlines

- `startBy`: the payment must start before this time. Once it has started, a retry continues it at any time: a payment that went through is reported as paid, never as expired.
- `validUntil`: the payment must land before this time.
  - From a wallet, the schedule expires a second earlier, so the contract refuses a late payment.
  - From a policy, nothing is broadcast in the last 30 seconds; a payment still unsent then is cancelled at its nonce, as above.
  - Neither starts within minutes of the deadline. A retry can't change it.

A payment cancelled or expired this way is reported as not paid only once that is certain, as a `refused` error with `details.expired` or `details.cancelled`. Then, and only then, a new key may pay again.

## Sign an invoice

A signed invoice is the recipient's EIP-712 signature over the exact payer, recipient, token, amount, order id, a random nonce, and when it was issued and expires. The payer can check it was signed by the recipient before paying.

`create()` also creates a backend request with the same terms and signs it. `sign()` signs without one.

```ts
const invoice = await receiver.invoices.create({
  payer: payer.address,
  amount: "1",
  token: "USDT",
  orderId: "order-123",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

const terms = await payer.invoices.verify(invoice);
const sent = await payer.invoices.pay(invoice, {
  funding: "wallet",
  maxDebit: "1.01",
});
console.log(terms.id, sent.status, sent.hash);
```

For policy funding the invoice names the policy owner as the payer, and the agent pays with `invoices.pay(invoice, { funding: "policy", policyId })`.

`pay` quotes the payment before anything else, and refuses one that can't be made now. It then reserves the invoice for this payment route, signer and key, so no other route can pay it as well. Keep that reservation after a payment whose outcome is uncertain. The default reservation store is memory; workers share the Postgres one.

An invoice made with `sign()` and no request is tied to its payment only by the payment's memo, which carries `invoiceReference(invoice id)`. A schedule's payment has no memo, so such an invoice is paid from a policy; to pay from a wallet, make the invoice with `create()`.

### Verify the payment

```ts
import type { SignedInvoice } from "remesso-sdk";
import type { Hex } from "viem";

declare const invoice: SignedInvoice;
declare const paymentHash: Hex;
const evidence = await receiver.invoices.verifyPayment(invoice, {
  txHash: paymentHash,
  scheduleId,
  finality: "finalized",
});
console.log(evidence.invoiceId, evidence.orderId, evidence.payment.eventId);
```

Pass `policyId` instead of `scheduleId` for a policy payment. `verifyPayment` checks the payment against the invoice's exact terms, and that it is this invoice's payment:
- with a request, the policy payment carries the request's reference, or the schedule is the one the request was answered with;
- without one, the policy payment carries `invoiceReference`. A subscription's payment of the same amount doesn't count.

It also checks that the payment landed while the invoice was valid; it can confirm an expired invoice that was paid in time. It is finalized by default and refuses while the RPC can't say whether the block is final.

### Fulfil each order once

Commit the fulfilment and its deduplication together. The Postgres inbox refuses a payment, an invoice or an order that was already fulfilled:

```ts
import type { SignedInvoice } from "remesso-sdk";
import { createPostgresStorage } from "remesso-sdk/postgres";
import type { Hex } from "viem";

declare const storage: ReturnType<typeof createPostgresStorage>;
declare const invoice: SignedInvoice;
declare const paymentHash: Hex;
const terms = await receiver.invoices.verify(invoice, { allowExpired: true });
const verified = await receiver.invoices.verifyPayment(invoice, {
  txHash: paymentHash, scheduleId, finality: "finalized",
});
await storage.inbox.processOnce({
  eventId: verified.payment.eventId,
  invoiceId: verified.invoiceId,
  issuer: terms.issuer,
  orderId: terms.orderId,
}, async (tx) => {
  await tx.unsafe(
    "update orders set paid_at = clock_timestamp() where issuer = $1 and id = $2",
    [terms.issuer.toLowerCase(), terms.orderId],
  );
  // Insert an outbox row here for emails, shipping or calls to other services.
});
```

Make every business write through `tx`: if the callback throws, the claim and the writes roll back together. An email or an HTTP call can't roll back, so queue those in an outbox in the same transaction.

## Recover payments after a crash

```ts
const operation = await agent.remittances.get("order-123", { funding: "wallet" });
console.log(operation.status, operation.stage, operation.error);

const pending = await agent.remittances.listPending();
await agent.remittances.reconcile("order-123", { funding: "wallet", waitMs: 30_000 });
const recovered = await agent.remittances.recoverPending({ limit: 25, waitMs: 5_000 });
console.log(pending.length, recovered.length);
```

`get()` and `listPending()` only read: the saved payment and what the chain says about it. `reconcile()` and `recoverPending()` continue payments that have started: they send saved transactions, and finish a wallet payment's remaining steps. They never start a payment, and never start a new one under an old key. A payment saved but never signed, for example because signing failed, is left for its own caller to retry.

The statuses are `prepared`, `awaiting_approval`, `signed`, `broadcast`, `included`, `finalized`, `failed`, `cancelled`, `paused`, `expired` and `needs_reconciliation`. A wallet payment whose step reverted while its schedule is still live is `needs_reconciliation`, not `failed`: it could still be paid, and reconciling cancels it. A transaction whose nonce was used by something else, with no receipt to show what, also needs a person to look at its hash; the SDK never pays it again.

`recoverPending()` makes one pass, over 25 payments by default; run it from your own scheduler. If a key exists in both journals, pass `funding`.

```ts
const settled = await agent.remittances.wait("order-123", {
  funding: "wallet",
  finality: "finalized",
  timeoutMs: 30 * 60_000,
  signal: AbortSignal.timeout(30 * 60_000),
});
console.log(settled.proof?.eventId);
```

`wait()` only watches. It throws for a payment that failed, was cancelled, paused or expired.

### Jobs

`storage.jobs` is a queue for your own work: enqueue under a key that never changes, claim with `SKIP LOCKED`, and acknowledge with the claim's token. A job is delivered at least once, so use its key as the payment's idempotency key. A claim lasts five minutes by default, longer than a payment's wait; renew it with `extend` for longer work. Payment keys belong to one signing key, so the workers that take payment jobs must all sign with the same key.

## Managed signers

A key held by a custody service plugs in through callbacks that sign and never broadcast:

```ts
import { createRemesso } from "remesso-sdk";
import {
  managedSigner,
  type ManagedTransactionRequest,
  type ManagedTypedDataRequest,
} from "remesso-sdk/signers";
import type { Address, Hex } from "viem";

declare const provider: {
  address: Address;
  signTransaction(request: ManagedTransactionRequest): Promise<Hex>;
  signTypedData(request: ManagedTypedDataRequest): Promise<Hex>;
};
const account = managedSigner({
  address: provider.address,
  signTransaction: (request) => provider.signTransaction(request),
  signTypedData: (request) => provider.signTypedData(request),
});
const agent = createRemesso({ account }); // In production, add the shared journals above.
```

The SDK passes the exact transaction, its Celo encoding and its hash, including a fee currency. It refuses anything back that differs: other fields, another signer, or a high-s signature, which Celo nodes reject. The SDK keeps simulation, journaling, nonces and broadcasting. No custody provider has been tested with it yet.

## Agent tools

`remesso-sdk/tools` gives an agent framework tools with JSON schemas and structured results. They return no wallet objects or signed bytes, and a URL in an error keeps only its host. Tools that pay are off by default:

```ts
import { createAgentTools } from "remesso-sdk/tools";

const tools = createAgentTools(agent);
console.log(tools.list());
const result = await tools.call("remesso_quote", {
  funding: "wallet", to: receiver.address, amount: "1", token: "USDT",
});
console.log(result);
```

Allow a payment from your own records of what was ordered and approved, with `authorizeWrite({ name, input })`; text from a model or a tool description is never permission to spend. `enableWrites: true` is for hosts that already check this themselves. When a payment's outcome is uncertain, the tool says so: reconcile its key rather than making a new one.

The repository's MCP server uses these tools and the same journals. Its tools that pay stay off unless the host sets `REMESSO_ENABLE_AGENT_TOOLS_WRITES=1`:

```bash
npm --prefix mcp install
npm --prefix mcp run build
npm --prefix mcp start
```
