/// Node-only local development: real contracts on an owned Anvil fork, with a
/// deliberately small in-memory receiving backend. Never import this in a browser.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Address, type Hex, createPublicClient, decodeEventLog, encodeFunctionData,
  getAddress, hexToString, http, parseAbi, recoverTypedDataAddress, toHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { allowanceAbi, executorAbi } from "./abi.js";
import { createRemesso, type Remesso } from "./client.js";
import { ALLOWANCE, CHAIN_ID, EXECUTOR, token, toUnits } from "./deployment.js";
import type { PaymentEvent } from "./events.js";
import { fileRemittanceStore, fileStore, toNodeListener } from "./node.js";
import type { RequestStatus } from "./requests.js";
import { netOf } from "./vendor/fee.js";
import { generateSecret, signedHeaders } from "./vendor/standard-webhooks.js";
import { webhookTypedData } from "./vendor/webhook-actions.js";
import { webhookHandler, type WebhookMessage } from "./webhooks.js";

const HOST = "127.0.0.1";
const MNEMONIC = "test test test test test test test test test test test junk";
const POOL: Address = "0x6519d56eb0a69fc0338657784c783b169b8f7d32";
// Cold fork state may need several upstream reads before a local call returns.
const FORK_RPC_TIMEOUT_MS = 45_000;
const transferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type Rpc = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;

/** Reject remote signing targets, credentials and deceptive loopback hostnames. */
export function localDevUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("development RPC must be an absolute loopback HTTP URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("development RPC must use plain HTTP on 127.0.0.1, localhost or ::1, without credentials, path or query");
  }
  return url;
}

function rpcAt(value: string, fetcher: typeof fetch = fetch, timeoutMs = FORK_RPC_TIMEOUT_MS): Rpc {
  const url = localDevUrl(value).href;
  return async <T>(method: string, params: unknown[] = []): Promise<T> => {
    try {
      const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { result: T; error?: { message: string } };
      if (body.error) throw new Error(body.error.message);
      return body.result;
    } catch (error) {
      const e = error as Error;
      const detail = e.name === "TimeoutError" ? `timed out after ${timeoutMs}ms; the local fork may still be fetching upstream state` : e.message;
      // Never automatically repeat a mutation: an unanswered send may have
      // succeeded. The environment is closed by startDev's failure handler.
      throw new Error(`development RPC ${method} at ${url}: ${detail}`, { cause: error });
    }
  };
}

/** Called before funding or signing. The upstream fork is never a signing target. */
export async function assertLocalAnvil(rpcUrl: string, fetcher: typeof fetch = fetch): Promise<void> {
  const rpc = rpcAt(rpcUrl, fetcher, 10_000);
  const [version, chain] = await Promise.all([rpc<string>("web3_clientVersion"), rpc<string>("eth_chainId")]);
  if (!/^anvil\//i.test(version) || BigInt(chain) !== BigInt(CHAIN_ID)) throw new Error(`refusing local development writes: expected Anvil on Celo ${CHAIN_ID}`);
}

/** Test and fail on a collision; never reuse or stop an existing process. */
export async function assertDevPortAvailable(port: number): Promise<void> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("development ports must be integers from 1024 to 65535");
  const socket = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(port, HOST, () => socket.close((error) => error ? reject(error) : resolve()));
  }).catch((error) => { throw new Error(`development port ${port} is unavailable; choose another port (${(error as Error).message})`); });
}

export type DevOptions = {
  rpcPort?: number;
  httpPort?: number;
  /** Read-only upstream. All transactions go to the owned loopback Anvil. */
  forkUrl?: string;
  anvilBinary?: string;
  /** Optional pinned block for repeatable development. */
  forkBlockNumber?: bigint;
  /** Cancel startup as well as a running environment. */
  signal?: AbortSignal;
};
export type DevEnvironment = {
  rpcUrl: string;
  functionsUrl: string;
  receiverUrl: string;
  directory: string;
  envFile: string;
  accounts: { buyer: Address; seller: Address; treasury: Address };
  clients: { buyer: Remesso; seller: Remesso; treasury: Remesso };
  sampleInvoice: { id: string; reference: string; link: string };
  deliveries: WebhookMessage[];
  /** Exercise both funding models against this fork, including real receipts. */
  smoke(): Promise<string[]>;
  /** Stops only this environment's child/server and removes its temporary files. */
  close(): Promise<void>;
};

