/// Regressions from the 2026-10-26 review of 0.3.0-rc.1. Each test is a
/// scenario that paid twice, stalled a signer, or reported a payment wrongly
/// before its fix.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbi, toHex,
  type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { parseTransaction, serializeTransaction } from "viem/celo";
import { allowanceAbi, erc20Abi, executorAbi } from "../src/abi.ts";
import { createRemesso } from "../src/client.ts";
import { makeCtx, receiptOf } from "../src/context.ts";
import { ALLOWANCE, EXECUTOR, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import { makeLifecycle } from "../src/lifecycle.ts";
import { makePay, memo32, paymentScope, type PayInput, type PaymentResult } from "../src/payments.ts";
import type { Policies, Policy } from "../src/policies.ts";
import { makeRemittances } from "../src/remittances.ts";
import { memoryRemittanceStore, type RemittanceRecord, type RemittanceStore } from "../src/remittance-store.ts";
import { makeRequests, type Requests, type RequestStatus } from "../src/requests.ts";
import type { Receipts } from "../src/receipts.ts";
import { managedSigner } from "../src/signers.ts";
import { memoryStore, type PaymentStore } from "../src/store.ts";
import { makeWalletRemittances, remittanceScope } from "../src/wallet-remittances.ts";

const agent = privateKeyToAccount(toHex(31337, { size: 32 }));
const owner = getAddress("0x000000000000000000000000000000000000cafe");
const recipient = privateKeyToAccount(toHex(31338, { size: 32 })).address;
const usd = token("USDT");
const blockHash = toHex(77, { size: 32 });
const endpoints = { requestPayment: "https://remesso.test/request-payment", paymentEvents: "https://remesso.test/payment-events", webhooks: "https://remesso.test/webhooks" };
const now = () => Math.floor(Date.now() / 1000);
const approvalAbi = parseAbi(["event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const lower = (v: unknown) => String(v).toLowerCase();

function logJson(hash: Hex, address: Address, topics: readonly Hex[], data: Hex) {
  return { address, topics, data, transactionHash: hash, transactionIndex: "0x0", logIndex: "0x0", blockHash, blockNumber: "0x64", removed: false };
}
function receiptJson(hash: Hex, logs: unknown[], options: { status?: "0x1" | "0x0"; to?: Address; block?: bigint } = {}) {
  return { transactionHash: hash, transactionIndex: "0x0", blockHash, blockNumber: toHex(options.block ?? 100n), from: agent.address, to: options.to ?? EXECUTOR,
    cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs, logsBloom: `0x${"00".repeat(256)}`,
    status: options.status ?? "0x1", type: "0x2" };
}
function txJson(hash: string, block: bigint | null) {
  return { hash, blockHash: block === null ? null : blockHash, blockNumber: block === null ? null : toHex(block), transactionIndex: block === null ? null : "0x0",
    from: agent.address, to: EXECUTOR, nonce: "0x0", value: "0x0", gas: "0x5208", gasPrice: "0x1", input: "0x", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0xa4ec" };
}
const paidLog = (hash: Hex, memo: Hex) => logJson(hash, ALLOWANCE, encodeEventTopics({ abi: allowanceAbi, eventName: "Paid", args: { id: 7n, to: recipient } }) as Hex[],
  encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [1_000_000n, memo]));
const createdLog = (hash: Hex, expiresAt: bigint) => logJson(hash, EXECUTOR, encodeEventTopics({ abi: executorAbi, eventName: "ScheduleCreated", args: { id: 7n, sender: agent.address, destination: recipient } }) as Hex[],
  encodeAbiParameters([{ type: "uint128" }, { type: "uint64" }, { type: "uint96" }, { type: "uint32" }, { type: "uint64" }, { type: "uint8" }], [1_002_507n, 3600n, 0n, 1, expiresAt, 2]));
const approvedLog = (hash: Hex, amount: bigint) => logJson(hash, usd.address as Address, encodeEventTopics({ abi: approvalAbi, eventName: "Approval", args: { owner: agent.address, spender: EXECUTOR } }) as Hex[],
  encodeAbiParameters([{ type: "uint256" }], [amount]));
const runLog = (hash: Hex) => logJson(hash, EXECUTOR, encodeEventTopics({ abi: executorAbi, eventName: "RunExecuted", args: { id: 7n, sender: agent.address, destination: recipient } }) as Hex[],
  encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint32" }, { type: "uint64" }], [1_002_507n, 1_000_000n, 1, 0n]));
const cancelledLog = (hash: Hex) => logJson(hash, EXECUTOR, encodeEventTopics({ abi: executorAbi, eventName: "ScheduleCancelled", args: { id: 7n } }) as Hex[], "0x");

/// A chain that records every broadcast and every transaction the SDK prepares.
function chain() {
  const state = {
    latest: 0, pending: 0, countFails: false, head: 100n,
    receipts: new Map<string, Record<string, unknown>>(),
    mined: new Map<string, bigint>(),
    blockReceipts: new Map<string, Record<string, unknown>[]>(),
    sent: [] as Hex[],
    prepared: [] as { to?: Address; data?: Hex; nonce?: number }[],
    simulate: (_functionName: string) => {},
    schedule: { sender: agent.address, destination: recipient, token: usd.address, amountIn: 1_002_507n, interval: 3600n, maxRuns: 1, payoutType: 2, feeBps: 25,
      runsExecuted: 0, active: true, cancelled: false, expiresAt: BigInt(now() + 80_000) },
    allowance: 0n,
    runs: [] as unknown[],
    /// How many reads pinned to a block reach a node that hasn't got it yet.
    behind: 0,
  };
  const pub = createPublicClient({ chain: celo, transport: custom({ request: async ({ method, params }) => {
    const p = params as unknown[];
    switch (method) {
      case "eth_chainId": return "0xa4ec";
      case "eth_getTransactionCount":
        if (state.countFails) throw new Error("429 Too Many Requests");
        return toHex(p[1] === "pending" ? Math.max(state.pending, state.latest) : state.latest);
      case "eth_getTransactionReceipt": return state.receipts.get(lower(p[0])) ?? null;
      case "eth_getTransactionByHash": return state.mined.has(lower(p[0])) ? txJson(lower(p[0]), state.mined.get(lower(p[0]))!) : null;
      case "eth_sendRawTransaction": state.sent.push(p[0] as Hex); return keccak256(p[0] as Hex);
      case "eth_getBlockReceipts": return state.blockReceipts.get(String(p[0])) ?? [];
      default: throw new Error(`unexpected RPC ${method}`);
    }
  } }) });
  Object.assign(pub, {
    getBalance: async () => 10n ** 18n,
    getGasPrice: async () => 1n,
    // A node at `head`: a block past it doesn't exist yet.
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => {
      if (blockNumber !== undefined && blockNumber > state.head) throw new Error(`block ${blockNumber} is out of range`);
      return { number: blockNumber ?? state.head, hash: blockHash, timestamp: BigInt(now()) };
    },
    getBlockNumber: async () => state.head,
    getContractEvents: async () => state.runs,
    simulateContract: async ({ functionName }: { functionName: string }) => { state.simulate(functionName); return {}; },
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (blockNumber !== undefined && state.behind > 0) {
        state.behind--;
        throw new Error("RPC Request failed. Details: block is out of range");
      }
      switch (functionName) {
        case "getSchedule": return state.schedule;
        case "allowance": return state.allowance;
        case "feeBps": return 25;
        case "directTokenAllowed": return true;
        case "MAX_LIFETIME": return 31_536_000n;
        case "balanceOf": return 10n ** 12n;
        case "policy": return { owner, agent: agent.address, token: usd.address };
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    fillTransaction: async (input: Record<string, unknown>) => {
      state.prepared.push(input as never);
      return { transaction: { ...input, chainId: 42220, type: "eip1559", gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } };
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!state.receipts.has(lower(hash))) throw new Error("not mined yet");
      return await pub.getTransactionReceipt({ hash });
    },
  });
  return { pub: pub as unknown as PublicClient, state };
}
function context(c: ReturnType<typeof chain>, store: PaymentStore = memoryStore(), remittanceStore: RemittanceStore = memoryRemittanceStore(), fetchImpl: typeof fetch = fetch) {
  return makeCtx({ pub: c.pub, wallet: null, account: agent, endpoints, appOrigin: "https://remesso.test", dataSuffix: undefined, store, remittanceStore, fetch: fetchImpl });
}
const policy: Policy = { id: 7n, owner, agent: agent.address, token: usd.address as Address, symbol: "USDT", perPayment: 10n ** 9n, perDay: 10n ** 9n,
  expiresAt: new Date(Date.now() + 86_400_000), allowlistOnly: false, revoked: false, remainingToday: 10n ** 9n, ownerBalance: 10n ** 9n, ownerAllowance: 10n ** 9n,
  active: true, spendable: 10n ** 9n };
const policies = { get: async () => policy, find: async () => [7n] } as unknown as Policies;
const unusedRequests = { getRequest: async () => { throw new Error("unused"); }, answer: async () => ({ status: "accepted", signed: null }) };
function walletRecord(scope: string, change: Partial<RemittanceRecord> = {}): RemittanceRecord {
  const created = toHex(72, { size: 32 });
  return { key: "wallet-1", scope, payer: agent.address, to: recipient, token: usd.address as Address, amount: "1000000", amountIn: "1002507", fee: "2507", feeBps: 25,
    firstRunAt: now() + 3_000, expiresAt: now() + 80_000, createdAt: new Date().toISOString(), creation: { hash: created, raw: "0x02", nonce: 1 }, ...change };
}
/// Mines a wallet remittance's creation and, optionally, its approval.
function mineWallet(c: ReturnType<typeof chain>, r: RemittanceRecord) {
  c.state.receipts.set(lower(r.creation!.hash), receiptJson(r.creation!.hash, [createdLog(r.creation!.hash, BigInt(r.expiresAt))]));
  c.state.mined.set(lower(r.creation!.hash), 100n);
  if (r.approval) {
    c.state.receipts.set(lower(r.approval.hash), receiptJson(r.approval.hash, [approvedLog(r.approval.hash, BigInt(r.approvalAmount!))], { to: usd.address as Address }));
    c.state.mined.set(lower(r.approval.hash), 100n);
  }
  c.state.latest = Math.max(...[r.creation!, r.approval, r.execution].filter(Boolean).map((s) => s!.nonce)) + 1;
}

Deno.test("a policy payment retried after its deadline still reports that it landed", async () => {
  const c = chain(), store = memoryStore(), ctx = context(c, store);
  const pay = makePay(ctx, policies), raw = "0xdead01" as Hex, hash = keccak256(raw), memo = memo32(), validUntil = now() - 120;
  await store.save({ key: "late", deployment: paymentScope(ctx), owner, validUntil, policyId: "7", to: recipient, units: "1000000", token: usd.address as Address,
    memo, hash, nonce: 5, raw, status: "sent", at: new Date(Date.now() - 300_000).toISOString() });
  c.state.latest = 6; c.state.mined.set(lower(hash), 100n);
  c.state.receipts.set(lower(hash), receiptJson(hash, [paidLog(hash, memo)], { to: ALLOWANCE }));
  const sender = makeRemittances(ctx, { pay, policies, requests: {} as Requests, wallet: makeWalletRemittances(ctx, { store: memoryRemittanceStore(), ...unusedRequests }) });
  // Before: "this payment intent has expired; prepare and review a fresh quote", and a fresh key paid again.
  const paid = await sender.send({ funding: "policy", to: recipient, amount: "1", token: "USDT", idempotencyKey: "late", validUntil });
  assertEquals([paid.status, paid.repeat, paid.hash], ["confirmed", true, hash]);
  assertEquals(c.state.sent, []);
});

Deno.test("a wallet payment retried after its deadline reports the payment that went through", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const paid = toHex(74, { size: 32 }), validUntil = now() - 60;
  const r = walletRecord(remittanceScope(ctx), { validUntil, scheduleId: "7", creationBlock: "100", execution: { hash: paid, raw: "0x03", nonce: 2 }, paymentHash: paid });
  await wallets.save(r); mineWallet(c, r);
  c.state.receipts.set(lower(paid), receiptJson(paid, [runLog(paid)])); c.state.mined.set(lower(paid), 100n);
  c.state.schedule.runsExecuted = 1; c.state.schedule.active = false;
  const sender = makeRemittances(ctx, { pay: makePay(ctx, policies), policies, requests: {} as Requests, wallet: makeWalletRemittances(ctx, { store: wallets, ...unusedRequests }) });
  const result = await sender.send({ funding: "wallet", to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key, validUntil });
  assertEquals([result.status, result.hash], ["confirmed", paid]);
  assertEquals(c.state.sent, []);
});

Deno.test("one unsent payment no longer holds up every transaction signed after it", async () => {
  const c = chain(), store = memoryStore(), ctx = context(c, store);
  makePay(ctx, policies);
  const raw = "0xdead02" as Hex;
  // A keyless top-up whose broadcast a 429 swallowed.
  await store.save({ key: null, deployment: paymentScope(ctx), owner, policyId: "7", to: agent.address, units: "1000000", token: usd.address as Address,
    memo: memo32("x402 top-up"), hash: keccak256(raw), nonce: 5, raw, status: "sent", at: new Date(Date.now() - 60_000).toISOString() });
  c.state.latest = 5;
  // Before: the next nonce was 6 and nothing ever sent 5, so nothing after it could be mined.
  assertEquals(await ctx.nextNonce(), 6);
  assertEquals(c.state.sent, [raw]);
  c.state.latest = 6; c.state.mined.set(lower(keccak256(raw)), 100n);
  assertEquals(await ctx.nextNonce(), 6);
  assertEquals(c.state.sent, [raw]);
});

Deno.test("an unsent policy payment past its deadline is cancelled at its nonce, then reported unpaid", async () => {
  const c = chain(), store = memoryStore(), ctx = context(c, store), pay = makePay(ctx, policies);
  const raw = "0xdead03" as Hex, validUntil = now() - 60, input: PayInput = { to: recipient, amount: "1", idempotencyKey: "lapsed", validUntil, waitMs: 50 };
  await store.save({ key: "lapsed", deployment: paymentScope(ctx), owner, validUntil, policyId: "7", to: recipient, units: "1000000", token: usd.address as Address,
    memo: memo32(), hash: keccak256(raw), nonce: 5, raw, status: "sent", at: new Date(Date.now() - 120_000).toISOString() });
  c.state.latest = 5;
  const first = await pay(input);
  const saved = await store.byKey("lapsed", paymentScope(ctx));
  assert(saved?.cancel && first.cancellation === saved.cancel.hash);
  assertEquals(first.status, "pending");
  // A no-op from the agent to itself, at the payment's nonce; the payment's own bytes never went out.
  const cancel = parseTransaction(saved.cancel.raw) as { nonce?: number; to?: string; value?: bigint };
  assertEquals([cancel.nonce, lower(cancel.to), cancel.value ?? 0n], [5, lower(agent.address), 0n]);
  assertEquals(c.state.sent, [saved.cancel.raw]);
  c.state.latest = 6; c.state.receipts.set(lower(saved.cancel.hash), receiptJson(saved.cancel.hash, [], { to: agent.address }));
  const error = await assertRejects(() => pay(input), RemessoError);
  assertEquals([error.code, error.details?.expired], ["refused", true]);
  assertEquals((await store.byKey("lapsed", paymentScope(ctx)))?.status, "expired");
});

Deno.test("runNow refused after the approval cancels the schedule, and nothing is reported unpaid until that lands", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const r = walletRecord(remittanceScope(ctx), { scheduleId: "7", creationBlock: "100", approval: { hash: toHex(71, { size: 32 }), raw: "0x01", nonce: 2 }, approvalAmount: "1002507" });
  await wallets.save(r); mineWallet(c, r);
  c.state.simulate = (fn) => { if (fn === "runNow") throw Object.assign(new Error("execution reverted"), { shortMessage: "ERC20: transfer amount exceeds balance" }); };
  const wallet = makeWalletRemittances(ctx, { store: wallets, ...unusedRequests });
  // Before: `refused` ("nothing was sent") while the approved schedule stayed live for the executor to pay an hour later.
  const first = await wallet.send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key, waitMs: 300 });
  assertEquals([first.status, first.stage], ["pending", "cancellation"]);
  const saved = await wallets.get(r.key, r.scope);
  assert(saved?.cancellation && first.cancellationHash === saved.cancellation.hash);
  // Only the cancellation went out (this chain has no mempool, so it is sent again while unmined).
  assert(c.state.sent.length > 0 && c.state.sent.every((raw) => raw === saved.cancellation!.raw));
  c.state.receipts.set(lower(saved.cancellation.hash), receiptJson(saved.cancellation.hash, [cancelledLog(saved.cancellation.hash)]));
  c.state.mined.set(lower(saved.cancellation.hash), 100n); c.state.latest = saved.cancellation.nonce + 1;
  c.state.schedule.cancelled = true; c.state.schedule.active = false;
  const error = await assertRejects(() => wallet.send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key }), RemessoError);
  assertEquals([error.code, error.details?.cancelled, error.details?.cancellationHash], ["refused", true, saved.cancellation.hash]);
});

