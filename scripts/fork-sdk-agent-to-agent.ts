/// The actual SDK, backend functions, indexer and webhook worker together.
///
///   anvil --fork-url https://forno.celo.org --port 8546
///   supabase start -x studio,imgproxy,realtime,storage-api,logflare,vector,edge-runtime,mailpit,supavisor,postgres-meta
///   deno run --allow-all --config packages/remesso-sdk/deno.json --unstable-sloppy-imports scripts/fork-sdk-agent-to-agent.ts
///
/// Run against an idle LOCAL database/fork. Fresh wallets and isolated rows;
/// no truncation. Cursors and existing events' finality/sequence are restored.
/// All transaction RPCs must identify as Anvil on 127.0.0.1. Webhook transport
/// calls the SDK handler in memory; it NEVER calls an external endpoint.
/// This verifies fork settlement, not production cron, RPC finality or SSRF.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, parseAbi, parseTransaction, toFunctionSelector, toHex, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import {
  ALLOWANCE, createRemesso, EXECUTOR, executorAbi, REGISTRY, RemessoError, webhookHandler,
  type WebhookMessage,
} from "../packages/remesso-sdk/src/index.ts";
import { fileRemittanceStore, fileStore } from "../packages/remesso-sdk/src/node.ts";
import { handle as webhookApi } from "../supabase/functions/webhooks/handler.ts";
import { runDeliveries } from "../supabase/functions/deliver-webhooks/worker.ts";

const FORK = "http://127.0.0.1:8546";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
const POOL = "0x6519d56eb0a69fc0338657784c783b169b8f7d32" as const;
const nativeFetch = globalThis.fetch.bind(globalThis);
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const r = await nativeFetch(FORK, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const b = await r.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result as T;
}
if (!/anvil/i.test(await rpc<string>("web3_clientVersion"))) throw new Error("refusing: RPC is not local Anvil");
if (await rpc<string>("eth_chainId") !== "0xa4ec") throw new Error("refusing: fork must use Celo's chain id 42220");
const chain = createPublicClient({ chain: celo, transport: http(FORK), pollingInterval: 50 });

// A second process loads exactly the same durable payment file. Its only
// backend is the parent process's local HTTP dispatcher.
if (Deno.args.includes("--resume") || Deno.args.includes("--resume-wallet")) {
  const base = Deno.env.get("SDK_E2E_FUNCTIONS")!;
  if (new URL(base).hostname !== "127.0.0.1") throw new Error("refusing a nonlocal backend");
  const sdk = createRemesso({
    account: privateKeyToAccount(Deno.env.get("SDK_E2E_KEY")! as `0x${string}`),
    rpcUrl: FORK, publicClient: chain, functionsUrl: base,
    store: fileStore(Deno.env.get("SDK_E2E_STORE")!),
    remittanceStore: fileRemittanceStore(Deno.env.get("SDK_E2E_REMITTANCE_STORE")!),
  });
  const p = Deno.args.includes("--resume-wallet")
    ? await sdk.remittances.send(JSON.parse(Deno.env.get("SDK_E2E_INPUT")!))
    : await sdk.requests.pay(Deno.env.get("SDK_E2E_REQUEST")!);
  console.log(JSON.stringify({ status: p.status, repeat: p.repeat, hash: p.hash }));
  Deno.exit(0);
}

const statusRun = await new Deno.Command("supabase", { args: ["status", "-o", "json"], stderr: "null" }).output();
if (!statusRun.success) throw new Error("local Supabase is not running");
const status = JSON.parse(new TextDecoder().decode(statusRun.stdout));
if (status.API_URL !== "http://127.0.0.1:54321") throw new Error("refusing: Supabase API must be local :54321");
const sql = postgres("postgresql://postgres:postgres@127.0.0.1:54322/postgres", { onnotice() {} });
const db = createClient(status.API_URL, status.SERVICE_ROLE_KEY);
const contracts = [EXECUTOR.toLowerCase(), ALLOWANCE.toLowerCase()];
const originalCursors = await sql`select chain_id, contract, block_number, block_hash, updated_at::text from public.chain_cursors where chain_id = 42220 and contract in ${sql(contracts)} order by contract`;
if (originalCursors.length !== 2) throw new Error("apply local migrations first: both chain cursors are required");
const priorFinality = await sql`select chain_id, tx_hash, log_index, final, removed, seq from public.payment_events where chain_id = 42220 and contract in ${sql(contracts)}`;
const existingAnswers = await sql`select * from public.policy_payment_answers(100)`;
if (existingAnswers.length) throw new Error("refusing: existing request bindings need processing before this isolated test");

const allowedOrigins = new Set([FORK, status.API_URL]);
// A future accidental default endpoint cannot send money, contact production
// functions, or send a real webhook during this test.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  if (!allowedOrigins.has(u.origin)) throw new Error(`test blocked nonlocal fetch: ${u.origin}`);
  return nativeFetch(input, init);
}) as typeof fetch;