type LocalInvoice = RequestStatus & { createdBlock: bigint; createdAt: string; from: string | null; note: string | null };
type Subscription = { id: string; recipient: Address; url: string; secret: string; active: boolean; delivered: Set<string> };

/** Starts its own fork and receiving emulator. Requires `anvil` on PATH. */
export async function startDev(opts: DevOptions = {}): Promise<DevEnvironment> {
  if (opts.signal?.aborted) throw new Error("development startup was cancelled");
  const rpcPort = opts.rpcPort ?? 18546;
  const httpPort = opts.httpPort ?? 18547;
  if (rpcPort === httpPort) throw new Error("RPC and receiving backend ports must differ");
  await Promise.all([assertDevPortAvailable(rpcPort), assertDevPortAvailable(httpPort)]);
  const upstream = new URL(opts.forkUrl ?? "https://forno.celo.org");
  if (!["https:", "http:"].includes(upstream.protocol) || upstream.username || upstream.password) throw new Error("forkUrl must be an HTTP(S) read-only RPC URL without credentials");
  const rpcUrl = `http://${HOST}:${rpcPort}`;
  const functionsUrl = `http://${HOST}:${httpPort}`;
  const receiverUrl = `${functionsUrl}/webhook-receiver`;
  const rpc = rpcAt(rpcUrl);
  const directory = await mkdtemp(join(tmpdir(), "remesso-sdk-dev-"));
  let child: ChildProcess | undefined;
  let server: Server | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true;
    opts.signal?.removeEventListener("abort", abort);
    if (interval) clearInterval(interval);
    if (server?.listening) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
    if (child?.pid != null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise<void>((resolve) => child!.once("exit", () => resolve())), delay(3000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(directory, { recursive: true, force: true });
  })();
  const abort = () => { void close(); };
  opts.signal?.addEventListener("abort", abort, { once: true });
  const ensureOpen = () => { if (closed || opts.signal?.aborted) throw new Error("development startup was cancelled"); };

  try {
    const args = ["--fork-url", upstream.href, "--host", HOST, "--port", String(rpcPort), "--chain-id", String(CHAIN_ID), "--silent"];
    if (opts.forkBlockNumber != null) {
      if (opts.forkBlockNumber < 0n) throw new Error("forkBlockNumber must be nonnegative");
      args.push("--fork-block-number", String(opts.forkBlockNumber));
    }
    child = spawn(opts.anvilBinary ?? "anvil", args, { stdio: ["ignore", "pipe", "pipe"] });
    let startupError: Error | undefined;
    let diagnostics = "";
    child.once("error", (e) => { startupError = e; });
    const output = (data: Buffer) => { diagnostics = (diagnostics + data.toString()).slice(-3000); };
    child.stdout?.on("data", output); child.stderr?.on("data", output);
    const deadline = Date.now() + 60_000;
    for (;;) {
      ensureOpen();
      if (startupError) throw new Error(`could not start Anvil; install Foundry and ensure anvil is on PATH (${startupError.message})`);
      if (child.exitCode !== null) throw new Error(`the owned Anvil exited before startup: ${diagnostics}`);
      try { await assertLocalAnvil(rpcUrl); break; }
      catch (e) { if (Date.now() >= deadline) throw new Error(`Anvil did not start within 60 seconds: ${(e as Error).message}; ${diagnostics}`); }
      await delay(200);
    }
    // The first guard has passed before any state-changing RPC.
    const chain = createPublicClient({ chain: celo, transport: http(rpcUrl, { retryCount: 0, timeout: FORK_RPC_TIMEOUT_MS }), pollingInterval: 100 });
    const keys = { buyer: mnemonicToAccount(MNEMONIC, { addressIndex: 0 }), seller: mnemonicToAccount(MNEMONIC, { addressIndex: 1 }), treasury: mnemonicToAccount(MNEMONIC, { addressIndex: 2 }) };
    const accounts = { buyer: keys.buyer.address, seller: keys.seller.address, treasury: keys.treasury.address };
    const usdt = token("USDT");
    const originBlock = await chain.getBlockNumber();
    await assertLocalAnvil(rpcUrl);
    await rpc("evm_setAutomine", [true]);
    await rpc("anvil_setBalance", [POOL, toHex(10n ** 20n)]);
    await rpc("anvil_impersonateAccount", [POOL]);
    try {
      for (const account of Object.values(accounts)) {
        await rpc("anvil_setBalance", [account, toHex(10n ** 20n)]);
        const hash = await rpc<Hex>("eth_sendTransaction", [{ from: POOL, to: usdt.address, data: encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [account, 100_000_000n] }) }]);
        const receipt = await chain.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("local USDT seeding reverted; no mainnet transaction was sent");
      }
    } finally { await rpc("anvil_stopImpersonatingAccount", [POOL]); }
    ensureOpen();

    const invoices = new Map<string, LocalInvoice>();
    const events: PaymentEvent[] = [];
    const subscriptions = new Map<string, Subscription>();
    const deliveries: WebhookMessage[] = [];
    let receiverSecret: string | undefined;
    let scanned = originBlock;
    let seq = 0;
    let refreshing: Promise<void> | undefined;
    const receiver = webhookHandler({ recipient: accounts.seller, secret: () => receiverSecret, onPayment: (message) => { if (!deliveries.some((x) => x.id === message.id)) deliveries.push(message); } });

    const refresh = (): Promise<void> => refreshing ??= (async () => {
      const head = await chain.getBlockNumber({ cacheTime: 0 });
      for (let from = scanned + 1n; from <= head; from += 5000n) {
        const toBlock = from + 4999n > head ? head : from + 4999n;
        const logs = await chain.getLogs({ address: [ALLOWANCE, EXECUTOR], fromBlock: from, toBlock });
        for (const log of logs) {
          if (!log.transactionHash || !log.blockHash || log.blockNumber == null || log.logIndex == null || log.removed) continue;
          let decoded;
          try { decoded = decodeEventLog({ abi: same(log.address, ALLOWANCE) ? allowanceAbi : executorAbi, topics: log.topics, data: log.data }) as { eventName: string; args: Record<string, unknown> }; }
          catch { continue; }
          const a = decoded.args;
          const id = a.id as bigint;
          const block = await chain.getBlock({ blockNumber: log.blockNumber });
          const base: PaymentEvent = { seq: ++seq, chainId: CHAIN_ID, contract: getAddress(log.address), kind: "run", refId: String(id),
            from: null, to: null, agent: null, token: null, amount: null, amountIn: null, memo: null, memoText: null, runNumber: null,
            early: null, details: { developmentEmulator: true }, txHash: log.transactionHash, logIndex: log.logIndex,
            blockNumber: Number(log.blockNumber), blockHash: log.blockHash, blockTime: new Date(Number(block.timestamp) * 1000).toISOString(), final: false, removed: false };
          if (["PolicyCreated", "Paid", "PolicyRevoked"].includes(decoded.eventName)) {
            const p = await chain.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "policy", args: [id] });
            Object.assign(base, { kind: decoded.eventName === "PolicyCreated" ? "policy_created" : decoded.eventName === "Paid" ? "policy_payment" : "policy_revoked", from: p.owner, agent: p.agent, token: p.token });
            if (decoded.eventName === "Paid") {
              base.to = a.to as Address; base.amount = String(a.amount); base.memo = a.memo as Hex;
              base.memoText = hexToString(base.memo).replace(/\0+$/, "");
            }
          } else if (["ScheduleCreated", "RunExecuted"].includes(decoded.eventName)) {
            const s = await chain.readContract({ address: EXECUTOR, abi: executorAbi, functionName: "getSchedule", args: [id] });
            Object.assign(base, { kind: decoded.eventName === "ScheduleCreated" ? "schedule_created" : "run", from: s.sender, to: s.destination,
              token: s.payoutType === 2 ? s.token : s.tokenOut, amountIn: String(s.amountIn) });
            if (decoded.eventName === "RunExecuted") { base.amount = String(a.amountOut); base.runNumber = Number(a.runsExecuted); base.early = Boolean(a.early); }
          } else { seq--; continue; }
          if (!events.some((event) => event.txHash === base.txHash && event.logIndex === base.logIndex)) events.push(base);
        }
        scanned = toBlock;
      }
      for (const invoice of invoices.values()) {
        const t = invoice.requested.token ? token(invoice.requested.token) : null;
        if (!t || !invoice.requested.amount) continue;
        const found = events.filter((event) => ["run", "policy_payment"].includes(event.kind) && event.from && event.to && event.token &&
          same(event.from, invoice.payer) && same(event.to, invoice.requested.to) && same(event.token, t.address) && event.amount === String(toUnits(invoice.requested.amount!, t)) &&
          (event.kind === "policy_payment" ? event.memoText === invoice.reference : invoice.payment?.schedule?.id === event.refId));
        if (found.length) {
          invoice.status = "accepted";
          invoice.payment = { state: "paid", schedule: invoice.payment?.schedule ?? null,
            txs: found.map((event) => ({ txHash: event.txHash, amount: event.amount!, final: false, blockTime: event.blockTime })), reason: null };
        }
      }
    })().finally(() => { refreshing = undefined; });

    const dispatch = async () => {
      for (const subscription of subscriptions.values()) {
        if (!subscription.active) continue;
        for (const event of events) {
          if (!["run", "policy_payment"].includes(event.kind) || !event.to || !same(event.to, subscription.recipient) || !event.from || !event.token || !event.amount) continue;
          const id = `dev_${event.txHash}_${event.logIndex}`;
          if (subscription.delivered.has(id)) continue;
          const body = JSON.stringify({ type: "payment.received", timestamp: new Date().toISOString(), data: {
            chainId: CHAIN_ID, contract: event.contract, ...(event.kind === "run" ? { schedule: event.refId } : { policy: event.refId }),
            from: event.from, to: event.to, token: event.token, amount: event.amount, amountIn: event.amountIn,
            runNumber: event.runNumber, memo: event.memo, memoText: event.memoText,
            txHash: event.txHash, logIndex: event.logIndex, blockNumber: event.blockNumber, blockHash: event.blockHash, blockTime: event.blockTime, final: false, removed: false,
          } });
          // Only the embedded receiver is permitted. No arbitrary URL fetch.
          if (subscription.url !== receiverUrl) throw new Error("external development webhook blocked");
          const response = await fetch(receiverUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...await signedHeaders([subscription.secret], id, body) }, body });
          if (response.ok) subscription.delivered.add(id);
        }
      }
    };
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value, (_, item) => typeof item === "bigint" ? String(item) : item), { status, headers: { "content-type": "application/json", "x-remesso-development": "receiving-emulator" } });
    const handler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === "/webhook-receiver") return receiver(req);
      if (url.pathname === "/health") return json({ ok: true, backend: "development receiving emulator", chain: "owned local Celo fork", production: false });
      if (url.pathname === "/profile") return json({ name: "Local seller agent", remesso: { recipient: accounts.seller, acceptedTokens: ["USDT"], requestRequired: true } });
      await refresh();
      if (url.pathname === "/payment-events" && req.method === "GET") {
        const address = (url.searchParams.get("address") ?? "").toLowerCase();
        const role = url.searchParams.get("role") ?? "any";
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
        const kinds = url.searchParams.get("kind")?.split(",");
        const filtered = events.filter((event) => event.seq > after && (!kinds || kinds.includes(event.kind)) &&
          (role === "any" ? [event.from, event.to, event.agent].some((who) => who?.toLowerCase() === address) : event[role as "from" | "to" | "agent"]?.toLowerCase() === address));
        const page = filtered.slice(0, limit);
        return json({ events: page, next: page.at(-1)?.seq ?? after });
      }
      if (req.method !== "POST") return json({ error: "unknown development endpoint" }, 404);
      const raw = await req.text();
      if (raw.length > 65536) return json({ error: "body too large" }, 413);
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (url.pathname === "/request-payment") {
        const action = body.action ?? "create";
        if (action === "list") return json({ requests: [...invoices.values()].filter((r) => same(r.payer, String(body.payer)) && r.status === "pending").map((r) => ({ id: r.id, reference: r.reference, ...r.requested, from: r.from, note: r.note, status: r.status, createdAt: r.createdAt })) });
        if (action === "create") {
          const id = crypto.randomUUID(); const payer = getAddress(String(body.payer)); const to = getAddress(String(body.to));
          const t = token(String(body.token ?? "USDT")); const amount = String(body.amount ?? "1");
          if (toUnits(amount, t) <= 0n || body.every || (body.runs != null && body.runs !== 1)) return json({ error: "the emulator supports exact one-off invoices only" }, 400);
          const invoice: LocalInvoice = { id, reference: id.replaceAll("-", ""), status: "pending", payer,
            requested: { to, amount, token: t.symbol, intervalSeconds: null, runs: 1 }, signed: null, payment: null,
            createdBlock: await chain.getBlockNumber({ cacheTime: 0 }), createdAt: new Date().toISOString(), from: body.from ? String(body.from) : null, note: body.note ? String(body.note) : null };
          invoices.set(id, invoice);
          return json({ id, link: `${functionsUrl}/invoice/${id}`, status: "pending" });
        }
        const invoice = invoices.get(String(body.id));
        if (!invoice) return json({ error: "invoice not found" }, 404);
        if (action === "status") return json(invoice);
        if (action === "answer") {
          const id = BigInt(String(body.schedule));
          const created = events.find((e) => e.kind === "schedule_created" && e.refId === String(id));
          if (!created) return json({ error: "the schedule hasn't been seen on-chain yet" }, 409);
          const s = await chain.readContract({ address: EXECUTOR, abi: executorAbi, functionName: "getSchedule", args: [id] });
          const invoiceToken = token(invoice.requested.token!);
          if (!same(s.sender, invoice.payer) || !same(s.destination, invoice.requested.to) || !same(s.token, invoiceToken.address) || s.payoutType !== 2 ||
            s.maxRuns !== 1 || netOf(s.amountIn, Number(s.feeBps)) !== toUnits(invoice.requested.amount!, invoiceToken) || BigInt(created.blockNumber) < invoice.createdBlock ||
            [...invoices.values()].some((r) => r.id !== invoice.id && r.payment?.schedule?.id === String(id)) || invoice.payment?.schedule && invoice.payment.schedule.id !== String(id)) {
            return json({ error: "schedule does not answer this exact one-off invoice" }, 409);
          }
          invoice.status = "accepted"; invoice.signed = { developmentEmulator: true, schedule: String(id) };
          invoice.payment = { state: "scheduled", schedule: { contract: EXECUTOR, id: String(id) }, txs: [], reason: null };
          await refresh();
          return json({ ok: true, status: "accepted", signed: invoice.signed });
        }
        return json({ error: "this receiving emulator implements create, list, status and answer; use the production backend tests for decline/finality/reorg behavior" }, 400);
      }
      if (url.pathname === "/webhooks") {
        if (body.url !== receiverUrl || !same(String(body.recipient), accounts.seller)) return json({ error: "development webhooks can target only this environment's embedded seller receiver" }, 403);
        const unsigned = { recipient: accounts.seller, url: receiverUrl, chainId: CHAIN_ID, action: String(body.action), nonce: String(body.nonce), expiry: Number(body.expiry) };
        if (unsigned.expiry < Date.now() / 1000 || unsigned.expiry > Date.now() / 1000 + 3600) return json({ error: "invalid development webhook signature expiry" }, 403);
        const recovered = await recoverTypedDataAddress({ ...webhookTypedData(unsigned as Parameters<typeof webhookTypedData>[0]), signature: String(body.signature) as Hex });
        if (!same(recovered, accounts.seller)) return json({ error: "recipient signature does not verify" }, 403);
        const existing = subscriptions.get(receiverUrl);
        if (body.action === "subscribe") {
          const challenge = crypto.randomUUID();
          const response = await receiver(new Request(receiverUrl, { method: "POST", body: JSON.stringify({ type: "webhook.verification", data: { recipient: accounts.seller, challenge } }) }));
          if ((await response.json() as { challenge: string }).challenge !== challenge) return json({ error: "challenge failed" }, 409);
          const subscription: Subscription = { id: crypto.randomUUID(), recipient: accounts.seller, url: receiverUrl, secret: generateSecret(), active: true, delivered: new Set() };
          subscriptions.set(receiverUrl, subscription); receiverSecret = subscription.secret;
          return json({ ok: true, subscription: subscription.id, recipient: accounts.seller, url: receiverUrl, state: "active", secret: subscription.secret });
        }
        if (!existing) return json({ error: "subscription not found" }, 404);
        if (body.action === "revoke") { existing.active = false; return json({ ok: true, state: "revoked" }); }
        return json({ error: "the development webhook emulator supports subscribe and revoke; use the production backend tests for secret rotation, replay windows and delivery scheduling" }, 400);
      }
      return json({ error: "unknown development endpoint" }, 404);
    };
    server = createServer(toNodeListener(async (req) => {
      try { return await handler(req); }
      catch (error) { return json({ error: (error as Error).message }, 400); }
    }));
    ensureOpen();
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(httpPort, HOST, () => {
        if (closed) server!.close(() => reject(new Error("development startup was cancelled")));
        else resolve();
      });
    });
    ensureOpen();
    interval = setInterval(() => { if (!closed) void refresh().then(dispatch).catch(() => { /* Next tick retries; the smoke path asserts delivery. */ }); }, 500);
    const client = (role: keyof typeof keys) => createRemesso({ account: keys[role], publicClient: chain, rpcUrl, functionsUrl, appOrigin: functionsUrl,
      store: fileStore(join(directory, `${role}-payments.json`)), remittanceStore: fileRemittanceStore(join(directory, `${role}-remittances.json`)) });
    const clients = { buyer: client("buyer"), seller: client("seller"), treasury: client("treasury") };
    const sampleInvoice = await clients.seller.requests.create({ payer: accounts.buyer, to: accounts.seller, amount: "1", token: "USDT", from: "Local seller agent", note: "Development one-off invoice" });
    const envFile = join(directory, "public-test.env");
    const privateKey = (role: keyof typeof keys) => toHex(keys[role].getHdKey().privateKey!);
    await writeFile(envFile, ["# PUBLIC ANVIL TEST KEYS. Never fund or use these on a real network.", `REMESSO_RPC_URL=${rpcUrl}`, `REMESSO_FUNCTIONS_URL=${functionsUrl}`,
      `BUYER_PRIVATE_KEY=${privateKey("buyer")}`, `SELLER_PRIVATE_KEY=${privateKey("seller")}`, `TREASURY_PRIVATE_KEY=${privateKey("treasury")}`,
      `SELLER_ADDRESS=${accounts.seller}`, `SAMPLE_REQUEST_ID=${sampleInvoice.id}`, ""].join("\n"), { mode: 0o600 });
    ensureOpen();

    const smoke = async (): Promise<string[]> => {
      await assertLocalAnvil(rpcUrl);
      const checks: string[] = [];
      const check = (condition: unknown, name: string, details?: unknown) => {
        if (!condition) throw new Error(`development smoke failed: ${name}${details == null ? "" : `; ${JSON.stringify(details)}`}`);
        checks.push(name);
      };
      const subscription = await clients.seller.webhooks.subscribe({ url: receiverUrl });
      check(subscription.state === "active", "local webhook ownership challenge and signature");
      const walletInput = { funding: "wallet" as const, to: accounts.seller, amount: "1", token: "USDT", requestId: sampleInvoice.id, idempotencyKey: `dev-wallet:${sampleInvoice.id}` };
      const walletQuote = await clients.buyer.remittances.quote(walletInput);
      check(walletQuote.canSend && walletQuote.protocolFee > 0n, "wallet quote and creation/approval simulations", { issues: walletQuote.issues, simulation: walletQuote.simulation, feeBps: walletQuote.feeBps });
      const prepared = await clients.buyer.remittances.prepare(walletInput, { ttlSeconds: 120 });
      check(prepared.input.maxDebit != null && toUnits(prepared.input.maxDebit, usdt) === prepared.quote.grossDebit &&
        prepared.input.validUntil != null && prepared.input.validUntil <= Math.floor(prepared.quote.expiresAt.getTime() / 1000), "prepared intent pins the quoted debit and expiry");
      const paid = await clients.buyer.remittances.send(prepared.input);
      check(paid.status === "confirmed" && paid.hash, "wallet-funded exact remittance");
      const proof = await clients.seller.receipts.verify({ txHash: paid.hash!, from: accounts.buyer, to: accounts.seller, token: "USDT", amount: "1", ...(paid.funding === "wallet" ? { scheduleId: paid.scheduleId } : {}) });
      check(proof.kind === "run" && proof.amount === 1_000_000n, "independent wallet payment receipt");
      const walletStatus = await clients.buyer.requests.get(sampleInvoice.id);
      check(walletStatus.payment?.state === "paid" && walletStatus.payment.txs.length === 1, "wallet invoice binding and settlement from chain evidence");
      const operation = await clients.buyer.remittances.get(walletInput.idempotencyKey, { funding: "wallet" });
      check(["included", "finalized"].includes(operation.status) && operation.hash === paid.hash, "lifecycle get independently reads the stored payment evidence");
      const waited = await clients.buyer.remittances.wait(walletInput.idempotencyKey, { funding: "wallet", finality: "included", timeoutMs: 3000, intervalMs: 100 });
      check(waited.hash === paid.hash && ["included", "finalized"].includes(waited.status), "lifecycle wait resolves at requested included evidence");
      const nonceBefore = await chain.getTransactionCount({ address: accounts.buyer });
      const reconciled = await clients.buyer.remittances.reconcile(walletInput.idempotencyKey, { funding: "wallet", waitMs: 3000 });
      check(reconciled.hash === paid.hash && ["included", "finalized"].includes(reconciled.status) &&
        await chain.getTransactionCount({ address: accounts.buyer }) === nonceBefore, "lifecycle reconcile reuses the existing key without sending another payment");
      const policy = await clients.treasury.policies.create({ agent: accounts.buyer, token: "USDT", perPayment: "5", perDay: "10", days: 1, budget: "10", recipients: [accounts.seller] });
      const invoice = await clients.seller.requests.create({ payer: accounts.treasury, to: accounts.seller, amount: "1", token: "USDT" });
      const policyTerms = { funding: "policy" as const, to: accounts.seller, amount: "1", token: "USDT", payer: accounts.treasury, policyId: policy.id, requestId: invoice.id, idempotencyKey: `dev-policy:${invoice.id}` };
      const policyQuote = await clients.buyer.remittances.quote(policyTerms);
      check(policyQuote.canSend && policyQuote.protocolFee === 0n, "treasury policy quote and payment simulation", { issues: policyQuote.issues, simulation: policyQuote.simulation });
      const policyPaid = await clients.buyer.remittances.send(policyTerms);
      check(policyPaid.status === "confirmed" && policyPaid.hash, "policy-funded exact remittance");
      const policyProof = await clients.seller.receipts.verify({ txHash: policyPaid.hash!, from: accounts.treasury, to: accounts.seller, token: "USDT", amount: "1", policyId: policy.id, memo: invoice.reference });
      check(policyProof.kind === "policy_payment", "independent treasury policy payment receipt");
      const policyStatus = await clients.buyer.requests.get(invoice.id);
      check(policyStatus.payment?.state === "paid", "policy invoice settlement by on-chain reference");
      // A fresh fork may mine from its upstream timestamp while wall-clock
      // time advances during startup. Set an explicit already-issued time
      // for this local fixture; receipt validity checks remain unchanged.
      const invoiceBlock = await chain.getBlock({ blockTag: "latest" });
      const signed = await clients.seller.invoices.create({ payer: accounts.treasury, amount: "1.25", token: "USDT",
        orderId: `dev-signed:${invoice.id}`, issuedAt: Math.min(Number(invoiceBlock.timestamp), Math.floor(Date.now() / 1000)),
        expiresAt: Math.max(Number(invoiceBlock.timestamp), Math.floor(Date.now() / 1000)) + 600 });
      const authenticated = await clients.buyer.invoices.verify(signed);
      check(authenticated.recipient === accounts.seller && authenticated.payer === accounts.treasury &&
        authenticated.amount === 1_250_000n && authenticated.requestId, "seller EIP-712 invoice authenticates exact terms and backend request");
      const signedPaid = await clients.buyer.invoices.pay(signed, { funding: "policy", policyId: policy.id, maxDebit: "1.25" });
      check(signedPaid.status === "confirmed" && signedPaid.hash && signedPaid.invoiceId === authenticated.id, "agent pays the signed invoice through the treasury policy");
      const invoiceProof = await clients.seller.invoices.verifyPayment(signed, { txHash: signedPaid.hash!, policyId: policy.id, finality: "included" });
      check(invoiceProof.invoiceId === authenticated.id && invoiceProof.orderId === authenticated.orderId &&
        invoiceProof.payment.kind === "policy_payment" && invoiceProof.payment.amount === 1_250_000n, "seller verifies the signed invoice against actual included payment evidence");
      const signedStatus = await clients.seller.requests.get(authenticated.requestId!);
      check(signedStatus.payment?.state === "paid", "signed invoice's backend request settles from the exact on-chain reference");
      const page = await clients.seller.events.list({ kinds: ["run", "policy_payment"] });
      check(page.events.length === 3 && page.events.filter((e) => e.amount === "1000000").length === 2 &&
        page.events.filter((e) => e.amount === "1250000").length === 1 && page.events.every((e) => !e.final), "local receiving events from all three real contract payments");
      await dispatch();
      check(deliveries.length === 3, "three signed local webhook deliveries verified and deduplicated");
      return checks;
    };
    return { rpcUrl, functionsUrl, receiverUrl, directory, envFile, accounts, clients, sampleInvoice, deliveries, smoke, close };
  } catch (error) { await close(); throw error; }
}