Deno.test("a payment that failed before signing is never started by recovery", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const wallet = makeWalletRemittances(ctx, { store: wallets, ...unusedRequests });
  c.state.countFails = true;
  await assertRejects(() => wallet.send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: "abandoned" }));
  assertEquals((await wallets.get("abandoned", remittanceScope(ctx)))?.creation, undefined);
  c.state.countFails = false;
  const lifecycle = makeLifecycle(ctx, { store: wallets, wallet, pay: async () => { throw new Error("unused"); }, receipts: {} as Receipts });
  // Before: recoverPending signed a new createSchedule for it and paid, up to a day later.
  assertEquals(await lifecycle.recoverPending({ funding: "wallet" }), []);
  assertEquals((await lifecycle.reconcile("abandoned", { funding: "wallet" })).status, "prepared");
  assertEquals(c.state.prepared, []);
  // Its own caller's retry still starts it.
  await wallet.send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: "abandoned", waitMs: 1_000 });
  assertEquals(c.state.prepared.length, 1);
});

Deno.test("an approval adds this payment to the allowance as it is when the approval is signed", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const r = walletRecord(remittanceScope(ctx), { scheduleId: "7", creationBlock: "100" });
  await wallets.save(r); mineWallet(c, r);
  // Another schedule was approved after this payment was saved.
  c.state.allowance = 5_000_000n;
  const result = await makeWalletRemittances(ctx, { store: wallets, ...unusedRequests }).send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key, waitMs: 50 });
  assertEquals([result.status, result.stage], ["pending", "approval"]);
  const approve = c.state.prepared.find((t) => lower(t.to) === lower(usd.address))!;
  assertEquals(decodeFunctionData({ abi: erc20Abi, data: approve.data! }).args, [EXECUTOR, 6_002_507n]);
  assertEquals((await wallets.get(r.key, r.scope))?.approvalAmount, "6002507");
});