const temp = await Deno.makeTempDir({ prefix: "remesso-sdk-e2e-" });
const storePath = `${temp}/payments.json`;
const remittanceStorePath = `${temp}/remittances.json`;
const owner = privateKeyToAccount(generatePrivateKey());
const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const selfFundedKey = generatePrivateKey();
const selfFunded = privateKeyToAccount(selfFundedKey);
const receiver = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());
const requestIds: string[] = [];
let failures = 0, checks = 0, subscription = "", secret = "", previousSecret = "";
let server: Deno.HttpServer | undefined;
const check = (ok: boolean, label: string) => {
  checks++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) failures++;
};
const rejects = async (p: Promise<unknown>, code: string, label: string) => {
  try { await p; check(false, label); }
  catch (e) { check(e instanceof RemessoError && e.code === code, `${label}${e instanceof RemessoError ? ` (${e.code})` : ` (${String(e)})`}`); }
};
const erc20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const executor = parseAbi([
  "function executor() view returns (address)",
  "function executeRun(uint256 id, uint256 amountOutMinimum) returns (uint256)",
]);
const balance = () => chain.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [receiver.address] });
const ahead = async () => {
  const h = await chain.getBlock({ blockTag: "latest" });
  await rpc("evm_setNextBlockTimestamp", [Math.max(Number(h.timestamp) + 1, Math.floor(Date.now() / 1000) + 1)]);
};
const delivered: WebhookMessage[] = [];
const attempts: { id: string; timestamp: string; signature: string }[] = [];
const HOST = "https://hooks.remesso.test/sdk-a2a";
let failNext = false;
const receive = webhookHandler({
  recipient: receiver.address,
  secret: () => [secret, previousSecret].filter(Boolean),
  onPayment(message) {
    if (failNext) { failNext = false; throw new Error("test receiver temporarily unavailable"); }
    delivered.push(message);
  },
});
const transport = async (url: string, headers: Record<string, string>, body: string) => {
  if (url !== HOST) throw new Error("test refuses a webhook for any other endpoint");
  if (headers["webhook-id"]) attempts.push({ id: headers["webhook-id"], timestamp: headers["webhook-timestamp"], signature: headers["webhook-signature"] });
  const r = await receive(new Request(url, { method: "POST", headers, body }));
  return { status: r.status, text: await r.text() };
};

// Capture each real Deno function without running its HTTP listener. Only
// the SDK's fetch adapter chooses between these production handlers.
type Handler = (request: Request) => Response | Promise<Response>;
const handlers = new Map<string, Handler>();
async function capture(name: string) {
  const serve = Deno.serve;
  let handler: Handler | undefined;
  try {
    Object.defineProperty(Deno, "serve", { configurable: true, writable: true, value: (...args: unknown[]) => { handler = args.at(-1) as Handler; return {}; } });
    await import(`../supabase/functions/${name}/index.ts`);
  } finally {
    Object.defineProperty(Deno, "serve", { configurable: true, writable: true, value: serve });
  }
  if (!handler) throw new Error(`${name}: no Deno.serve handler captured`);
  handlers.set(name, handler);
}
async function dispatch(req: Request): Promise<Response> {
  const name = new URL(req.url).pathname.split("/").filter(Boolean).at(-1)!;
  if (name === "webhooks") return webhookApi(req, { db, verify: (a) => verifyTypedData(a), challenge: transport });
  const handler = handlers.get(name);
  if (!handler) throw new Error(`unknown local function: ${name}`);
  return await handler(req);
}
const sdkFetch = ((input: RequestInfo | URL, init?: RequestInit) => dispatch(new Request(input, init))) as typeof fetch;

// Filter both halves of the real worker: only this subscription is queued,
// and only its due messages are claimed. All other RPCs stay unmodified.
// The SQL below is claim_webhook_deliveries with one subscription predicate.
const workerDb = {
  from(table: string) {
    if (table === "webhook_subscriptions") return {
      select(columns: string) { return db.from(table).select(columns).eq("id", subscription); },
    };
    return db.from(table);
  },
  async rpc(name: string, args: Record<string, unknown>) {
    if (name !== "claim_webhook_deliveries") return await db.rpc(name, args);
    const rows = await sql`
      with due as (
        select d.id from public.webhook_deliveries d join public.webhook_subscriptions s on s.id = d.subscription_id
        where s.id = ${subscription} and s.state = 'active' and d.delivered_at is null and d.failed_at is null and d.next_attempt_at <= now()
        order by d.next_attempt_at limit ${Number(args.p_limit)} for update of d skip locked
      ), claimed as (
        update public.webhook_deliveries d set next_attempt_at = now() + make_interval(secs => ${Number(args.p_lease_seconds)})
        from due where d.id = due.id returning d.id, d.subscription_id, d.payload, d.attempts, d.window_started_at
      )
      select c.id, s.url, array_remove(array[cur.decrypted_secret, case when s.previous_until > now() then prev.decrypted_secret end], null) as secrets,
        c.payload, c.attempts, c.window_started_at
      from claimed c join public.webhook_subscriptions s on s.id = c.subscription_id
      left join vault.decrypted_secrets cur on cur.id = s.secret_id
      left join vault.decrypted_secrets prev on prev.id = s.previous_secret_id`;
    return { data: rows, error: null };
  },
} as unknown as SupabaseClient;
const deliver = () => runDeliveries(workerDb, transport);

