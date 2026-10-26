/** Opt-in integration tests against an otherwise idle local Postgres.
 * REMESSO_POSTGRES_TEST=1 deno test --config packages/remesso-sdk/deno.json \
 *   --unstable-sloppy-imports --allow-env --allow-run --allow-net=127.0.0.1 \
 *   packages/remesso-sdk/test/postgres.test.ts
 * Creates SDK-owned tables, deletes only this test's random namespace.
 */
import { assertEquals, assertRejects, assert } from "@std/assert";
import postgres from "npm:postgres@3.4.5";
import { keccak256 } from "viem";
import { createPostgresStorage, type PostgresClient } from "../src/postgres.ts";
import type { PaymentRecord } from "../src/store.ts";
import type { RemittanceRecord } from "../src/remittance-store.ts";
import { RemessoError } from "../src/errors.ts";

const enabled = Deno.env.get("REMESSO_POSTGRES_TEST") === "1";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const payer = "0x0000000000000000000000000000000000000001" as const;
const recipient = "0x0000000000000000000000000000000000000002" as const;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const policyScope = `42220:allowance:${payer}`;
const walletScope = `42220:executor:${payer}`;
const signerScope = `42220:${payer}`;
const payment = (change: Partial<PaymentRecord> = {}): PaymentRecord => ({ key: "invoice-1", deployment: policyScope,
  owner: payer, policyId: "1", to: recipient, token: recipient, units: "100", memo: hash(0), hash: hash(1), nonce: 7,
  raw: "0x1234", at: new Date().toISOString(), status: "sent", ...change });
const remittance = (change: Partial<RemittanceRecord> = {}): RemittanceRecord => ({ key: "invoice-2", scope: walletScope,
  payer, to: recipient, token: recipient, amount: "100", amountIn: "101", fee: "1", feeBps: 50,
  firstRunAt: 1800000000, expiresAt: 1800080000, approvalAmount: "101", createdAt: new Date().toISOString(), ...change });

if (Deno.args[0] === "--storage-worker") {
  const sql = postgres("postgresql://postgres:postgres@127.0.0.1:54322/postgres", { max: 1, onnotice() {} });
  const storage = createPostgresStorage(sql, { namespace: Deno.args[1], heartbeatMs: 20 });
  try {
    const result = await storage.coordinator.runExclusive(signerScope, async (lease) => {
      const old = await storage.paymentStore.byKey("same-process-key", policyScope);
      if (old) return { signed: false, hash: old.hash, nonce: old.nonce };
      await pause(150);
      await lease.assertActive();
      const n = await storage.coordinator.nextNonce(signerScope, 7);
      const p = payment({ key: "same-process-key", nonce: n });
      await storage.paymentStore.save(p);
      await storage.coordinator.noteNonce(signerScope, n);
      await lease.assertActive();
      return { signed: true, hash: p.hash, nonce: n };
    });
    console.log(JSON.stringify(result));
  } finally { await sql.end({ timeout: 1 }); }
  Deno.exit(0);
}

async function fixture(fn: (a: ReturnType<typeof createPostgresStorage>, b: ReturnType<typeof createPostgresStorage>, sql: ReturnType<typeof postgres>) => Promise<void>) {
  const namespace = `sdk-test-${crypto.randomUUID()}`;
  // No env-supplied remote URL: this test can only reach the local dev database.
  const sql = postgres("postgresql://postgres:postgres@127.0.0.1:54322/postgres", { max: 6, onnotice() {} });
  const other = postgres("postgresql://postgres:postgres@127.0.0.1:54322/postgres", { max: 4, onnotice() {} });
  // Compile-time compatibility with the real driver's public interface.
  const client: PostgresClient = sql;
  const a = createPostgresStorage(client, { namespace, heartbeatMs: 20 });
  const b = createPostgresStorage(other, { namespace, heartbeatMs: 20 });
  try {
    await a.initialize();
    await fn(a, b, sql);
  } finally {
    for (const table of ["payments", "remittances", "nonces", "transactions", "jobs", "invoices", "fulfillments", "inbox_events"]) {
      await sql.unsafe(`delete from remesso_sdk_${table} where namespace = $1`, [namespace]).catch(() => {});
    }
    await Promise.all([sql.end({ timeout: 1 }), other.end({ timeout: 1 })]);
  }
}