Deno.test("an unlimited allowance needs no approval and runs the payment", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const r = walletRecord(remittanceScope(ctx), { scheduleId: "7", creationBlock: "100" });
  await wallets.save(r); mineWallet(c, r);
  c.state.allowance = 2n ** 256n - 1n;
  const result = await makeWalletRemittances(ctx, { store: wallets, ...unusedRequests }).send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key, waitMs: 50 });
  const saved = await wallets.get(r.key, r.scope);
  assertEquals([result.stage, saved?.approval, saved?.approvalSkipped, Boolean(saved?.execution)], ["execution", undefined, true, true]);
});

Deno.test("a schedule that expired without running is unpaid for good; a paused one needs attention", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const r = walletRecord(remittanceScope(ctx), { scheduleId: "7", creationBlock: "100" });
  await wallets.save(r); mineWallet(c, r);
  const wallet = makeWalletRemittances(ctx, { store: wallets, ...unusedRequests });
  c.state.schedule.active = false;
  const paused = await assertRejects(() => wallet.send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key }), RemessoError);
  assertEquals([paused.code, paused.details?.paused], ["conflict", true]);
  c.state.schedule.expiresAt = BigInt(now() - 10);
  const expired = await assertRejects(() => wallet.send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key }), RemessoError);
  assertEquals([expired.code, expired.details?.expired], ["refused", true]);
});

