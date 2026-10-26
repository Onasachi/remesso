/** Durable journals and worker coordination. Import through `remesso-sdk/postgres`.
 * Pass a postgres.js client using direct connections or session pooling. Advisory
 * locks cannot survive a transaction-pooling proxy. No driver is bundled here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { RemessoError } from "./errors.js";
import type { PaymentRecord, PaymentStore } from "./store.js";
import type { RemittanceRecord, RemittanceStore } from "./remittance-store.js";
import type { InvoiceStore } from "./invoices.js";

type Row = Record<string, unknown>;
/** Structural subset of postgres.js 3.4.5. Values are always SQL parameters. */
export interface PostgresConnection {
  // `any` keeps postgres.js custom parameter types structurally compatible.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unsafe(query: string, parameters?: any[]): PromiseLike<readonly Row[]>;
}
export interface PostgresReservedConnection extends PostgresConnection {
  release(): void | Promise<void>;
}
export interface PostgresClient extends PostgresConnection {
  reserve(): Promise<PostgresReservedConnection>;
  options: {
    onclose?: (connectionId: number) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debug?: boolean | ((...args: any[]) => void);
  };
}

export interface SignerLease {
  /** Aborted on a detected database/session failure. Never ignore this signal. */
  readonly signal: AbortSignal;
  /** Check immediately before signing, durable journal writes and broadcasting. */
  assertActive(): Promise<void>;
}
export interface SignerCoordinator {
  /** Hold a PostgreSQL session lock for the entire callback, including signing. */
  runExclusive<T>(scope: string, fn: (lease: SignerLease) => Promise<T>): Promise<T>;
  /** Read a persisted nonce floor without reserving an unsigned nonce. */
  nextNonce(scope: string, minimum: number): Promise<number>;
  /** Persist used + 1, after the signed bytes are durably recorded. */
  noteNonce(scope: string, used: number): Promise<void>;
  /** Generic contract writes also record nonce evidence before broadcasting. */
  recordSigned(scope: string, transaction: { nonce: number; hash: Hex; raw: Hex }): Promise<void>;
  /** Saved generic writes at or above a nonce, with any cancellation saved for them. */
  openSigned(scope: string, fromNonce: number): Promise<Array<{ nonce: number; hash: Hex; raw: Hex; savedAt: number; cancel?: { hash: Hex; raw: Hex } }>>;
  /** Save the no-op that cancels an unsent generic write, before it is broadcast. */
  recordCancel(scope: string, nonce: number, cancel: { hash: Hex; raw: Hex }): Promise<void>;
}

export type DurableJob<T = unknown> = {
  id: string;
  key: string;
  kind: string;
  payload: T;
  status: "pending" | "running" | "completed";
  attempts: number;
  runAt: string;
  createdAt: string;
  claimToken?: string;
  leaseUntil?: string;
  worker?: string;
  lastError?: string;
};
export type ClaimedJob<T = unknown> = DurableJob<T> & { status: "running"; claimToken: string; leaseUntil: string; worker: string };
export interface DurableJobs {
  /** A key permanently identifies one kind/payload. Re-enqueue returns it. */
  enqueue<T>(input: { key: string; kind: string; payload: T; runAt?: Date }): Promise<DurableJob<T>>;
  claim<T = unknown>(input: { worker: string; leaseMs?: number; kinds?: string[] }): Promise<ClaimedJob<T> | undefined>;
  /** Returns false if this claim expired or a newer worker reclaimed the job. */
  ack(id: string, claimToken: string): Promise<boolean>;
  nack(id: string, claimToken: string, input?: { error?: string; runAt?: Date }): Promise<boolean>;
  /** Renew only a still-current unexpired claim. */
  extend(id: string, claimToken: string, leaseMs?: number): Promise<boolean>;
  get<T = unknown>(key: string): Promise<DurableJob<T> | undefined>;
}

