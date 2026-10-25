/// Node-only parts: a payment store on disk, the safe fetch for remote
/// registration files, and an adapter from the fetch-style webhook handler to
/// `http.createServer` or Express.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type PaymentRecord, type PaymentStore, upsert } from "./store.js";

export { safeFetchText } from "./vendor/safe-fetch.js";

/// Agent payment records in a JSON file (mode 0600), so a retry after a
/// restart still pays once. Default `~/.remesso-sdk/payments.json`. One
/// process per file: it isn't locked.
export function fileStore(path: string = join(homedir(), ".remesso-sdk", "payments.json")): PaymentStore {
  const load = (): PaymentRecord[] => {
    try {
      return JSON.parse(readFileSync(path, "utf8")).payments ?? [];
    } catch {
      return [];
    }
  };
  return {
    byKey: async (key, deployment) => load().reverse().find((p) => p.key === key && p.deployment === deployment),
    since: async (since) => load().filter((p) => Date.parse(p.at) > since),
    save: async (rec) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, payments: upsert(load(), rec) }, null, 2), { mode: 0o600 });
      renameSync(tmp, path); // whole or not at all: a crash mid-write keeps the old file
      chmodSync(path, 0o600);
    },
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