Deno.test("a shared coordinator is refused while the journals stay in memory", () => {
  const coordinator = { runExclusive: async <T>(_scope: string, run: (lease: { assertActive(): Promise<void> }) => Promise<T>) => await run({ assertActive: async () => {} }) };
  const error = (() => { try { createRemesso({ account: agent, coordinator }); } catch (e) { return e; } })();
  assert(error instanceof RemessoError && error.code === "invalid");
});

Deno.test("a managed signer's high-s signature is refused before it can be saved", async () => {
  const remote = privateKeyToAccount(toHex(98501, { size: 32 }));
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const tx = { chainId: 42220, type: "eip1559" as const, nonce: 7, to: EXECUTOR, data: "0x1234" as const, value: 0n, gas: 100_000n, maxFeePerGas: 50n, maxPriorityFeePerGas: 2n };
  const account = managedSigner({
    address: remote.address,
    signTransaction: async ({ transaction }) => {
      const signed = parseTransaction(await remote.signTransaction(transaction as never)) as Record<string, unknown>;
      const { r, s, v: _v, yParity, ...unsigned } = signed;
      return serializeTransaction(unsigned as never, { r: r as Hex, s: toHex(n - BigInt(s as Hex), { size: 32 }), yParity: yParity === 0 ? 1 : 0 });
    },
    signTypedData: async () => "0x",
  });
  assertEquals((await assertRejects(() => account.signTransaction(tx), RemessoError)).code, "refused");
});