export type FulfillmentIdentity = { eventId: string; invoiceId: string; issuer: string; orderId: string };
export interface TransactionalInbox {
  /** Atomically claim an event, invoice and issuer/order, perform DB-local
   * fulfillment and commit. Return false when the same identity was committed.
   * Throw for conflicting identities. Use tx only; HTTP/on-chain effects need
   * an outbox job in this same transaction, never an external side effect here.
   */
  processOnce(identity: FulfillmentIdentity, fulfill: (tx: PostgresConnection) => Promise<void>): Promise<boolean>;
}

type Active = { scope: string; connection: PostgresReservedConnection; lease: SignerLease; failed?: unknown };
type SessionHooks = { pending: Map<string, (id: number) => void>; closed: Map<number, Set<() => void>> };
const sessionHooks = new WeakMap<PostgresClient, SessionHooks>();
function hooks(sql: PostgresClient): SessionHooks {
  const previous = sessionHooks.get(sql);
  if (previous) return previous;
  if (!sql.options || typeof sql.options !== "object") throw new RemessoError("invalid", "the Postgres adapter requires a postgres.js client with public connection options");
  const result: SessionHooks = { pending: new Map(), closed: new Map() };
  const onclose = sql.options.onclose;
  let debug = sql.options.debug;
  sql.options.onclose = (id) => {
    // Called synchronously by postgres.js after a session socket closes. A
    // reserved connection must never be reused after this notification.
    for (const fn of result.closed.get(id) ?? []) fn();
    onclose?.(id);
  };
  // The marker query tells which session a lock is on. postgres.js makes every
  // error's query and parameters enumerable while `debug` is set, which would
  // put signed bytes in any log that serializes an error. So the hook is
  // exposed only while a marker query is being sent, and removed as soon as
  // that query is seen; the rest of the time `debug` is whatever it was.
  const capture = (id: number, query: string, ...args: unknown[]) => {
    for (const [marker, found] of result.pending) {
      if (query.includes(marker)) {
        result.pending.delete(marker);
        found(id);
      }
    }
    if (typeof debug === "function") debug(id, query, ...args);
  };
  Object.defineProperty(sql.options, "debug", {
    configurable: true,
    enumerable: true,
    get: () => result.pending.size ? capture : debug,
    set: (value) => { debug = value; },
  });
  sessionHooks.set(sql, result);
  return result;
}
const fail = (message: string) => new RemessoError("conflict", message);
function text(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || value.includes("\0")) throw new RemessoError("invalid", `${name} must be a nonempty string of at most 2048 characters`);
  return value;
}
function nonce(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RemessoError("invalid", "nonce must be a nonnegative safe integer");
  return value;
}
function json(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized == null) throw new RemessoError("invalid", "the value must be JSON serializable");
  // postgres.js infers the parameter's jsonb type from the cast and serializes
  // it itself. Passing serialized text would store a JSON string, not an object.
  return JSON.parse(serialized);
}
const lower = (value: string) => value.toLowerCase();
function paymentTerms(r: PaymentRecord) {
  return { policyId: r.policyId, to: lower(r.to), units: r.units, token: lower(r.token), memo: lower(r.memo), hash: lower(r.hash), nonce: r.nonce, raw: lower(r.raw), at: r.at, validUntil: r.validUntil ?? null };
}
function remittanceTerms(r: RemittanceRecord) {
  return { payer: lower(r.payer), to: lower(r.to), token: lower(r.token), amount: r.amount, amountIn: r.amountIn,
    fee: r.fee, feeBps: r.feeBps, firstRunAt: r.firstRunAt, expiresAt: r.expiresAt,
    createdAt: r.createdAt, requestId: r.requestId ?? null, validUntil: r.validUntil ?? null };
}
function job<T>(row: Row): DurableJob<T> {
  return { id: String(row.id), key: String(row.job_key), kind: String(row.kind), payload: row.payload as T,
    status: row.status as DurableJob["status"], attempts: Number(row.attempts),
    runAt: new Date(row.run_at as string).toISOString(), createdAt: new Date(row.created_at as string).toISOString(),
    ...(row.claim_token ? { claimToken: String(row.claim_token) } : {}),
    ...(row.lease_until ? { leaseUntil: new Date(row.lease_until as string).toISOString() } : {}),
    ...(row.worker ? { worker: String(row.worker) } : {}), ...(row.last_error ? { lastError: String(row.last_error) } : {}) };
}