Deno.test({ name: "Postgres journals survive independent clients and reject mutated keys or signed bytes", ignore: !enabled, fn: async () => {
  await fixture(async (a, b) => {
    const p = payment();
    await a.paymentStore.save(p);
    assertEquals(await b.paymentStore.byKey(p.key!, policyScope), p);
    await b.paymentStore.save({ ...p, status: "confirmed" });
    assertEquals((await a.paymentStore.byKey(p.key!, policyScope))?.status, "confirmed");
    for (const change of [{ to: payer }, { units: "200" }, { raw: "0x5678" as const }, { nonce: 8 }, { owner: recipient }, { validUntil: 1_800_000_000 }]) {
      await assertRejects(() => b.paymentStore.save({ ...p, ...change }), RemessoError);
    }
    const r = remittance();
    await a.remittanceStore.save(r);
    const signed = { ...r, creation: { raw: "0x1234" as const, hash: hash(2), nonce: 8 } };
    await b.remittanceStore.save(signed);
    await assertRejects(() => a.remittanceStore.save(r), RemessoError);
    await assertRejects(() => a.remittanceStore.save({ ...signed, creation: { ...signed.creation, nonce: 9 } }), RemessoError);
    await assertRejects(() => a.remittanceStore.save({ ...signed, validUntil: 1_800_000_000 }), RemessoError);
    assertEquals(await a.remittanceStore.get(r.key, walletScope), signed);
    assertEquals((await b.paymentStore.since(0)).length, 1);
  });
}});

Deno.test({ name: "Postgres signer session lock covers delayed signing and atomic same-key reuse across workers", ignore: !enabled, fn: async () => {
  await fixture(async (a, b) => {
    let signatures = 0;
    const order: string[] = [];
    const p = payment();
    async function send(storage: typeof a, worker: string) {
      return await storage.coordinator.runExclusive(signerScope, async (lease) => {
        order.push(`${worker}:entered`);
        const saved = await storage.paymentStore.byKey(p.key!, policyScope);
        if (saved) return saved.hash;
        await pause(80); // A slow managed signer must not outlive a lock lease.
        await lease.assertActive();
        signatures++;
        const next = await storage.coordinator.nextNonce(signerScope, 7);
        assertEquals(next, 7);
        await storage.paymentStore.save(p);
        await storage.coordinator.noteNonce(signerScope, next);
        order.push(`${worker}:durable`);
        await lease.assertActive();
        return p.hash;
      });
    }
    assertEquals(await Promise.all([send(a, "a"), send(b, "b")]), [p.hash, p.hash]);
    assertEquals(signatures, 1);
    assertEquals(order.length, 3);
    assertEquals(order[1], `${order[0].split(":")[0]}:durable`);
    await b.coordinator.runExclusive(signerScope, async () => {
      assertEquals(await b.coordinator.nextNonce(signerScope, 0), 8);
      // Reading the floor never consumes an unsigned nonce.
      assertEquals(await b.coordinator.nextNonce(signerScope, 0), 8);
      await b.coordinator.noteNonce(signerScope, 2);
      assertEquals(await b.coordinator.nextNonce(signerScope, 0), 8);
    });
    await assertRejects(() => a.coordinator.nextNonce(signerScope, 0), RemessoError);
  });
}});

Deno.test({ name: "Postgres connection loss fences a delayed signer and refuses a later journal save", ignore: !enabled, fn: async () => {
  await fixture(async (a, b, sql) => {
    let reached = false;
    await assertRejects(() => a.coordinator.runExclusive(signerScope, async (lease) => {
      const rows = await sql.unsafe("select pid from pg_locks where locktype = 'advisory' and granted and pid <> pg_backend_pid() and classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid and objid = (hashtextextended($1, 0) & 4294967295)::oid", [`remesso-sdk:${JSON.stringify([a.namespace, signerScope])}`]);
      assertEquals(rows.length, 1);
      await sql.unsafe("select pg_terminate_backend($1)", [rows[0].pid]);
      await pause(50);
      await assertRejects(() => lease.assertActive(), RemessoError);
      assertEquals(lease.signal.aborted, true);
      await assertRejects(() => a.paymentStore.save(payment()), RemessoError);
      reached = true;
    }), RemessoError);
    assert(reached);
    await b.coordinator.runExclusive(signerScope, async (lease) => { await lease.assertActive(); });
    assertEquals(await b.paymentStore.byKey("invoice-1", policyScope), undefined);
  });
}});

