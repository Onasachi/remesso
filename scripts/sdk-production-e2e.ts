/// Actual SDK workers sharing a local PostgreSQL coordinator and real Celo
/// contracts on an owned Anvil fork. The receiving HTTP backend is startDev's
/// in-memory emulator, NOT production Supabase. Nothing writes to mainnet.
///
/// Prerequisites: Anvil on PATH; otherwise idle local Postgres on 54322.
/// deno run --allow-all --config packages/remesso-sdk/deno.json \
///   --unstable-sloppy-imports scripts/sdk-production-e2e.ts
///
/// Uses only a random namespace in SDK-owned tables. Never resets Supabase,
/// truncates a table, or shuts down an existing process.
import postgres from "npm:postgres@3.4.5";
import { createPublicClient, http, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { createRemesso } from "../packages/remesso-sdk/src/client.ts";
import { assertLocalAnvil, localDevUrl, startDev, type DevEnvironment } from "../packages/remesso-sdk/src/dev.ts";
import { ALLOWANCE, EXECUTOR } from "../packages/remesso-sdk/src/deployment.ts";
import { allowanceAbi, executorAbi } from "../packages/remesso-sdk/src/abi.ts";
import type { SignedInvoice } from "../packages/remesso-sdk/src/invoices.ts";
import { createPostgresStorage } from "../packages/remesso-sdk/src/postgres.ts";
import type { SendRemittanceInput } from "../packages/remesso-sdk/src/remittances.ts";

const DATABASE = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const MNEMONIC = "test test test test test test test test test test test junk";
const tables = ["payments", "remittances", "nonces", "transactions", "jobs", "invoices", "fulfillments", "inbox_events"] as const;
type Work = { funding: "wallet"; terms: SendRemittanceInput } | { funding: "policy"; invoice: SignedInvoice; policyId: string };
type WorkerResult = { status: string; hash: Hex; funding: "wallet" | "policy"; scheduleId?: string; policyId?: string; invoiceId?: Hex; repeat?: boolean };
const encode = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? String(item) : item);

async function worker(): Promise<void> {
  const [, namespace, rpcUrl, functionsUrl, path] = Deno.args;
  if (!/^sdk-production-e2e-[\da-f-]{36}$/.test(namespace ?? "")) throw new Error("worker requires this test's random namespace");
  localDevUrl(rpcUrl); localDevUrl(functionsUrl);
  await assertLocalAnvil(rpcUrl);
  const sql = postgres(DATABASE, { max: 4, onnotice() {} });
  try {
    const storage = createPostgresStorage(sql, { namespace, heartbeatMs: 100 });
    const chain = createPublicClient({ chain: celo, transport: http(rpcUrl, { retryCount: 0 }), pollingInterval: 100 });
    const sdk = createRemesso({ account: mnemonicToAccount(MNEMONIC, { addressIndex: 0 }), rpcUrl, functionsUrl, publicClient: chain,
      store: storage.paymentStore, remittanceStore: storage.remittanceStore, coordinator: storage.coordinator, invoiceStore: storage.invoiceStore });
    const input = JSON.parse(await Deno.readTextFile(path)) as Work;
    const paid = input.funding === "wallet" ? await sdk.remittances.send(input.terms)
      : await sdk.invoices.pay(input.invoice, { funding: "policy", policyId: input.policyId, maxDebit: "1.25" });
    console.log(encode(paid));
  } finally { await sql.end({ timeout: 2 }); }
}