/** One namespace must be shared by every worker using the same signing wallet.
 * Journals retain keys and signed bytes indefinitely. Restrict table access:
 * signed bytes can be broadcast by anyone who can read them.
 */
export function createPostgresStorage(sql: PostgresClient, options: { namespace?: string; jobLeaseMs?: number; heartbeatMs?: number } = {}) {
  const namespace = text(options.namespace ?? "default", "namespace");
  // Longer than a payment's default 45-second wait, so a job isn't reclaimed
  // by another worker while its payment is still being sent.
  const defaultLease = options.jobLeaseMs ?? 300_000;
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  const leaseMs = (n = defaultLease) => {
    if (!Number.isSafeInteger(n) || n < 10 || n > 3_600_000) throw new RemessoError("invalid", "job leaseMs must be from 10 to 3600000 milliseconds");
    return n;
  };
  leaseMs();
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 60_000) throw new RemessoError("invalid", "heartbeatMs must be from 10 to 60000 milliseconds");
  const active = new AsyncLocalStorage<Active>();
  const sessions = hooks(sql);
  const lockName = (scope: string) => `remesso-sdk:${JSON.stringify([namespace, text(scope, "signer scope")])}`;
  const connection = async (): Promise<PostgresConnection> => {
    const held = active.getStore();
    if (!held) return sql;
    await held.lease.assertActive();
    return held.connection;
  };
  const requireLock = async (scope: string): Promise<PostgresConnection> => {
    const held = active.getStore();
    if (!held || held.scope !== scope) throw fail("nonce coordination requires the same active runExclusive signer scope");
    await held.lease.assertActive();
    return held.connection;
  };

  const coordinator: SignerCoordinator = {
    async runExclusive(scope, fn) {
      const inherited = active.getStore();
      if (inherited) throw fail("nested signer locks are not supported; keep one runExclusive scope around the complete operation");
      const name = lockName(scope);
      const reserved = await sql.reserve();
      const controller = new AbortController();
      let held: Active | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let checking: Promise<void> | undefined;
      let acquired = false;
      let pid: number | undefined;
      let connectionId: number | undefined;
      let sessionClosed = false;
      const marker = `remesso_lock_${randomUUID()}`;
      const lost = (cause: unknown) => {
        const error = fail("the PostgreSQL signer lock or connection was lost; no new transaction may be signed or broadcast");
        if (held && !held.failed) held.failed = error;
        if (!controller.signal.aborted) controller.abort(cause ?? error);
        return error;
      };
      const closed = () => { sessionClosed = true; lost(fail("the PostgreSQL signer session closed")); };
      const lease: SignerLease = {
        signal: controller.signal,
        async assertActive() {
          if (held?.failed || controller.signal.aborted) throw held?.failed ?? lost(controller.signal.reason);
          try {
            // A reserved driver connection must not silently reconnect and resume
            // the callback without reacquiring the original advisory lock.
            const rows = await reserved.unsafe(`select pg_backend_pid() as pid, exists (
              select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
              and classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
              and objid = (hashtextextended($1, 0) & 4294967295)::oid and objsubid = 1 and granted
            ) as locked`, [name]);
            if (Number(rows[0]?.pid) !== pid || rows[0]?.locked !== true) throw lost(undefined);
          } catch (e) { throw lost(e); }
        },
      };
      try {
        sessions.pending.set(marker, (id) => {
          connectionId = id;
          const subscribers = sessions.closed.get(id) ?? new Set();
          subscribers.add(closed);
          sessions.closed.set(id, subscribers);
        });
        const rows = await reserved.unsafe(`select pg_advisory_lock(hashtextextended($1, 0)), pg_backend_pid() as pid /* ${marker} */`, [name]);
        sessions.pending.delete(marker);
        acquired = true;
        pid = Number(rows[0]?.pid);
        held = { scope, connection: reserved, lease };
        timer = setInterval(() => {
          if (!controller.signal.aborted && !checking) checking = lease.assertActive().catch(() => {}).finally(() => { checking = undefined; });
        }, heartbeatMs);
        timer.unref?.();
        return await active.run(held, async () => {
          await lease.assertActive();
          const result = await fn(lease);
          await lease.assertActive();
          return result;
        });
      } finally {
        sessions.pending.delete(marker);
        if (timer) clearInterval(timer);
        if (checking) await checking;
        // Keep the session reserved until fn settles: racing an early rejection
        // against fn would release a live lock while a delayed signer still runs.
        try {
          if (acquired && !sessionClosed) {
            try { await reserved.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [name]); }
            catch (e) { throw lost(e); }
          }
        } finally {
          if (connectionId != null) {
            sessions.closed.get(connectionId)?.delete(closed);
            if (!sessions.closed.get(connectionId)?.size) sessions.closed.delete(connectionId);
          }
          controller.abort(fail("the signer operation has ended"));
          // postgres.js has already unreserved a disconnected session. Calling
          // release() then would incorrectly put its dead socket in the pool.
          if (!sessionClosed) await reserved.release();
        }
      }
    },
    async nextNonce(scope, minimum) {
      const db = await requireLock(scope);
      const rows = await db.unsafe("select next_nonce from remesso_sdk_nonces where namespace = $1 and scope = $2", [namespace, scope]);
      const floor = rows.length ? Number(rows[0].next_nonce) : 0;
      return nonce(Math.max(nonce(minimum), floor));
    },
    async noteNonce(scope, used) {
      const db = await requireLock(scope);
      const next = nonce(nonce(used) + 1);
      await db.unsafe(`insert into remesso_sdk_nonces (namespace, scope, next_nonce) values ($1, $2, $3)
        on conflict (namespace, scope) do update set next_nonce = greatest(remesso_sdk_nonces.next_nonce, excluded.next_nonce)`, [namespace, scope, next]);
    },
    async recordSigned(scope, transaction) {
      const db = await requireLock(scope);
      const used = nonce(transaction.nonce);
      const next = nonce(used + 1);
      if (!/^0x[\da-f]{64}$/i.test(transaction.hash) || !/^0x(?:[\da-f]{2})+$/i.test(transaction.raw) || lower(keccak256(transaction.raw)) !== lower(transaction.hash)) {
        throw new RemessoError("invalid", "a signed transaction must include nonempty raw bytes and their matching keccak256 hash");
      }
      // One SQL statement commits the bytes and floor together. If an existing
      // nonce owns different bytes, saved is empty and the floor cannot advance.
      const rows = await db.unsafe(`with saved as (
        insert into remesso_sdk_transactions(namespace, scope, nonce, hash, raw) values ($1, $2, $3, $4, $5)
        on conflict (namespace, scope, nonce) do update set hash = excluded.hash
        where remesso_sdk_transactions.hash = excluded.hash and remesso_sdk_transactions.raw = excluded.raw returning nonce
      ), floor as (
        insert into remesso_sdk_nonces(namespace, scope, next_nonce) select $1, $2, $6 from saved
        on conflict (namespace, scope) do update set next_nonce = greatest(remesso_sdk_nonces.next_nonce, excluded.next_nonce) returning next_nonce
      ) select nonce from saved`, [namespace, scope, used, lower(transaction.hash), lower(transaction.raw), next]);
      if (!rows.length) throw new RemessoError("conflict", "this signer nonce already belongs to different durable transaction bytes");
    },
    async openSigned(scope, fromNonce) {
      const db = await requireLock(scope);
      const rows = await db.unsafe(`select nonce, hash, raw, cancel_hash, cancel_raw, created_at from remesso_sdk_transactions
        where namespace = $1 and scope = $2 and nonce >= $3 order by nonce`, [namespace, scope, nonce(fromNonce)]);
      return rows.map((row) => ({
        nonce: Number(row.nonce), hash: row.hash as Hex, raw: row.raw as Hex, savedAt: new Date(row.created_at as string).getTime(),
        ...(row.cancel_hash ? { cancel: { hash: row.cancel_hash as Hex, raw: row.cancel_raw as Hex } } : {}),
      }));
    },
    async recordCancel(scope, used, cancel) {
      const db = await requireLock(scope);
      if (!/^0x[\da-f]{64}$/i.test(cancel.hash) || !/^0x(?:[\da-f]{2})+$/i.test(cancel.raw) || lower(keccak256(cancel.raw)) !== lower(cancel.hash)) {
        throw new RemessoError("invalid", "a cancellation must include raw bytes and their matching keccak256 hash");
      }
      const rows = await db.unsafe(`update remesso_sdk_transactions set cancel_hash = $4, cancel_raw = $5
        where namespace = $1 and scope = $2 and nonce = $3 and (cancel_hash is null or (cancel_hash = $4 and cancel_raw = $5)) returning nonce`,
      [namespace, scope, nonce(used), lower(cancel.hash), lower(cancel.raw)]);
      if (!rows.length) throw new RemessoError("conflict", "this nonce has no saved write, or already has a different cancellation");
    },
  };

  const paymentStore: PaymentStore = {
    async byKey(key, deployment) {
      const db = await connection();
      const rows = await db.unsafe("select record from remesso_sdk_payments where namespace = $1 and scope = $2 and id = $3", [namespace, deployment, `key:${key}`]);
      return rows[0]?.record as PaymentRecord | undefined;
    },
    async since(since) {
      if (!Number.isFinite(since)) throw new RemessoError("invalid", "since must be a finite epoch timestamp");
      const db = await connection();
      const rows = await db.unsafe("select record from remesso_sdk_payments where namespace = $1 and recorded_at > $2 order by recorded_at, id", [namespace, new Date(since).toISOString()]);
      return rows.map((r) => r.record as PaymentRecord);
    },
    async save(record) {
      text(record.deployment, "deployment");
      nonce(record.nonce);
      if (record.key != null) text(record.key, "payment key");
      const terms = paymentTerms(record);
      const db = await connection();
      const rows = await db.unsafe(`insert into remesso_sdk_payments (namespace, scope, id, record, terms, recorded_at)
        values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
        on conflict (namespace, scope, id) do update set record = excluded.record
        where remesso_sdk_payments.terms = excluded.terms and
          (not (remesso_sdk_payments.record ? 'owner') or lower(remesso_sdk_payments.record->>'owner') = lower(excluded.record->>'owner')) and
          (not (remesso_sdk_payments.record ? 'cancel') or remesso_sdk_payments.record->'cancel' = excluded.record->'cancel')
        returning id`, [namespace, record.deployment, record.key == null ? `hash:${lower(record.hash)}` : `key:${record.key}`, json(record), json(terms), record.at]);
      if (!rows.length) throw new RemessoError("key_reused", "the durable payment key already has different immutable terms or signed bytes");
    },
  };
  const remittanceStore: RemittanceStore = {
    async get(key, scope) {
      const db = await connection();
      const rows = await db.unsafe("select record from remesso_sdk_remittances where namespace = $1 and scope = $2 and key = $3", [namespace, scope, key]);
      return rows[0]?.record as RemittanceRecord | undefined;
    },
    async list(scope) {
      const db = await connection();
      const rows = await db.unsafe("select record from remesso_sdk_remittances where namespace = $1 and scope = $2 order by created_at, key", [namespace, scope]);
      return rows.map((r) => r.record as RemittanceRecord);
    },
    async save(record) {
      text(record.scope, "scope");
      text(record.key, "remittance key");
      const terms = remittanceTerms(record);
      for (const step of [record.approval, record.creation, record.execution, record.cancellation]) if (step) nonce(step.nonce);
      const db = await connection();
      const rows = await db.unsafe(`insert into remesso_sdk_remittances (namespace, scope, key, record, terms, created_at)
        values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
        on conflict (namespace, scope, key) do update set record = excluded.record
        where remesso_sdk_remittances.terms = excluded.terms
        ${["approval", "approvalAmount", "approvalSkipped", "creation", "execution", "cancellation", "cancelReason", "scheduleId"].map((name) => `and (not (remesso_sdk_remittances.record ? '${name}') or remesso_sdk_remittances.record->'${name}' = excluded.record->'${name}')`).join("\n")}
        returning key`, [namespace, record.scope, record.key, json(record), json(terms), record.createdAt]);
      if (!rows.length) throw new RemessoError("key_reused", "the durable remittance key already has different terms or signed transaction steps");
    },
  };
  const invoiceStore: InvoiceStore = {
    async reserve(invoiceId, reservation) {
      text(invoiceId, "invoice ID"); text(reservation.key, "invoice payment key");
      const route = { ...reservation, signer: lower(reservation.signer), payer: lower(reservation.payer) };
      const db = await connection();
      const rows = await db.unsafe(`insert into remesso_sdk_invoices (namespace, invoice_id, reservation)
        values ($1, $2, $3::jsonb) on conflict (namespace, invoice_id) do update set reservation = excluded.reservation
        where remesso_sdk_invoices.reservation = excluded.reservation returning invoice_id`, [namespace, invoiceId, json(route)]);
      if (!rows.length) throw new RemessoError("key_reused", "this signed invoice is already reserved to another funding route, signer, payer, policy or payment key");
    },
  };
  const inbox: TransactionalInbox = {
    async processOnce(identity, fulfill) {
      text(identity.eventId, "event ID"); text(identity.invoiceId, "invoice ID");
      text(identity.issuer, "issuer"); text(identity.orderId, "order ID");
      const issuer = lower(identity.issuer);
      if (active.getStore()) throw fail("fulfillment transactions must run outside signer runExclusive callbacks");
      const tx = await sql.reserve();
      let closed = false;
      let connectionId: number | undefined;
      const marker = `remesso_inbox_${randomUUID()}`;
      const onClosed = () => { closed = true; };
      const safe: PostgresConnection = {
        unsafe(query, parameters) {
          if (closed) throw fail("the fulfillment transaction's database session was lost");
          return tx.unsafe(query, parameters);
        },
      };
      try {
        sessions.pending.set(marker, (id) => {
          connectionId = id;
          const subscribers = sessions.closed.get(id) ?? new Set();
          subscribers.add(onClosed);
          sessions.closed.set(id, subscribers);
        });
        await safe.unsafe(`begin /* ${marker} */`);
        sessions.pending.delete(marker);
        const event = await safe.unsafe(`insert into remesso_sdk_inbox_events (namespace, event_id, invoice_id, issuer, order_id)
          values ($1, $2, $3, $4, $5) on conflict (namespace, event_id) do update set event_id = excluded.event_id
          where remesso_sdk_inbox_events.invoice_id = excluded.invoice_id and remesso_sdk_inbox_events.issuer = excluded.issuer
          and remesso_sdk_inbox_events.order_id = excluded.order_id returning event_id`,
        [namespace, identity.eventId, identity.invoiceId, issuer, identity.orderId]);
        if (!event.length) throw fail("this event ID already identifies another invoice or order");
        const rows = await safe.unsafe(`insert into remesso_sdk_fulfillments (namespace, event_id, invoice_id, issuer, order_id)
          values ($1, $2, $3, $4, $5) on conflict do nothing returning event_id`,
        [namespace, identity.eventId, identity.invoiceId, issuer, identity.orderId]);
        if (!rows.length) {
          const previous = await safe.unsafe(`select event_id, invoice_id, issuer, order_id from remesso_sdk_fulfillments where namespace = $1
            and (event_id = $2 or invoice_id = $3 or (issuer = $4 and order_id = $5))`,
          [namespace, identity.eventId, identity.invoiceId, issuer, identity.orderId]);
          // Another event may describe the same invoice/order after webhook
          // retries or reconciliation. An event cannot identify another order.
          if (!previous.length || previous.some((row) => row.invoice_id !== identity.invoiceId || row.issuer !== issuer || row.order_id !== identity.orderId)) {
            throw fail("the event, invoice or issuer/order identity conflicts with an existing fulfillment");
          }
          await safe.unsafe("commit");
          return false;
        }
        await fulfill(safe);
        await safe.unsafe("commit");
        return true;
      } catch (e) {
        if (!closed) await Promise.resolve(tx.unsafe("rollback")).catch(() => {});
        throw e;
      } finally {
        sessions.pending.delete(marker);
        if (connectionId != null) {
          sessions.closed.get(connectionId)?.delete(onClosed);
          if (!sessions.closed.get(connectionId)?.size) sessions.closed.delete(connectionId);
        }
        if (!closed) await tx.release();
      }
    },
  };
  const jobs: DurableJobs = {
    async enqueue(input) {
      text(input.key, "job key"); text(input.kind, "job kind");
      const payload = json(input.payload);
      const rows = await sql.unsafe(`insert into remesso_sdk_jobs (namespace, id, job_key, kind, payload, run_at)
        values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, clock_timestamp()))
        on conflict (namespace, job_key) do update set job_key = excluded.job_key
        where remesso_sdk_jobs.kind = excluded.kind and remesso_sdk_jobs.payload = excluded.payload
        returning *`, [namespace, randomUUID(), input.key, input.kind, payload, input.runAt?.toISOString() ?? null]);
      if (!rows.length) throw new RemessoError("key_reused", "the job key already belongs to a different kind or payload");
      return job(rows[0]);
    },
    async claim(input) {
      text(input.worker, "worker");
      if (input.kinds) for (const kind of input.kinds) text(kind, "job kind");
      const rows = await sql.unsafe(`with candidate as (
        select id from remesso_sdk_jobs where namespace = $1 and
          ((status = 'pending' and run_at <= clock_timestamp()) or (status = 'running' and lease_until <= clock_timestamp()))
          and ($5::jsonb is null or kind in (select jsonb_array_elements_text($5::jsonb)))
        order by run_at, created_at, id for update skip locked limit 1
      ) update remesso_sdk_jobs j set status = 'running', worker = $2, claim_token = $3,
        lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond'), attempts = attempts + 1
        from candidate where j.namespace = $1 and j.id = candidate.id returning j.*`,
      [namespace, input.worker, randomUUID(), leaseMs(input.leaseMs), input.kinds ? json(input.kinds) : null]);
      return rows[0] ? job(rows[0]) as ClaimedJob<never> : undefined;
    },
    async ack(id, claimToken) {
      const rows = await sql.unsafe(`update remesso_sdk_jobs set status = 'completed', claim_token = null, lease_until = null
        where namespace = $1 and id = $2 and claim_token = $3 and status = 'running' and lease_until > clock_timestamp() returning id`, [namespace, id, claimToken]);
      return rows.length === 1;
    },
    async nack(id, claimToken, input = {}) {
      const rows = await sql.unsafe(`update remesso_sdk_jobs set status = 'pending', claim_token = null, lease_until = null,
        run_at = coalesce($4::timestamptz, clock_timestamp()), last_error = $5 where namespace = $1 and id = $2 and claim_token = $3
        and status = 'running' and lease_until > clock_timestamp() returning id`, [namespace, id, claimToken, input.runAt?.toISOString() ?? null, input.error?.slice(0, 8000) ?? null]);
      return rows.length === 1;
    },
    async extend(id, claimToken, duration) {
      const rows = await sql.unsafe(`update remesso_sdk_jobs set lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond')
        where namespace = $1 and id = $2 and claim_token = $3 and status = 'running' and lease_until > clock_timestamp() returning id`, [namespace, id, claimToken, leaseMs(duration)]);
      return rows.length === 1;
    },
    async get(key) {
      const rows = await sql.unsafe("select * from remesso_sdk_jobs where namespace = $1 and job_key = $2", [namespace, key]);
      return rows[0] ? job(rows[0]) as DurableJob<never> : undefined;
    },
  };

  return {
    namespace, paymentStore, remittanceStore, invoiceStore, inbox, coordinator, jobs,
    /** Creates only the SDK's own tables. Never alters Remesso backend tables. */
    async initialize() {
      const durability = await sql.unsafe("select current_setting('synchronous_commit') as commits, current_setting('fsync') as fsync");
      if (durability[0]?.commits === "off" || durability[0]?.fsync !== "on") {
        throw new RemessoError("refused", "durable payment journals require PostgreSQL fsync and synchronous_commit enabled");
      }
      for (const statement of [
        `create table if not exists remesso_sdk_payments (namespace text not null, scope text not null, id text not null,
          record jsonb not null, terms jsonb not null, recorded_at timestamptz not null, primary key (namespace, scope, id))`,
        `create index if not exists remesso_sdk_payments_since on remesso_sdk_payments (namespace, recorded_at)`,
        `create table if not exists remesso_sdk_remittances (namespace text not null, scope text not null, key text not null,
          record jsonb not null, terms jsonb not null, created_at timestamptz not null, primary key (namespace, scope, key))`,
        `create table if not exists remesso_sdk_nonces (namespace text not null, scope text not null, next_nonce bigint not null check (next_nonce >= 0), primary key (namespace, scope))`,
        `create table if not exists remesso_sdk_transactions (namespace text not null, scope text not null, nonce bigint not null check (nonce >= 0),
          hash text not null, raw text not null, created_at timestamptz not null default clock_timestamp(), primary key (namespace, scope, nonce))`,
        `create table if not exists remesso_sdk_invoices (namespace text not null, invoice_id text not null, reservation jsonb not null, primary key (namespace, invoice_id))`,
        `create table if not exists remesso_sdk_fulfillments (namespace text not null, event_id text not null, invoice_id text not null,
          issuer text not null, order_id text not null, fulfilled_at timestamptz not null default clock_timestamp(),
          primary key (namespace, event_id), unique (namespace, invoice_id), unique (namespace, issuer, order_id))`,
        `create table if not exists remesso_sdk_inbox_events (namespace text not null, event_id text not null, invoice_id text not null,
          issuer text not null, order_id text not null, primary key (namespace, event_id))`,
        `create table if not exists remesso_sdk_jobs (namespace text not null, id uuid not null, job_key text not null, kind text not null,
          payload jsonb not null, status text not null default 'pending' check (status in ('pending', 'running', 'completed')),
          attempts integer not null default 0, run_at timestamptz not null default clock_timestamp(), created_at timestamptz not null default clock_timestamp(),
          worker text, claim_token uuid, lease_until timestamptz, last_error text, primary key (namespace, id), unique (namespace, job_key))`,
        `create index if not exists remesso_sdk_jobs_ready on remesso_sdk_jobs (namespace, status, run_at, lease_until)`,
        // A no-op signed at an unsent write's nonce, so the write can't land late.
        `alter table remesso_sdk_transactions add column if not exists cancel_hash text`,
        `alter table remesso_sdk_transactions add column if not exists cancel_raw text`,
      ]) await sql.unsafe(statement);
      // Supabase may grant default table privileges to API roles. With no RLS
      // policies, raw signed bytes remain readable only by the owning trusted
      // server role (or a deliberately privileged BYPASSRLS role).
      for (const table of ["payments", "remittances", "nonces", "transactions", "invoices", "fulfillments", "inbox_events", "jobs"]) {
        await sql.unsafe(`alter table remesso_sdk_${table} enable row level security`);
        await sql.unsafe(`revoke all on table remesso_sdk_${table} from public`);
      }
    },
  };
}