Deno.test({ name: "Postgres generic signed writes atomically retain immutable nonce evidence and recover its floor", ignore: !enabled, fn: async () => {
  await fixture(async (a, b, sql) => {
    const transaction = { nonce: 7, raw: "0x1234" as const, hash: keccak256("0x1234") };
    await a.coordinator.runExclusive(signerScope, async () => {
      await a.coordinator.recordSigned(signerScope, transaction);
      await a.coordinator.recordSigned(signerScope, transaction);
      assertEquals(await a.coordinator.nextNonce(signerScope, 0), 8);
      await assertRejects(() => a.coordinator.recordSigned(signerScope, { nonce: 7, raw: "0x5678", hash: keccak256("0x5678") }), RemessoError);
      await assertRejects(() => a.coordinator.recordSigned(signerScope, { nonce: 9, raw: "0x5678", hash: transaction.hash }), RemessoError);
      assertEquals(await a.coordinator.nextNonce(signerScope, 0), 8);
    });
    await b.coordinator.runExclusive(signerScope, async () => { assertEquals(await b.coordinator.nextNonce(signerScope, 0), 8); });
    const rows = await sql.unsafe("select nonce,hash,raw from remesso_sdk_transactions where namespace = $1 and scope = $2", [a.namespace, signerScope]);
    assertEquals(rows.map((r) => ({ nonce: Number(r.nonce), hash: r.hash, raw: r.raw })), [transaction]);
    await assertRejects(() => a.coordinator.recordSigned(signerScope, transaction), RemessoError);
  });
}});

Deno.test({ name: "Postgres distinct OS processes share the same durable key and nonce lock", ignore: !enabled, fn: async () => {
  await fixture(async (a) => {
    const config = new URL("../deno.json", import.meta.url).pathname;
    const script = new URL(import.meta.url).pathname;
    const run = async () => {
      const output = await new Deno.Command(Deno.execPath(), { args: ["run", "--config", config, "--unstable-sloppy-imports", "--allow-env", "--allow-net=127.0.0.1", script, "--storage-worker", a.namespace], stdout: "piped", stderr: "piped" }).output();
      assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
      return JSON.parse(new TextDecoder().decode(output.stdout)) as { signed: boolean; hash: string; nonce: number };
    };
    const results = await Promise.all([run(), run()]);
    assertEquals(results.filter((r) => r.signed).length, 1);
    assertEquals(results.map((r) => r.hash), [hash(1), hash(1)]);
    assertEquals(results.map((r) => r.nonce), [7, 7]);
  });
}});

Deno.test({ name: "Postgres jobs claim once, reclaim expired leases and fence stale acknowledgements", ignore: !enabled, fn: async () => {
  await fixture(async (a, b) => {
    const queued = await a.jobs.enqueue({ key: "settle:order-1", kind: "settle", payload: { orderId: "1" } });
    assertEquals((await b.jobs.enqueue({ key: queued.key, kind: "settle", payload: { orderId: "1" } })).id, queued.id);
    await assertRejects(() => a.jobs.enqueue({ key: queued.key, kind: "settle", payload: { orderId: "2" } }), RemessoError);
    const claims = await Promise.all([a.jobs.claim({ worker: "a", leaseMs: 100 }), b.jobs.claim({ worker: "b", leaseMs: 100 })]);
    assertEquals(claims.filter(Boolean).length, 1);
    const old = claims.find(Boolean)!;
    await pause(120);
    assertEquals(await a.jobs.ack(old.id, old.claimToken), false);
    const current = await b.jobs.claim({ worker: "restart", leaseMs: 1000 });
    assert(current);
    assertEquals(current.id, queued.id);
    assertEquals(current.attempts, 2);
    assert(current.claimToken !== old.claimToken);
    assertEquals(await a.jobs.nack(old.id, old.claimToken), false);
    assertEquals(await a.jobs.extend(old.id, old.claimToken), false);
    assertEquals(await b.jobs.extend(current.id, current.claimToken, 1000), true);
    assertEquals(await b.jobs.nack(current.id, current.claimToken, { error: "try again" }), true);
    const retry = await a.jobs.claim({ worker: "third", leaseMs: 1000, kinds: ["settle"] });
    assert(retry);
    assertEquals(await a.jobs.ack(retry.id, retry.claimToken), true);
    assertEquals((await b.jobs.get(queued.key))?.status, "completed");
    assertEquals(await b.jobs.claim({ worker: "done" }), undefined);
  });
}});