Deno.test("a mined transaction a node has no receipt for is read from its block's receipts", async () => {
  const c = chain(), hash = toHex(91, { size: 32 });
  c.state.mined.set(lower(hash), 100n);
  c.state.blockReceipts.set(toHex(100n), [receiptJson(hash, [])]);
  const found = await receiptOf(c.pub, hash);
  assertEquals([found?.transactionHash, found?.status, found?.blockNumber], [hash, "success", 100n]);
  assertEquals(await receiptOf(c.pub, toHex(92, { size: 32 })), null);
});

Deno.test("a request that names no token is paid in the payer's chosen token, never another", async () => {
  const c = chain(), id = "bf0305f6-1ec5-4d42-9352-a09c84aa5f18";
  let requested: string | null = null;
  const fetchImpl = (async () => new Response(JSON.stringify({ id, reference: id.replaceAll("-", ""), status: "pending", payer: owner,
    requested: { to: recipient, amount: "1", token: requested, intervalSeconds: null, runs: null }, signed: null, payment: null }))) as typeof fetch;
  const ctx = context(c, memoryStore(), memoryRemittanceStore(), fetchImpl);
  const calls: PayInput[] = [];
  const requests = makeRequests(ctx, { pay: async (input) => { calls.push(input); return { status: "pending" } as PaymentResult; }, policies });
  await requests.pay(id, { token: "USDC" });
  assertEquals(calls[0].token, "USDC");
  requested = "USDT";
  assertEquals((await assertRejects(() => requests.pay(id, { token: "USDC" }), RemessoError)).code, "refused");
  assertEquals(calls.length, 1);
});

