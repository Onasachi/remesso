/// Node-only parts: a payment store on disk, the safe fetch for remote
/// registration files, and an adapter from the fetch-style webhook handler to
/// `http.createServer` or Express.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RemessoError } from "./errors.js";
import { type PaymentRecord, type PaymentStore, upsert } from "./store.js";
import type { RemittanceRecord, RemittanceStore } from "./remittance-store.js";

export { safeFetchText } from "./vendor/safe-fetch.js";

function durableJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const file = openSync(tmp, "w", 0o600);
  try { writeFileSync(file, JSON.stringify(data, null, 2)); fsyncSync(file); }
  finally { closeSync(file); }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (e) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
}

/// Agent payment records in a JSON file (mode 0600), so a retry after a
/// restart still pays once. Default `~/.remesso-sdk/payments.json`. One
/// process per file: it isn't locked.
export function fileStore(path: string = join(homedir(), ".remesso-sdk", "payments.json")): PaymentStore {
  const load = (): PaymentRecord[] => {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.payments)) throw new Error("invalid payment store format");
      if (data.payments.some((p: PaymentRecord) => !p || typeof p.deployment !== "string" ||
        !(p.key === null || typeof p.key === "string") || !/^\d+$/.test(p.policyId) || !/^\d+$/.test(p.units) ||
        !/^0x[0-9a-f]{40}$/i.test(p.to) || !/^0x[0-9a-f]{40}$/i.test(p.token) || !/^0x[0-9a-f]{64}$/i.test(p.hash) ||
        !/^0x[0-9a-f]{64}$/i.test(p.memo) || !/^0x(?:[0-9a-f]{2})*$/i.test(p.raw) ||
        !Number.isSafeInteger(p.nonce) || p.nonce < 0 || !Number.isFinite(Date.parse(p.at)) || (p.validUntil !== undefined && (!Number.isSafeInteger(p.validUntil) || p.validUntil <= 0)) ||
        !["sent", "confirmed", "reverted", "unsent", "dropped"].includes(p.status))) throw new Error("invalid payment record");
      return data.payments;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RemessoError("conflict", "the payment store cannot be read; restore it before paying so a retry cannot pay twice", { path, cause: String(e) });
    }
  };
  return {
    byKey: async (key, deployment) => load().reverse().find((p) => p.key === key && p.deployment === deployment),
    since: async (since) => load().filter((p) => Date.parse(p.at) > since),
    save: async (rec) => {
      durableJson(path, { version: 1, payments: upsert(load(), rec) });
    },
  };
}

/** Wallet remittance progress across restarts. One process per file; keys are never evicted. */
export function fileRemittanceStore(path: string = join(homedir(), ".remesso-sdk", "remittances.json")): RemittanceStore {
  const address = (v: unknown) => typeof v === "string" && /^0x[\da-f]{40}$/i.test(v);
  const hash = (v: unknown) => typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
  const uint = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);
  const load = (): RemittanceRecord[] => {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.remittances)) throw new Error("invalid remittance store format");
      const keys = new Set<string>();
      for (const r of data.remittances as RemittanceRecord[]) {
        if (!r || typeof r.key !== "string" || !r.key.trim() || typeof r.scope !== "string" || !r.scope ||
          ![r.payer, r.to, r.token].every(address) || ![r.amount, r.amountIn, r.fee, r.approvalAmount].every(uint) ||
          !Number.isSafeInteger(r.feeBps) || r.feeBps < 0 || r.feeBps > 10_000 || !Number.isSafeInteger(r.expiresAt) || !Number.isSafeInteger(r.firstRunAt) || r.firstRunAt <= 0 ||
          !Number.isFinite(Date.parse(r.createdAt)) || (r.validUntil !== undefined && (!Number.isSafeInteger(r.validUntil) || r.validUntil <= 0)) || (r.scheduleId !== undefined && !uint(r.scheduleId)) ||
          (r.creationBlock !== undefined && !uint(r.creationBlock)) || (r.paymentHash !== undefined && !hash(r.paymentHash)) ||
          (r.requestId !== undefined && (typeof r.requestId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(r.requestId))) ||
          (r.requestBound !== undefined && typeof r.requestBound !== "boolean")) throw new Error("invalid remittance record");
        for (const step of [r.approval, r.creation, r.execution, r.cancellation]) if (step && (!hash(step.hash) || typeof step.raw !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(step.raw) || !Number.isSafeInteger(step.nonce) || step.nonce < 0)) throw new Error("invalid signed remittance step");
        const key = JSON.stringify([r.scope, r.key]);
        if (keys.has(key)) throw new Error("duplicate remittance key");
        keys.add(key);
      }
      return data.remittances;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RemessoError("conflict", "the remittance store cannot be read; restore its history before sending", { path, cause: String(e) });
    }
  };
  return {
    get: async (key, scope) => load().find((r) => r.key === key && r.scope === scope),
    list: async (scope) => load().filter((r) => r.scope === scope),
    save: async (record) => durableJson(path, { version: 1, remittances: [...load().filter((r) => r.key !== record.key || r.scope !== record.scope), record] }),
  };
}

/// `http.createServer(toNodeListener(webhookHandler({...})))`, or as Express
/// middleware on a route: it reads the raw body itself, so mount it before
/// any JSON body parser.
export function toNodeListener(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const out = await handler(new Request(url, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  };
}
