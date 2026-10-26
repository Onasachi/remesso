# Multiple agent workers

Install `postgres@3.4.5` alongside the SDK. The optional `remesso-sdk/postgres`
entry point has no bundled driver and stays out of browser imports.

```ts
import postgres from "postgres";
import { createRemesso } from "remesso-sdk";
import { createPostgresStorage } from "remesso-sdk/postgres";

const sql = postgres(process.env.DATABASE_URL!, {
  max: 8,
  connection: { synchronous_commit: "on" },
});
const storage = createPostgresStorage(sql, { namespace: "my-agent-service" });
// Run initialization once before starting workers.
await storage.initialize();
const remesso = createRemesso({
  account, // Your local or supported managed signer.
  store: storage.paymentStore,
  remittanceStore: storage.remittanceStore,
  invoiceStore: storage.invoiceStore,
  coordinator: storage.coordinator,
});
```

Every process using a signing address must use the same database, namespace,
journals and coordinator. The signer lock spans both wallet and policy funding.
Use a direct PostgreSQL connection or a session-pooling proxy. Transaction
pooling cannot preserve session advisory locks. A worker holds one reserved
connection throughout signing and receipt waits, so size the pool for active
signers and ordinary queries.

The adapter stores immutable payment terms and signed transaction bytes before
broadcast. It retains keys and signed steps indefinitely. A retry can update
confirmation state but cannot replace transaction bytes or change an invoice's
funding route. Reading the shared nonce floor does not reserve an unsigned nonce.
The SDK raises it after durable recording; worker restarts also scan both
journals, preventing nonce reuse if the floor update failed after a save.

For other contract writes, `coordinator.recordSigned(scope, { nonce, hash, raw })`
atomically records immutable signed bytes and raises the nonce floor while the
signer lock is held. The SDK uses this evidence before broadcasting coordinated
policy and schedule writes. This preserves nonce safety across a crash or a
database disconnect after broadcast. It does not add application idempotency to
generic actions: retrying a policy creation as a new action can create another
policy, so retain its original transaction hash and reconcile that action.

An advisory lock lasts for the database session, rather than an expiring lease.
The coordinator checks session identity and lock ownership, watches the driver's
connection-close notification, and aborts its lease on failure. The SDK checks
that lease before signing and broadcasting. A signature produced after loss of
the session is discarded. All processes that can broadcast with the same key
must follow this protocol; PostgreSQL cannot fence an unrelated blockchain
writer. Preserve the driver's installed `options.onclose` and `options.debug`
hooks after creating storage.

`initialize()` creates only `remesso_sdk_*` tables and indexes. It requires
PostgreSQL durability settings (`fsync` and `synchronous_commit`) to be enabled,
enables row level security with no public policies, and removes PUBLIC grants.
Use a trusted server database role owning those tables, or deliberately grant a
server role suitable policies. Never expose journals through a public REST API.
Raw signed bytes can be broadcast by anyone who can read them. Back up these
tables with the rest of the application's payment state.

## Durable worker jobs

```ts
await storage.jobs.enqueue({
  key: "settle:order-123",
  kind: "remit",
  payload: { to: recipient, amount: "1", token: "USDT" },
});

const job = await storage.jobs.claim<{
  to: string; amount: string; token: string;
}>({ worker: "worker-1", kinds: ["remit"], leaseMs: 180_000 });
if (job) {
  try {
    const result = await remesso.remittances.send({
      funding: "wallet",
      ...job.payload,
      idempotencyKey: job.key,
    });
    if (result.status === "confirmed") {
      await storage.jobs.ack(job.id, job.claimToken);
    } else {
      await storage.jobs.nack(job.id, job.claimToken, {
        runAt: new Date(Date.now() + 5_000),
      });
    }
  } catch (error) {
    await storage.jobs.nack(job.id, job.claimToken, { error: String(error) });
  }
}
```

Jobs are delivered at least once. Reuse `job.key` as the payment key on every
attempt. Claims use `FOR UPDATE SKIP LOCKED`; another worker can reclaim an
expired job with a fresh claim token. `ack`, `nack` and `extend` return false for
expired or superseded claims. Extend a live claim when work takes longer than
its lease. Losing a job lease does not release an independently held signer lock.
Use the database clock for immediate jobs and UTC dates for future jobs.

## Atomic invoice fulfillment

Verify the signed invoice and final on-chain payment using the SDK before
entering the transaction. Bind the verified receipt to its intended invoice;
the inbox only coordinates fulfillment and does not verify a payment.

```ts
const verifiedInvoice = await remesso.invoices.verify(signedInvoice, { allowExpired: true });
const verified = await remesso.invoices.verifyPayment(signedInvoice, {
  txHash: paymentHash,
  scheduleId,
  finality: "finalized",
});
const fulfilled = await storage.inbox.processOnce({
  eventId: verified.payment.eventId,
  invoiceId: verified.invoiceId,
  issuer: verifiedInvoice.issuer,
  orderId: verifiedInvoice.orderId,
}, async (tx) => {
  await tx.unsafe(
    "update orders set paid_at = clock_timestamp() where issuer = $1 and id = $2",
    [verifiedInvoice.issuer.toLowerCase(), verifiedInvoice.orderId],
  );
  // Insert an application outbox row here for shipping, email or HTTP work.
});
```

The event, invoice and issuer/order identities are deduplicated independently.
The claim and business writes commit together. A duplicate returns false without
calling the callback. Conflicting identities throw. If the callback fails, the
claim and its writes roll back, allowing a later attempt. Perform all business
database writes through `tx`. HTTP, email and on-chain side effects cannot roll
back with PostgreSQL; queue those in an outbox in the same transaction.