// --- The second review: Codex's findings on the fixes above -------------------

Deno.test("a request that can no longer be answered stops the payment before it is approved", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const requestId = "bf0305f6-1ec5-4d42-9352-a09c84aa5f18";
  const r = walletRecord(remittanceScope(ctx), { scheduleId: "7", creationBlock: "100", requestId });
  await wallets.save(r); mineWallet(c, r);
  let status: RequestStatus["status"] = "pending";
  const wallet = makeWalletRemittances(ctx, {
    store: wallets,
    answer: async () => { throw new Error(`the request is ${status}`); },
    getRequest: async () => ({ id: requestId, reference: requestId.replaceAll("-", ""), status, payer: agent.address,
      requested: { to: recipient, amount: "1", token: "USDT", intervalSeconds: null, runs: 1 }, signed: null, payment: null }),
  });
  const input = { to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key, requestId, waitMs: 50 };
  // The backend can't bind it yet: wait, and sign nothing.
  const waiting = await wallet.send(input);
  assertEquals([waiting.status, waiting.stage, c.state.prepared.length], ["pending", "approval", 0]);
  // Declined since. Before: approved and run anyway, an invoice that could never settle.
  status = "declined";
  const stopped = await wallet.send(input);
  assertEquals([stopped.status, stopped.stage], ["pending", "cancellation"]);
  assertEquals(c.state.prepared.map((t) => decodeFunctionData({ abi: executorAbi, data: t.data! }).functionName), ["cancelSchedule"]);
});

