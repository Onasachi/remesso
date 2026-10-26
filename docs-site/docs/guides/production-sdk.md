---
title: Build a production agent service
description: Shared Postgres coordination, signed invoices, bounded quotes, recovery, local development and agent tools.
---

This guide covers **0.3.0-rc.1 in the current checkout**. It is unpublished;
the npm release remains 0.2.0. Build the SDK locally while evaluating these APIs.
Start with the [agent-to-agent guide](./agent-to-agent.md) for the two funding
models: the agent's own wallet, or a person's or treasury's spending policy.

## Try both funding models locally

Install Foundry's `anvil` and Node 20 or later, then run from the repository:

```bash
cd packages/remesso-sdk
npm install
npm run dev:smoke
```

This starts an owned Celo fork with funded public test accounts, a sample invoice
and a signed webhook receiver, exercises both payment routes, then cleans up.
`npm run dev` keeps it running and prints the SDK RPC/backend settings and test
keys. All transactions go to the local fork; the upstream RPC supplies reads.
The receiving backend is an in-memory development emulator. Production cron,
public webhook networking and real finality timing need separate integration
checks. Never fund these public test keys on a live network.

For a test suite, the optional Node entry point provides the same environment:

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

## Share journals and signer coordination

For multiple worker processes, install `postgres@3.4.5` and configure all four
storage/coordinator options together:

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
await storage.initialize(); // Initialize once before starting workers.

const agent = createRemesso({
  account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`),
  store: storage.paymentStore,
  remittanceStore: storage.remittanceStore,
  invoiceStore: storage.invoiceStore,
  coordinator: storage.coordinator,
});
```

Every process using the same signing wallet must use the same database,
namespace and journals. A session advisory lock covers lookup, signing,
recording and broadcast across both funding routes. Use direct PostgreSQL or
session pooling; transaction pooling cannot preserve this lock. The SDK checks
the held session before writing and broadcasting and fails closed on loss.
Coordinated writes require a sign-only local or `managedSigner` account and a
public client configured with `chain: celo`. A wallet that broadcasts internally
cannot provide the durable pre-broadcast transaction bytes this protocol needs.

`initialize()` creates SDK-owned tables, enables row level security and requires
durable database settings. Use a trusted server role owning those tables, or
deliberately configure server policies. Keep signed bytes private and preserve
the driver's installed connection hooks. The SDK package includes `POSTGRES.md`
with complete storage, job and fulfillment examples.

Keys and signed bytes are retained indefinitely. Generic policy/schedule writes
also retain nonce evidence before coordinated broadcast. This preserves nonce
safety; it does not make a newly requested policy creation idempotent. Retain
its original transaction details rather than creating another policy on retry.

## Review a quote and bound the send

```ts
const prepared = await payer.remittances.prepare({
  funding: "wallet",
  to: receiver.address,
  amount: "1",
  token: "USDT",
  idempotencyKey: "order-123",
  maxDebit: "1.01", // Token debit including protocol fees; network gas is separate.
}, { ttlSeconds: 60 });

console.log(prepared.quote.protocolFee, prepared.quote.approval);
console.log(prepared.quote.gas.steps, prepared.quote.gas.notes);
const sent = await payer.remittances.send(prepared.input);
console.log(sent.status, sent.hash);
```

`quote()` is read-only and returns `canSend`, issues, available policy funds,
approval requirements, simulations and gas estimates. `prepare()` refuses an
unready quote and returns send input pinned to its token, selected policy,
maximum debit and expiry. Send that input promptly. A quote reserves no balance,
daily budget, allowance or gas price. Wallet execution cannot be simulated until
its schedule and approval exist; `conservative_hint` gas entries are planning
hints rather than measured fees or upper bounds. Fee-currency conversion costs
are not quoted. Inspect the returned notes.

`validUntil` controls when the SDK may start or resume a payment. Wallet mandates
are capped by it on-chain. Policy transactions do not carry this deadline in the
contract call: the SDK refuses late broadcast, but cannot invalidate bytes
already broadcast. Preserve the same key and journal when investigating a
pending or uncertain send. A fresh quote does not authorize a second payment.

## Sign an invoice and verify settlement

The recipient signs an exact payer, recipient, token, amount, order ID, nonce and
validity window. `create()` also creates an exact one-off backend request; `sign()`
signs an existing request or a standalone invoice.

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

For policy funding, the invoice names the **policy owner's** wallet as payer;
the agent calls `invoices.pay(invoice, { funding: "policy", policyId })`.
Invoice IDs derive from signed terms, and the shared invoice store atomically
pins each invoice to a signer, funding route and payment key. Keep that
reservation after an uncertain send. Default invoice storage is process memory.

The seller verifies the final payment before fulfillment:

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

Supply `policyId` instead of `scheduleId` for a policy payment. Verification
checks exact funds ownership, recipient, token, amount, canonical receipt,
invoice validity at inclusion and any bound backend request. It can verify an
invoice after its expiry when the actual payment was included in time.
Finalized verification fails closed if the RPC cannot provide finality evidence.

Commit fulfillment and deduplication together. The Postgres inbox rejects
conflicting event, invoice and issuer/order identities:

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
  // Insert an application outbox row for email, shipping or HTTP work here.
});
```

Use `tx` for every business database write. An exception rolls back both the
claim and business changes. External effects cannot roll back with PostgreSQL;
queue them in an outbox in the same transaction. The inbox coordinates delivery;
the preceding invoice/payment verification supplies the evidence.

## Observe and recover saved payments

```ts
const operation = await agent.remittances.get("order-123", { funding: "wallet" });
console.log(operation.status, operation.stage, operation.error);