async function main(): Promise<void> {
  const namespace = `sdk-production-e2e-${crypto.randomUUID()}`;
  const sqlA = postgres(DATABASE, { max: 6, onnotice() {} });
  const sqlB = postgres(DATABASE, { max: 4, onnotice() {} });
  const a = createPostgresStorage(sqlA, { namespace, heartbeatMs: 100 });
  const b = createPostgresStorage(sqlB, { namespace, heartbeatMs: 100 });
  let dev: DevEnvironment | undefined;
  let initialized = false;
  const children = new Set<Deno.ChildProcess>();
  const checks: string[] = [];
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); };
  try {
    await a.initialize(); initialized = true;
    dev = await startDev({ rpcPort: 18546, httpPort: 18547 });
    console.log(`Local production-adapter integration: namespace ${namespace}; receiving backend is a development emulator.`);
    await assertLocalAnvil(dev.rpcUrl);
    const chain = dev.clients.buyer.publicClient;
    const origin = await chain.getBlockNumber({ cacheTime: 0 });
    const runWorkers = async (input: Work): Promise<WorkerResult[]> => {
      const path = `${dev!.directory}/${input.funding}-worker.json`;
      await Deno.writeTextFile(path, encode(input), { mode: 0o600 });
      const config = new URL("../packages/remesso-sdk/deno.json", import.meta.url).pathname;
      const script = new URL(import.meta.url).pathname;
      const run = async () => {
        const child = new Deno.Command(Deno.execPath(), { args: ["run", "--config", config, "--unstable-sloppy-imports", "--allow-read", "--allow-env", "--allow-net=127.0.0.1,localhost",
          script, "--worker", namespace, dev!.rpcUrl, dev!.functionsUrl, path], stdout: "piped", stderr: "piped" }).spawn();
        children.add(child);
        try {
          const result = await child.output();
          if (result.code !== 0) throw new Error(`SDK worker failed: ${new TextDecoder().decode(result.stderr)}`);
          return JSON.parse(new TextDecoder().decode(result.stdout).trim()) as WorkerResult;
        } finally { children.delete(child); }
      };
      // Separate OS processes: their SDK process-local queues cannot serialize
      // each other. The PostgreSQL advisory lock and journals must do it.
      return await Promise.all([run(), run()]);
    };

    const walletTerms: SendRemittanceInput = { funding: "wallet", to: dev.accounts.seller, amount: "1", token: "USDT", requestId: dev.sampleInvoice.id,
      idempotencyKey: `shared-wallet:${dev.sampleInvoice.id}`, maxDebit: "1.01", validUntil: Math.floor(Date.now() / 1000) + 600 };
    const beforeWalletNonce = await chain.getTransactionCount({ address: dev.accounts.buyer });
    const wallet = await runWorkers({ funding: "wallet", terms: walletTerms });
    check(wallet.every((result) => result.status === "confirmed" && result.hash === wallet[0].hash && result.scheduleId === wallet[0].scheduleId), "two OS workers share the same confirmed wallet payment and schedule");
    check(wallet.filter((result) => result.repeat).length === 1, "the second wallet worker recovers the durable result instead of signing again");
    check(await chain.getTransactionCount({ address: dev.accounts.buyer }) - beforeWalletNonce === 3, "exactly one creation, one approval and one execution were signed for the wallet key");
    const runs = await chain.getContractEvents({ address: EXECUTOR, abi: executorAbi, eventName: "RunExecuted", args: { id: BigInt(wallet[0].scheduleId!) }, fromBlock: origin, toBlock: "latest" });
    check(runs.length === 1 && runs[0].transactionHash === wallet[0].hash, "the actual fork contains exactly one RunExecuted payment for the shared wallet key");
    const walletProof = await dev.clients.seller.receipts.verify({ txHash: wallet[0].hash, from: dev.accounts.buyer, to: dev.accounts.seller, amount: "1", token: "USDT", scheduleId: wallet[0].scheduleId });
    check(walletProof.kind === "run" && walletProof.amount === 1_000_000n, "the wallet receipt independently proves the exact recipient amount");

    const treasury = createRemesso({ account: mnemonicToAccount(MNEMONIC, { addressIndex: 2 }), rpcUrl: dev.rpcUrl, functionsUrl: dev.functionsUrl,
      publicClient: chain, store: a.paymentStore, remittanceStore: a.remittanceStore, coordinator: a.coordinator, invoiceStore: a.invoiceStore });
    const policy = await treasury.policies.create({ agent: dev.accounts.buyer, token: "USDT", budget: "10", perPayment: "5", perDay: "10", days: 1, recipients: [dev.accounts.seller] });
    const signedWrites = await sqlA.unsafe("select nonce,hash,raw from remesso_sdk_transactions where namespace = $1 and scope = $2", [namespace, `42220:${dev.accounts.treasury.toLowerCase()}`]);
    check(signedWrites.length === 2 && signedWrites.every((row) => typeof row.raw === "string" && typeof row.hash === "string"), "generic coordinated approval and policy creation retain signed bytes before broadcast");
    const block = await chain.getBlock({ blockTag: "latest" });
    const signed = await dev.clients.seller.invoices.create({ payer: dev.accounts.treasury, amount: "1.25", token: "USDT", orderId: `shared-policy:${namespace}`,
      issuedAt: Math.min(Number(block.timestamp), Math.floor(Date.now() / 1000)), expiresAt: Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000)) + 600 });
    const invoice = await dev.clients.seller.invoices.verify(signed);
    const beforePolicyNonce = await chain.getTransactionCount({ address: dev.accounts.buyer });
    const paid = await runWorkers({ funding: "policy", invoice: signed, policyId: String(policy.id) });
    check(paid.every((result) => result.status === "confirmed" && result.hash === paid[0].hash && result.invoiceId === invoice.id), "two OS workers share one signed-invoice payment through the treasury policy");
    check(paid.filter((result) => result.repeat).length === 1, "the second policy worker recovers the existing durable payment");
    check(await chain.getTransactionCount({ address: dev.accounts.buyer }) - beforePolicyNonce === 1, "exactly one policy payment transaction was signed across both workers");
    const paidEvents = await chain.getContractEvents({ address: ALLOWANCE, abi: allowanceAbi, eventName: "Paid", args: { id: policy.id }, fromBlock: origin, toBlock: "latest" });
    check(paidEvents.length === 1 && paidEvents[0].transactionHash === paid[0].hash, "the actual fork contains exactly one Paid event for the shared signed invoice");
    const proof = await dev.clients.seller.invoices.verifyPayment(signed, { txHash: paid[0].hash, policyId: policy.id, finality: "included" });
    check(proof.invoiceId === invoice.id && proof.payment.amount === 1_250_000n, "the seller independently verifies the signed invoice and actual policy receipt");
    const status = await dev.clients.seller.requests.get(invoice.requestId!);
    check(status.payment?.state === "paid" && status.payment.txs.length === 1, "the request settles once from the exact policy reference");
    const reservation = await sqlA.unsafe("select reservation from remesso_sdk_invoices where namespace = $1 and invoice_id = $2", [namespace, invoice.id]);
    check(reservation.length === 1, "the signed invoice has one shared durable funding-route reservation");

    const identity = { eventId: proof.payment.eventId, invoiceId: proof.invoiceId, issuer: invoice.issuer, orderId: invoice.orderId };
    const fulfill = async (storage: typeof a) => await storage.inbox.processOnce(identity, async (tx) => {
      await tx.unsafe("insert into remesso_sdk_jobs(namespace,id,job_key,kind,payload) values($1,$2,$3,'deliver',$4::jsonb)",
        [namespace, crypto.randomUUID(), `deliver:${invoice.id}`, { invoiceId: invoice.id, eventId: proof.payment.eventId }]);
    });
    const fulfilled = await Promise.all([fulfill(a), fulfill(b)]);
    check(fulfilled.filter(Boolean).length === 1, "two recipients atomically fulfill the verified event and invoice once");
    check(await a.inbox.processOnce(identity, async () => { throw new Error("a duplicate delivery must never execute business work"); }) === false, "redelivering the verified receipt cannot fulfill the order twice");
    const jobs = await Promise.all([a.jobs.claim({ worker: "delivery-a", kinds: ["deliver"], leaseMs: 30_000 }), b.jobs.claim({ worker: "delivery-b", kinds: ["deliver"], leaseMs: 30_000 })]);
    check(jobs.filter(Boolean).length === 1, "the fulfillment outbox job can be claimed by only one worker");
    const claimed = jobs.find((job) => job)!;
    check(await a.jobs.ack(claimed.id, claimed.claimToken) && (await b.jobs.get(`deliver:${invoice.id}`))?.status === "completed", "the current job claim acknowledges durable delivery completion");
    console.log(`PASS ${checks.length} production-adapter integration checks; local fork/Postgres only, no mainnet writes.`);
  } finally {
    await Promise.all([...children].map(async (child) => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      await child.status;
    }));
    if (initialized) for (const table of tables) await sqlA.unsafe(`delete from remesso_sdk_${table} where namespace = $1`, [namespace]);
    await Promise.all([sqlA.end({ timeout: 2 }), sqlB.end({ timeout: 2 }), dev?.close()]);
    console.log("Cleaned only this run's random PostgreSQL namespace and owned development processes/files.");
  }
}

try { if (Deno.args[0] === "--worker") await worker(); else await main(); }
catch (error) { console.error((error as Error).stack ?? String(error)); Deno.exit(1); }