try {
  Deno.env.set("SUPABASE_URL", status.API_URL);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY);
  Deno.env.set("CELO_RPC_URL", FORK);
  Deno.env.set("REMESSO_EXECUTOR_ADDRESS", EXECUTOR);
  for (const name of ["request-payment", "payment-events", "index-events"]) await capture(name);
  server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, dispatch);
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  allowedOrigins.add(base);
  const options = { rpcUrl: FORK, publicClient: chain, functionsUrl: base, fetch: sdkFetch };
  const payer = createRemesso({ ...options, account: owner, remittanceStore: fileRemittanceStore(remittanceStorePath) });
  const payee = createRemesso({ ...options, account: receiver });
  const asAgent = createRemesso({ ...options, account: agent, store: fileStore(storePath), remittanceStore: fileRemittanceStore(remittanceStorePath) });
  const asSelfFunded = createRemesso({ ...options, account: selfFunded, store: fileStore(storePath), remittanceStore: fileRemittanceStore(remittanceStorePath) });
  const asOutsider = createRemesso({ ...options, account: outsider });
  const index = async () => {
    const r = await dispatch(new Request(`${base}/index-events`, { method: "POST" }));
    const b = await r.json();
    if (!r.ok || b.results?.some((s: { error?: string; halted?: string }) => s.error || s.halted)) throw new Error(`index failed: ${JSON.stringify(b)}`);
    return b;
  };
  await rpc("evm_setAutomine", [true]);
  for (const a of [owner.address, agent.address, outsider.address, selfFunded.address, receiver.address, POOL]) await rpc("anvil_setBalance", [a, toHex(10n ** 19n)]);
  await rpc("anvil_impersonateAccount", [POOL]);
  try {
    const hash = await rpc<`0x${string}`>("eth_sendTransaction", [{ from: POOL, to: USDT, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [owner.address, 20_000_000n] }) }]);
    if ((await chain.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("funding failed");
    const selfFund = await rpc<`0x${string}`>("eth_sendTransaction", [{ from: POOL, to: USDT, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [selfFunded.address, 5_000_000n] }) }]);
    if ((await chain.waitForTransactionReceipt({ hash: selfFund })).status !== "success") throw new Error("self-funded wallet funding failed");
  } finally { await rpc("anvil_stopImpersonatingAccount", [POOL]); }
  const start = await chain.getBlock({ blockTag: "latest" });
  await sql`update public.chain_cursors set block_number = ${start.number.toString()}, block_hash = ${start.hash} where chain_id = 42220 and contract in ${sql(contracts)}`;

  console.log("1. SDK policy, request inbox, payment and process restart");
  const policy = await payer.policies.create({ agent: agent.address, token: "USDT", perPayment: "0.10", perDay: "0.30", days: 1, budget: "0.30", recipients: [receiver.address] });
  check((await asAgent.policies.get(policy.id)).spendable === 100_000n, "SDK creates a funded policy with enforceable payment cap");
  await index();
  check((await asAgent.policies.find()).includes(policy.id), "SDK discovers its indexed policy through the actual payment-events handler");
  const sub = await payee.webhooks.subscribe({ url: HOST });
  subscription = sub.subscription; secret = sub.secret;
  check(sub.state === "active" && secret.startsWith("whsec_"), "SDK subscribes through real signed webhook API and SDK challenge handler");

  const request = await payee.requests.create({ payer: owner.address, amount: "0.02", token: "USDT", from: "SDK receiver agent", note: "isolated fork integration" });
  requestIds.push(request.id);
  check((await asAgent.requests.list(owner.address)).some((r) => r.id === request.id), "SDK lists the invoice in the policy owner's inbox");
  await rejects(asOutsider.requests.pay(request.id), "refused", "an unrelated agent cannot pay from someone else's policy");
  await ahead();
  const before = await balance();
  const paid = await asAgent.requests.pay(request.id);
  check(paid.status === "confirmed" && await balance() - before === 20_000n, "SDK requests.pay sends exactly the requested net USDT amount");
  const policyProof = await payee.receipts.verify({ txHash: paid.hash, from: owner.address, to: receiver.address, token: "USDT", amount: "0.02", policyId: policy.id, memo: request.reference, finality: "included" });
  check(policyProof.kind === "policy_payment" && policyProof.policyId === policy.id && policyProof.agent.toLowerCase() === agent.address.toLowerCase() && policyProof.amount === 20_000n && policyProof.callerVerified, "receiver independently verifies actual policy payment, payer, token, amount, agent and invoice memo");
  await rejects(payee.receipts.verify({ txHash: paid.hash, from: owner.address, to: receiver.address, token: "USDT", amount: "0.03", policyId: policy.id, finality: "included" }), "conflict", "a successful transaction is refused as proof for a different invoice amount");
  await rejects(payee.receipts.verify({ txHash: paid.hash, from: agent.address, to: receiver.address, token: "USDT", amount: "0.02", policyId: policy.id, finality: "included" }), "conflict", "payment evidence identifies the funding treasury rather than treating the executing agent as payer");
  await rejects(payee.receipts.verify({ txHash: paid.hash, from: owner.address, to: receiver.address, token: "USDT", amount: "0.02", policyId: policy.id, memo: "unrelated-invoice", finality: "included" }), "conflict", "payment evidence cannot be reused for a different invoice reference");
  check((await payee.requests.get(request.id)).payment === null, "a chain payment is not reported paid until the indexer records its evidence");
  const indexed = await index();
  check(indexed.requestsBound === 1, "actual index-events binds the Paid memo to exactly one request");
  const settled = await payee.requests.waitUntilPaid(request.id, { timeoutMs: 1000, intervalMs: 25 });
  check(settled.status === "accepted" && settled.payment?.txs[0]?.txHash === paid.hash, "SDK waitUntilPaid returns the bound transaction from the actual backend");
  const events = await payee.events.list({ role: "to", kinds: ["policy_payment"] });
  check(events.events.some((e) => e.memoText === request.reference && e.agent === agent.address.toLowerCase() && e.amount === "20000"), "SDK event reads preserve request reference, agent identity and base-unit amount");
  const nonce = await chain.getTransactionCount({ address: agent.address });
  const restart = await new Deno.Command("deno", {
    args: ["run", "--allow-all", "--config", "packages/remesso-sdk/deno.json", "--unstable-sloppy-imports", "scripts/fork-sdk-agent-to-agent.ts", "--resume"],
    env: { SDK_E2E_FUNCTIONS: base, SDK_E2E_KEY: agentKey, SDK_E2E_STORE: storePath, SDK_E2E_REMITTANCE_STORE: remittanceStorePath, SDK_E2E_REQUEST: request.id },
    stdout: "piped", stderr: "piped",
  }).output();
  if (!restart.success) throw new Error(`restart failed: ${new TextDecoder().decode(restart.stderr).slice(0, 800)}`);
  const resumed = JSON.parse(new TextDecoder().decode(restart.stdout).trim());
  check(resumed.repeat === true && resumed.hash === paid.hash && await balance() === before + 20_000n && await chain.getTransactionCount({ address: agent.address }) === nonce, "a fresh process reloads fileStore and reuses the same invoice transaction without another send");
  const emptyStoreAgent = createRemesso({ ...options, account: agent });
  await rejects(emptyStoreAgent.requests.pay(request.id), "refused", "an already indexed paid request cannot be paid by a new empty store");

  console.log("\n2. Actual webhook worker, retry, secret rotation and revoke");
  failNext = true;
  const first = await deliver();
  check(first.queued === 1 && first.retrying === 1 && delivered.length === 0, "worker queues the indexed agent payment; receiver failure schedules a retry");
  await sql`update public.webhook_deliveries set next_attempt_at = now() where subscription_id = ${subscription} and delivered_at is null`;
  await new Promise((r) => setTimeout(r, 1100));
  const second = await deliver();
  check(second.delivered === 1 && delivered.length === 1 && delivered[0].data.memoText === request.reference, "worker's signed retry is verified and parsed by SDK webhookHandler");
  const tries = attempts.filter((a) => a.id === delivered[0]?.id);
  check(tries.length === 2 && tries[0].id === tries[1].id && tries[0].timestamp !== tries[1].timestamp && tries[0].signature !== tries[1].signature, "retry has stable delivery id and fresh timestamp/signature");
  previousSecret = secret;
  secret = (await payee.webhooks.rotate({ url: HOST })).secret;
  check(secret !== previousSecret, "SDK rotates subscription secret through the actual API");

  const treasuryRequest = await payee.requests.create({ payer: owner.address, amount: "0.01", token: "USDT" });
  requestIds.push(treasuryRequest.id);
  await ahead();
  const treasuryBefore = await balance();
  const treasury = await asAgent.remittances.send({ funding: "policy", to: receiver.address, amount: "0.01", token: "USDT", policyId: policy.id, requestId: treasuryRequest.id, idempotencyKey: "treasury-platform-invoice" });
  check(treasury.funding === "policy" && treasury.status === "confirmed" && treasury.payer.toLowerCase() === owner.address.toLowerCase() && await balance() - treasuryBefore === 10_000n, "platform remittances.send pays exact invoice amount from the explicitly selected treasury policy");
  await index();
  check((await payee.requests.waitUntilPaid(treasuryRequest.id, { timeoutMs: 1000, intervalMs: 10 })).payment?.txs[0]?.txHash === treasury.hash, "platform policy send carries request reference and binds to its invoice");

  const registry = parseAbi([
    "function register(string agentURI) returns (uint256 agentId)",
    "function getAgentWallet(uint256 agentId) view returns (address)",
    "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  ]);
  const profile = "data:application/json," + encodeURIComponent(JSON.stringify({ name: "isolated SDK receiver", services: [{ name: "remesso", version: "1", assets: [{ network: "eip155:42220", asset: USDT }], reference: { required: true } }] }));
  const registration = await chain.simulateContract({ address: REGISTRY, abi: registry, functionName: "register", args: [profile], account: receiver });
  const receiverWallet = createWalletClient({ chain: celo, transport: http(FORK), account: receiver });
  const registerHash = await receiverWallet.writeContract(registration.request);
  if ((await chain.waitForTransactionReceipt({ hash: registerHash })).status !== "success") throw new Error("fork agent registration failed");
  const agentId = registration.result;
  if ((await chain.readContract({ address: REGISTRY, abi: registry, functionName: "getAgentWallet", args: [agentId] })).toLowerCase() !== receiver.address.toLowerCase()) {
    const deadline = (await chain.getBlock()).timestamp + 240n;
    const signature = await receiver.signTypedData({
      domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: celo.id, verifyingContract: REGISTRY },
      types: { AgentWalletSet: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
      primaryType: "AgentWalletSet", message: { agentId, newWallet: receiver.address, owner: receiver.address, deadline },
    });
    const walletHash = await receiverWallet.writeContract({ address: REGISTRY, abi: registry, functionName: "setAgentWallet", args: [agentId, receiver.address, deadline, signature] });
    if ((await chain.waitForTransactionReceipt({ hash: walletHash })).status !== "success") throw new Error("fork agent wallet registration failed");
  }
  const found = await asAgent.agents.find(agentId);
  check(found.wallet?.toLowerCase() === receiver.address.toLowerCase() && found.profile?.reference?.required === true, "SDK resolves a newly registered fork agent's verified wallet and inline payment profile");
  await rejects(asAgent.agents.pay(agentId, { funding: "policy", policyId: policy.id, amount: "0.01", token: "USDT", idempotencyKey: "missing-required-reference" }), "refused", "registry-aware agent pay enforces the receiving agent's required invoice reference");
  const registryRequest = await payee.requests.create({ payer: owner.address, amount: "0.01", token: "USDT" });
  requestIds.push(registryRequest.id);
  await rejects(asAgent.agents.pay(agentId, { funding: "policy", policyId: policy.id, requestId: registryRequest.id, expectedWallet: outsider.address }), "conflict", "registry-aware pay refuses a wallet that differs from the developer's approved recipient");
  await ahead();
  const registryBefore = await balance();
  const registryPaid = await asAgent.agents.pay(agentId, { funding: "policy", policyId: policy.id, requestId: registryRequest.id, expectedWallet: receiver.address });
  check(registryPaid.status === "confirmed" && registryPaid.counterparty.agentId === agentId && registryPaid.counterparty.wallet.toLowerCase() === receiver.address.toLowerCase() && await balance() - registryBefore === 10_000n, "SDK agent-to-agent pay resolves the registered wallet, infers invoice terms and settles treasury funds");
  await index();
  check((await payee.requests.waitUntilPaid(registryRequest.id, { timeoutMs: 1000, intervalMs: 10 })).payment?.txs[0]?.txHash === registryPaid.hash, "registry-aware agent payment binds to the receiving agent's invoice");

  console.log("\n3. SDK schedule answers invoice; actual executor settles it");
  const scheduledRequest = await payee.requests.create({ payer: owner.address, amount: "1", token: "USDT", every: "week", runs: 1 });
  requestIds.push(scheduledRequest.id);
  await ahead();
  const scheduled = await payer.schedules.create({ request: scheduledRequest.id });
  check(scheduled.request != null && "status" in scheduled.request && scheduled.request.status === "accepted" && scheduled.recipientGets === 1_000_000n, "SDK creates fee-adjusted schedule and binds it to request through actual answer handler");
  const waiting = await payee.requests.get(scheduledRequest.id);
  check(waiting.payment?.state === "scheduled" && waiting.payment.txs.length === 0, "accepted schedule remains scheduled until a RunExecuted transaction exists");
  await rejects(payee.requests.waitUntilPaid(scheduledRequest.id, { timeoutMs: 20, intervalMs: 10 }), "timeout", "waitUntilPaid does not treat accepted/scheduled as paid");
  const executorAddress = await chain.readContract({ address: EXECUTOR, abi: executor, functionName: "executor" });
  await rpc("anvil_setBalance", [executorAddress, toHex(10n ** 19n)]);
  await rpc("anvil_impersonateAccount", [executorAddress]);
  const beforeRun = await balance();
  try {
    const run = await rpc<`0x${string}`>("eth_sendTransaction", [{ from: executorAddress, to: EXECUTOR, data: encodeFunctionData({ abi: executor, functionName: "executeRun", args: [scheduled.id, 0n] }) }]);
    check((await chain.waitForTransactionReceipt({ hash: run })).status === "success" && await balance() - beforeRun === 1_000_000n, "actual V5 executeRun pays exactly the requested net amount after commission");
  } finally { await rpc("anvil_stopImpersonatingAccount", [executorAddress]); }
  await index();
  const schedulePaid = await payee.requests.waitUntilPaid(scheduledRequest.id, { timeoutMs: 1000, intervalMs: 10 });
  check(schedulePaid.payment?.state === "paid" && schedulePaid.payment.txs[0]?.amount === "1000000", "indexed schedule execution makes SDK waitUntilPaid return actual net settlement");
  const scheduleProof = await payee.receipts.verify({ txHash: schedulePaid.payment!.txs[0].txHash, from: owner.address, to: receiver.address, token: "USDT", amount: "1", scheduleId: scheduled.id, finality: "included" });
  check(scheduleProof.kind === "run" && scheduleProof.scheduleId === scheduled.id && scheduleProof.amount === 1_000_000n && scheduleProof.amountIn === scheduled.amountIn && scheduleProof.runNumber === 1, "receiver independently verifies actual schedule's net settlement and pinned gross amount");
  const oldCount = delivered.length;
  await deliver();
  check(delivered.length > oldCount && delivered.some((m) => m.data.schedule === String(scheduled.id) && m.data.amount === "1000000"), "rotated-secret SDK handler receives actual scheduled payment as well as policy payments");

  console.log("\n4. Self-funded agent remittance and durable process restart");
  const walletRequest = await payee.requests.create({ payer: selfFunded.address, amount: "1", token: "USDT" });
  requestIds.push(walletRequest.id);
  const walletInput = { funding: "wallet" as const, to: receiver.address, amount: "1", token: "USDT", idempotencyKey: "self-funded-platform-invoice", requestId: walletRequest.id };
  const schedulesBefore = await asSelfFunded.schedules.list();
  check((await asSelfFunded.policies.find()).length === 0, "self-funded agent has no treasury spending policy");
  const walletBefore = await balance();
  await ahead();
  const walletPayment = await asSelfFunded.remittances.send(walletInput);
  check(walletPayment.funding === "wallet" && walletPayment.status === "confirmed" && await balance() - walletBefore === 1_000_000n, "self-funded agent wallet sends exact net1USDT through one-shot V5 remittance");
  if (!walletPayment.hash) throw new Error("confirmed wallet remittance has no settlement hash");
  const walletSchedules = (await asSelfFunded.schedules.list()).filter((id) => !schedulesBefore.includes(id));
  check(walletSchedules.length === 1, "self-funded remittance creates exactly one durable one-shot schedule");
  const walletSchedule = await asSelfFunded.schedules.get(walletSchedules[0]);
  check(walletSchedule.maxRuns === 1 && walletSchedule.runsExecuted === 1 && walletSchedule.sender.toLowerCase() === selfFunded.address.toLowerCase(), "wallet funds its own completed schedule with one authorized run");
  const walletProof = await payee.receipts.verify({ txHash: walletPayment.hash, from: selfFunded.address, to: receiver.address, token: "USDT", amount: "1", scheduleId: walletSchedules[0], finality: "included" });
  check(walletProof.kind === "run" && walletProof.amount === 1_000_000n && walletProof.scheduleId === walletSchedules[0], "receiver independently verifies wallet-funded on-chain settlement");
  await index();
  const walletStatus = await payee.requests.waitUntilPaid(walletRequest.id, { timeoutMs: 1000, intervalMs: 10 });
  check(walletStatus.payment?.state === "paid" && walletStatus.payment.txs[0]?.txHash === walletPayment.hash, "self-funded request is bound and indexed as paid with its actual settlement transaction");
  const walletEvents = await payee.events.list({ role: "to", kinds: ["run"] });
  check(walletEvents.events.some((e) => e.refId === String(walletSchedules[0]) && e.from === selfFunded.address.toLowerCase() && e.amount === "1000000" && e.early === true), "receiver discovers sender-triggered self-funded remittance through indexed payment-events");
  const walletHitsBefore = delivered.length;
  await deliver();
  check(delivered.length > walletHitsBefore && delivered.some((m) => m.data.schedule === String(walletSchedules[0]) && m.data.txHash === walletPayment.hash), "self-funded remittance reaches the receiver's verified SDK webhook handler");
  const walletNonce = await chain.getTransactionCount({ address: selfFunded.address });
  const walletRestart = await new Deno.Command("deno", {
    args: ["run", "--allow-all", "--config", "packages/remesso-sdk/deno.json", "--unstable-sloppy-imports", "scripts/fork-sdk-agent-to-agent.ts", "--resume-wallet"],
    env: { SDK_E2E_FUNCTIONS: base, SDK_E2E_KEY: selfFundedKey, SDK_E2E_STORE: storePath, SDK_E2E_REMITTANCE_STORE: remittanceStorePath, SDK_E2E_INPUT: JSON.stringify(walletInput) },
    stdout: "piped", stderr: "piped",
  }).output();
  if (!walletRestart.success) throw new Error(`wallet restart failed: ${new TextDecoder().decode(walletRestart.stderr).slice(0, 800)}`);
  const walletResumed = JSON.parse(new TextDecoder().decode(walletRestart.stdout).trim());
  check(walletResumed.repeat === true && walletResumed.hash === walletPayment.hash && await balance() === walletBefore + 1_000_000n && await chain.getTransactionCount({ address: selfFunded.address }) === walletNonce && (await asSelfFunded.schedules.list()).length === schedulesBefore.length + 1, "fresh process reloads wallet remittance store and retries without a new schedule or payment");
  await rejects(asSelfFunded.remittances.send({ ...walletInput, amount: "2", requestId: undefined }), "key_reused", "wallet remittance refuses reuse of invoice key for a different amount");

  const interruptedRequest = await payee.requests.create({ payer: selfFunded.address, amount: "1", token: "USDT" });
  requestIds.push(interruptedRequest.id);
  const interruptedInput = { ...walletInput, requestId: interruptedRequest.id, idempotencyKey: "wallet-lost-creation" };
  const createSelector = toFunctionSelector(executorAbi.find((a) => a.type === "function" && a.name === "createSchedule")!);
  let creationDropped = false;
  const interruptedClient = createPublicClient({ chain: celo, pollingInterval: 50, transport: custom({ request: async ({ method, params }) => {
    if (method === "eth_sendRawTransaction") {
      const transaction = parseTransaction((params as [`0x${string}`])[0]);
      // Every broadcast of the creation from this client is lost, the SDK's
      // own retries included, as when the process dies after recording it.
      if (transaction.to?.toLowerCase() === EXECUTOR.toLowerCase() && transaction.data?.startsWith(createSelector)) {
        creationDropped = true;
        throw new Error("test dropped the signed creation before Anvil received it");
      }
    }
    return await rpc(method, params as unknown[]);
  } }) });
  const interruptedAgent = createRemesso({ ...options, account: selfFunded, publicClient: interruptedClient, store: fileStore(storePath), remittanceStore: fileRemittanceStore(remittanceStorePath) });
  const schedulesBeforeDrop = await asSelfFunded.schedules.list();
  const balanceBeforeDrop = await balance();
  await ahead();
  const interruptedPayment = await interruptedAgent.remittances.send({ ...interruptedInput, waitMs: 5000 });
  const retained = JSON.parse(await Deno.readTextFile(remittanceStorePath)).remittances.find((r: { key: string }) => r.key === interruptedInput.idempotencyKey);
  check(creationDropped && interruptedPayment.status === "pending" && retained?.creation?.raw && !retained.approval && !retained.execution && await balance() === balanceBeforeDrop && (await asSelfFunded.schedules.list()).length === schedulesBeforeDrop.length, "lost creation broadcast keeps signed journal without granting approval, creating a schedule or claiming payment");
  const interruptedRestart = await new Deno.Command("deno", {
    args: ["run", "--allow-all", "--config", "packages/remesso-sdk/deno.json", "--unstable-sloppy-imports", "scripts/fork-sdk-agent-to-agent.ts", "--resume-wallet"],
    env: { SDK_E2E_FUNCTIONS: base, SDK_E2E_KEY: selfFundedKey, SDK_E2E_STORE: storePath, SDK_E2E_REMITTANCE_STORE: remittanceStorePath, SDK_E2E_INPUT: JSON.stringify(interruptedInput) },
    stdout: "piped", stderr: "piped",
  }).output();
  if (!interruptedRestart.success) throw new Error(`interrupted wallet restart failed: ${new TextDecoder().decode(interruptedRestart.stderr).slice(0, 800)}`);
  const interruptedResumed = JSON.parse(new TextDecoder().decode(interruptedRestart.stdout).trim());
  check(interruptedResumed.status === "confirmed" && interruptedResumed.repeat === true && await balance() - balanceBeforeDrop === 1_000_000n && (await asSelfFunded.schedules.list()).length === schedulesBeforeDrop.length + 1, "fresh process recovers lost wallet creation into exactly one schedule and one net payment");
  const recoveredJournal = JSON.parse(await Deno.readTextFile(remittanceStorePath)).remittances.find((r: { key: string }) => r.key === interruptedInput.idempotencyKey);
  check(recoveredJournal.creation.hash === retained.creation.hash && recoveredJournal.creation.raw === retained.creation.raw && recoveredJournal.scheduleId && recoveredJournal.paymentHash === interruptedResumed.hash, "wallet recovery preserves original signed creation bytes and records that same schedule's settlement");
  await index();
  check((await payee.requests.waitUntilPaid(interruptedRequest.id, { timeoutMs: 1000, intervalMs: 10 })).payment?.txs[0]?.txHash === interruptedResumed.hash, "recovered wallet remittance binds its original invoice to actual settlement evidence");

  await payee.webhooks.revoke({ url: HOST });
  const [subRow] = await sql`select state from public.webhook_subscriptions where id = ${subscription}`;
  check(subRow.state === "revoked", "SDK revokes the receiving subscription");

  console.log("\n5. Request decline and policy revocation");
  const declined = await payee.requests.create({ payer: owner.address, amount: "0.01", token: "USDT" });
  requestIds.push(declined.id);
  await asAgent.requests.decline(declined.id, { policyId: policy.id });
  check((await payee.requests.get(declined.id)).status === "declined", "SDK agent declines using a live policy and its typed-data signature");
  await rejects(asAgent.requests.pay(declined.id), "refused", "a declined request is not paid");
  await payer.policies.revoke(policy.id);
  check((await asAgent.policies.get(policy.id)).revoked, "SDK owner revokes the agent policy on-chain");
  await rejects(asAgent.pay({ to: receiver.address, amount: "0.01", policyId: policy.id, idempotencyKey: "after-revoke" }), "refused", "a revoked policy cannot send a new payment");

  // Record-before-broadcast recovery uses the same durable store, and a new
  // SDK instance to rebroadcast the original signed bytes after a lost send.
  console.log("\n6. Durable pending transaction recovery");
  const recoverPolicy = await payer.policies.create({ agent: agent.address, token: "USDT", perPayment: "0.10", perDay: "0.20", days: 1, budget: "0.20", recipients: [receiver.address] });
  const recovery = await payee.requests.create({ payer: owner.address, amount: "0.01", token: "USDT" });
  requestIds.push(recovery.id);
  // Every broadcast from this client is lost, the SDK's own retries included.
  const flaky = createPublicClient({ chain: celo, pollingInterval: 50, transport: custom({ request: async ({ method, params }) => {
    if (method === "eth_sendRawTransaction") throw new Error("test dropped broadcast before RPC");
    return await rpc(method, params as unknown[]);
  } }) });
  const lossy = createRemesso({ ...options, account: agent, publicClient: flaky, store: fileStore(storePath) });
  const beforeRecovery = await balance();
  await ahead();
  const pending = await lossy.requests.pay(recovery.id, { policyId: recoverPolicy.id, waitMs: 100 });
  check(pending.status === "pending" && await balance() === beforeRecovery, "a lost broadcast persists the signed transaction without falsely claiming payment");
  const restored = createRemesso({ ...options, account: agent, store: fileStore(storePath) });
  const recovered = await restored.requests.pay(recovery.id, { policyId: recoverPolicy.id });
  check(recovered.status === "confirmed" && recovered.hash === pending.hash && await balance() - beforeRecovery === 10_000n, "new SDK instance rebroadcasts the durable signed transaction and pays once");
  await index();
  check((await payee.requests.waitUntilPaid(recovery.id, { timeoutMs: 1000, intervalMs: 10 })).payment?.txs[0]?.txHash === recovered.hash, "recovered payment also binds to its request and becomes observable");
  const afterRevokeHits = delivered.length;
  await deliver();
  check(delivered.length === afterRevokeHits, "revoked subscription receives no later payment");
  await payer.policies.revoke(recoverPolicy.id);
} finally {
  await server?.shutdown();
  // Delete only this test's rows. Revocation removes Vault secrets through
  // the real RPC before deleting subscriptions/nonces.
  if (subscription) await db.rpc("revoke_webhook_subscription", { p_address: receiver.address.toLowerCase(), p_url: HOST });
  await sql`delete from public.webhook_deliveries where subscription_id in (select id from public.webhook_subscriptions where address = ${receiver.address.toLowerCase()})`;
  await sql`delete from public.webhook_subscriptions where address = ${receiver.address.toLowerCase()}`;
  await sql`delete from public.webhook_nonces where address = ${receiver.address.toLowerCase()}`;
  if (requestIds.length) await sql`delete from public.payment_requests where id in ${sql(requestIds)}`;
  await sql`delete from public.payment_events where chain_id = 42220 and (from_address = ${owner.address.toLowerCase()} or agent = ${agent.address.toLowerCase()} or from_address = ${selfFunded.address.toLowerCase()})`;
  for (const c of originalCursors) await sql`update public.chain_cursors set block_number = ${c.block_number}, block_hash = ${c.block_hash}, updated_at = ${c.updated_at} where chain_id = ${c.chain_id} and contract = ${c.contract}`;
  for (const e of priorFinality) await sql`update public.payment_events set final = ${e.final}, removed = ${e.removed}, seq = ${e.seq} where chain_id = ${e.chain_id} and tx_hash = ${e.tx_hash} and log_index = ${e.log_index}`;
  const [{ events, requests }] = await sql`select (select count(*)::int from public.payment_events where chain_id = 42220 and contract in ${sql(contracts)}) as events, (select count(*)::int from public.payment_requests where payer_address in ${sql([owner.address.toLowerCase(), selfFunded.address.toLowerCase()])}) as requests`;
  check(events === priorFinality.length && requests === 0, "cleanup preserves existing event rows and removes only this test's requests/events");
  const restoredCursors = await sql`select chain_id, contract, block_number, block_hash, updated_at::text from public.chain_cursors where chain_id = 42220 and contract in ${sql(contracts)} order by contract`;
  check(JSON.stringify(restoredCursors) === JSON.stringify(originalCursors), "cleanup restores both indexer cursors exactly, including original timestamps");
  await sql.end();
  globalThis.fetch = nativeFetch;
  await Deno.remove(temp, { recursive: true });
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `; ${failures} failed` : ""}`);
console.log("Coverage boundary: local handlers + fork contracts; production scheduling, economic finality, swap/offramp rails and public webhook networking are not exercised.");
Deno.exit(failures ? 1 : 0);