const pending = await agent.remittances.listPending();
await agent.remittances.reconcile("order-123", { funding: "wallet", waitMs: 30_000 });
const recovered = await agent.remittances.recoverPending({ limit: 25, waitMs: 5_000 });
console.log(pending.length, recovered.length);
```

`get()` and `listPending()` read saved intent and current chain evidence without
signing or changing journals. States include preparation, approval, signed,
broadcast, included, finalized, failed, cancelled, paused, expired and
`needs_reconciliation`. A consumed nonce without its original receipt requires
investigation; it never becomes a new payment. An executor's matching payment
can be discovered even if the sender crashed before saving its hash.

`reconcile()` resumes only an existing key with its original funding terms and
deadline. `recoverPending()` makes one sequential pass, with a default limit of
25; it does not schedule future work or run arbitrary jobs. Its signal stops
between payments. Use your application's worker scheduler for repeated passes.
If a key exists in both journals, specify `funding`.

```ts
const settled = await agent.remittances.wait("order-123", {
  funding: "wallet",
  finality: "finalized",
  timeoutMs: 30 * 60_000,
  signal: AbortSignal.timeout(30 * 60_000),
});
console.log(settled.proof?.eventId);
```

`wait()` observes; it does not send. It honors abort and timeout during reads,
and refuses failed, cancelled, paused or expired operations.

For application jobs, `storage.jobs` supplies immutable-key enqueue, claims with
`SKIP LOCKED`, renewable leases and fenced `ack`/`nack`. Jobs are delivered at
least once: reuse the job's stable key as the payment key. A new claim token
prevents a restarted worker's old acknowledgement from completing newer work.

## Adapt a managed signer and agent framework

Managed-signing integrations provide callbacks that **sign without broadcasting**:

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
const agent = createRemesso({ account }); // Add the shared stores above in production.
```

The callback contract supplies exact Celo transaction fields, serialization and
hash. The adapter checks returned bytes, fields and recovered signer, including
CIP-64 fee currency. Typed-data signatures are checked too. These are tested
callback adapters; no named custody provider integration is certified here.
The SDK retains simulation, journaling, nonce coordination and broadcast.

Framework tools expose JSON schemas and structured results without wallet
objects. Writes are denied by default:

```ts
import { createAgentTools } from "remesso-sdk/tools";

const tools = createAgentTools(agent);
console.log(tools.list());
const result = await tools.call("remesso_quote", {
  funding: "wallet", to: receiver.address, amount: "1", token: "USDT",
});
console.log(result);
```

Authorize writes from the host's trusted order ledger, with exact approved
terms. Model text and tool descriptions do not grant spending authority. The
`authorizeWrite({ name, input })` callback permits specific operations;
`enableWrites: true` is reserved for hosts already enforcing that authorization.
Success reports possible write effects. An uncertain write error reports unknown
effects: inspect/reconcile its original key rather than constructing a new one.
Big integers become decimal strings, dates become ISO strings and sensitive
wallet/signed-byte fields are removed from tool results.

The repository's MCP stdio server uses these SDK tools and journals. Build it
before starting it; the generic write tools remain disabled unless the host
explicitly sets `REMESSO_ENABLE_AGENT_TOOLS_WRITES=1`:

```bash
npm --prefix mcp install
npm --prefix mcp run build
npm --prefix mcp start
```

Keep the MCP server's wallet and storage configuration on the trusted host. The
existing policy wallet tools still enforce their contract spending envelope.