Deno.test("a young unsent write is waited out and cancelled, outbidding it, before anything is signed above it", async () => {
  // Its own key: a process keeps one nonce record per signer, shared by tests.
  const writer = privateKeyToAccount(toHex(31340, { size: 32 }));
  const c = chain(); c.state.latest = 5;
  const original = await writer.signTransaction({ chainId: 42220, type: "eip1559", nonce: 5, to: EXECUTOR, data: "0x1234", gas: 100_000n,
    maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 20_000_000_000n });
  const cancels: { nonce: number; hash: Hex; raw: Hex }[] = [];
  const coordinator = {
    runExclusive: async <T>(_scope: string, run: (lease: { assertActive(): Promise<void> }) => Promise<T>) => await run({ assertActive: async () => {} }),
    // Saved 29 seconds ago: one second of its grace left.
    openSigned: async () => [{ nonce: 5, hash: keccak256(original), raw: original, savedAt: Date.now() - 29_000, ...(cancels[0] ? { cancel: cancels[0] } : {}) }],
    recordCancel: async (_scope: string, nonce: number, cancel: { hash: Hex; raw: Hex }) => { cancels.push({ nonce, ...cancel }); },
  };
  const ctx = makeCtx({ pub: c.pub, wallet: null, account: writer, endpoints, appOrigin: "https://remesso.test", dataSuffix: undefined, store: memoryStore(), fetch, coordinator });
  // Before: skipped while young, and the next nonce went above it for good.
  assertEquals(await ctx.nextNonce(), 6);
  assertEquals(cancels.map((x) => x.nonce), [5]);
  // A node holding the original keeps it unless the cancellation pays more.
  const cancel = parseTransaction(cancels[0].raw) as { nonce?: number; to?: string; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
  assertEquals([cancel.nonce, lower(cancel.to)], [5, lower(writer.address)]);
  assert(cancel.maxFeePerGas! > 112_500_000_000n && cancel.maxPriorityFeePerGas! > 22_500_000_000n);
  assertEquals(c.state.sent, [cancels[0].raw]);
});

Deno.test("an underpriced replacement is a refusal, not an acceptance", async () => {
  const pub = createPublicClient({ chain: celo, transport: custom({ request: async ({ method }) => {
    if (method === "eth_sendRawTransaction") throw new Error("replacement transaction underpriced");
    throw new Error(`unexpected RPC ${method}`);
  } }) }) as unknown as PublicClient;
  const ctx = makeCtx({ pub, wallet: null, account: agent, endpoints, appOrigin: "https://remesso.test", dataSuffix: undefined, store: memoryStore(), fetch });
  assertEquals(await ctx.resend("0x02"), false);
});

Deno.test("a payment whose deadline passes while it is being saved is cancelled, never first sent late", async () => {
  const c = chain(); c.state.latest = 5;
  const realNow = Date.now;
  let skew = 0;
  const inner = memoryStore();
  // A slow journal: forty seconds pass while the signed payment is saved.
  const store: PaymentStore = { byKey: inner.byKey, since: inner.since, save: async (rec) => { await inner.save(rec); if (rec.key === "slow" && !rec.cancel) skew = 40_000; } };
  Date.now = () => realNow() + skew;
  try {
    const ctx = context(c, store), pay = makePay(ctx, policies);
    const result = await pay({ to: recipient, amount: "1", idempotencyKey: "slow", validUntil: Math.floor(realNow() / 1000) + 61, waitMs: 50 });
    const saved = await inner.byKey("slow", paymentScope(ctx));
    assert(saved?.cancel && result.cancellation === saved.cancel.hash);
    // Before: its own bytes went out nine seconds after the deadline.
    assertEquals(c.state.sent, [saved.cancel.raw]);
  } finally { Date.now = realNow; }
});

Deno.test("waiting on another payment's approval sends it again if no node has it", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const lost = "0x0a" as Hex;
  await wallets.save(walletRecord(remittanceScope(ctx), { key: "older", scheduleId: "8", creationBlock: "100", creation: { hash: toHex(80, { size: 32 }), raw: "0x08", nonce: 1 },
    approval: { hash: keccak256(lost), raw: lost, nonce: 3 }, approvalAmount: "1002507" }));
  const r = walletRecord(remittanceScope(ctx), { scheduleId: "7", creationBlock: "100", creation: { hash: toHex(72, { size: 32 }), raw: "0x02", nonce: 2 } });
  await wallets.save(r); mineWallet(c, r);
  const result = await makeWalletRemittances(ctx, { store: wallets, ...unusedRequests }).send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key, waitMs: 50 });
  assertEquals([result.status, result.stage], ["pending", "approval"]);
  // Before: nothing sent, and nothing ever would be.
  assert(c.state.sent.includes(lost));
});