Deno.test({ name: "Postgres invoices cannot replay through another payment route or key", ignore: !enabled, fn: async () => {
  await fixture(async (a, b) => {
    const route = { funding: "wallet" as const, signer: payer, payer, key: "signed-invoice-1" };
    await a.invoiceStore.reserve(hash(12), route);
    await b.invoiceStore.reserve(hash(12), route);
    for (const change of [{ funding: "policy" as const }, { signer: recipient }, { key: "new-key" }, { policyId: "1" }]) {
      const error = await assertRejects(() => b.invoiceStore.reserve(hash(12), { ...route, ...change }), RemessoError);
      assertEquals(error.code, "key_reused");
    }
  });
}});

Deno.test({ name: "Postgres fulfillment is transactional and dedupes event, invoice and issuer/order", ignore: !enabled, fn: async () => {
  await fixture(async (a, b, sql) => {
    const identity = { eventId: "event-1", invoiceId: hash(12), issuer: payer, orderId: "order-1" };
    // Use the SDK's queue as an outbox; it must roll back with failed business work.
    await assertRejects(() => a.inbox.processOnce(identity, async (tx) => {
      await tx.unsafe("insert into remesso_sdk_jobs(namespace,id,job_key,kind,payload) values ($1,$2,$3,'deliver','{}'::jsonb)", [a.namespace, crypto.randomUUID(), "delivery"]);
      throw new Error("business update failed");
    }));
    assertEquals((await sql.unsafe("select * from remesso_sdk_jobs where namespace = $1", [a.namespace])).length, 0);
    let fulfilled = 0;
    const work = async (storage: typeof a) => await storage.inbox.processOnce(identity, async (tx) => {
      await pause(50);
      await tx.unsafe("insert into remesso_sdk_jobs(namespace,id,job_key,kind,payload) values ($1,$2,$3,'deliver','{}'::jsonb)", [a.namespace, crypto.randomUUID(), "delivery"]);
      fulfilled++;
    });
    assertEquals((await Promise.all([work(a), work(b)])).sort(), [false, true]);
    assertEquals(fulfilled, 1);
    assertEquals(await b.inbox.processOnce({ ...identity, eventId: "event-2" }, async () => { throw new Error("duplicate"); }), false);
    // Even an alias event that did not fulfill again is permanently bound.
    await assertRejects(() => a.inbox.processOnce({ eventId: "event-2", invoiceId: hash(13), issuer: payer, orderId: "order-2" }, async () => {}), RemessoError);
    for (const change of [{ orderId: "other-order" }, { invoiceId: hash(13) }, { issuer: recipient }]) {
      await assertRejects(() => a.inbox.processOnce({ ...identity, ...change }, async () => {}), RemessoError);
    }
  });
}});

Deno.test({ name: "Postgres errors keep their query parameters out of logs once storage is installed", ignore: !enabled, fn: async () => {
  await fixture(async (a, _b, sql) => {
    // Before: the session hook left postgres.js in debug mode, which makes every
    // error's parameters enumerable, so a logger serialising one wrote them out.
    const error = await sql.unsafe("select $1::int", ["not a number signed-bytes"]).then(() => null, (e: unknown) => e as Record<string, unknown>);
    assert(error);
    assertEquals(Object.keys(error).includes("parameters"), false);
    assertEquals(JSON.stringify(error).includes("signed-bytes"), false);
    // The lock still finds its own session.
    assertEquals(await a.coordinator.runExclusive(signerScope, async (lease) => { await lease.assertActive(); return "held"; }), "held");
  });
}});

Deno.test({ name: "Postgres lists unsent generic writes and keeps one cancellation per nonce", ignore: !enabled, fn: async () => {
  await fixture(async (a) => {
    const write = { nonce: 11, hash: keccak256("0xabcd"), raw: "0xabcd" as const };
    const cancel = { hash: keccak256("0xef01"), raw: "0xef01" as const };
    await a.coordinator.runExclusive(signerScope, async () => {
      await a.coordinator.recordSigned(signerScope, write);
      const [open] = await a.coordinator.openSigned(signerScope, 11);
      assertEquals([open.nonce, open.hash, open.cancel], [11, write.hash, undefined]);
      assertEquals(await a.coordinator.openSigned(signerScope, 12), []);
      await a.coordinator.recordCancel(signerScope, 11, cancel);
      await a.coordinator.recordCancel(signerScope, 11, cancel); // the same cancellation again is fine
      assertEquals((await a.coordinator.openSigned(signerScope, 0))[0].cancel, cancel);
      await assertRejects(() => a.coordinator.recordCancel(signerScope, 11, { hash: keccak256("0x99"), raw: "0x99" }), RemessoError);
      await assertRejects(() => a.coordinator.recordCancel(signerScope, 12, cancel), RemessoError);
    });
  });
}});