Deno.test("schedule state from before a receipt we hold is no basis for cancelling", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const ran = toHex(73, { size: 32 });
  const r = walletRecord(remittanceScope(ctx), { scheduleId: "7", creationBlock: "100", approval: { hash: toHex(71, { size: 32 }), raw: "0x01", nonce: 2 }, approvalAmount: "1002507",
    execution: { hash: ran, raw: "0x03", nonce: 3 } });
  await wallets.save(r); mineWallet(c, r);
  // Our runNow reverted at block 200, and this node has only reached block 100.
  c.state.receipts.set(lower(ran), receiptJson(ran, [], { status: "0x0", block: 200n })); c.state.mined.set(lower(ran), 200n);
  const result = await makeWalletRemittances(ctx, { store: wallets, ...unusedRequests }).send({ to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key, waitMs: 50 });
  // Before: it decided from block 100 and signed a cancellation.
  assertEquals([result.status, result.stage], ["pending", "execution"]);
  assertEquals([(await wallets.get(r.key, r.scope))?.cancellation, c.state.prepared.length], [undefined, 0]);
});

// From the first wallet-funded run on mainnet (2026-10-26): forno answered the
// head from one node and the call pinned to it from another, a block behind.

Deno.test("a schedule read that reaches a node behind its block is read again, not thrown", async () => {
  const c = chain(), wallets = memoryRemittanceStore(), ctx = context(c, memoryStore(), wallets);
  const r = walletRecord(remittanceScope(ctx), { scheduleId: "7", creationBlock: "100" });
  await wallets.save(r); mineWallet(c, r);
  c.state.allowance = 2n ** 256n - 1n;
  c.state.behind = 2;
  const wallet = makeWalletRemittances(ctx, { store: wallets, ...unusedRequests });
  const input = { to: recipient, amount: "1", token: "USDT", idempotencyKey: r.key, waitMs: 50 };
  // Before: send() threw "block is out of range" just after creating the
  // schedule, and with a memory journal the payment was left half done.
  const first = await wallet.send(input);
  // The reads were retried within this call, which spent its wait doing so.
  assertEquals([first.status, c.state.behind], ["pending", 0]);
  const again = await wallet.send(input);
  assertEquals(again.stage, "execution");
  assert(Boolean((await wallets.get(r.key, r.scope))?.execution));
});
