import { assertEquals, assertRejects } from "@std/assert";
import { encodeAbiParameters, encodeEventTopics, toHex, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { allowanceAbi, executorAbi } from "../src/abi.ts";
import { makeCtx } from "../src/context.ts";
import { ALLOWANCE, EXECUTOR, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import { memo32 } from "../src/payments.ts";
import { makeReceipts, type VerifyPaymentInput } from "../src/receipts.ts";
import { memoryStore } from "../src/store.ts";

const owner = "0x1111111111111111111111111111111111111111" as Address;
const agent = "0x2222222222222222222222222222222222222222" as Address;
const recipient = "0x3333333333333333333333333333333333333333" as Address;
const stranger = "0x4444444444444444444444444444444444444444" as Address;
const txHash = toHex(101, { size: 32 });
const blockHash = toHex(202, { size: 32 });
const usdt = token("USDT");
const cngn = token("cNGN");
const expected: VerifyPaymentInput = { txHash, from: owner, to: recipient, token: "USDT", amount: "1", memo: "invoice-17" };
const policy = { owner, agent, token: usdt.address, expiresAt: 4_000_000_000n, allowlistOnly: false, revoked: false,
  perPayment: 5_000_000n, perDay: 10_000_000n, spentInWindow: 1_000_000n, windowStart: 1n };
const schedule = { sender: owner, destination: recipient, amountIn: 1_000_000n, token: usdt.address,
  tokenOut: "0x0000000000000000000000000000000000000000" as Address, payoutType: 2, feeBps: 25 };

function metadata(logIndex = 1) {
  return { transactionHash: txHash, transactionIndex: 0, blockHash, blockNumber: 100n, logIndex, removed: false };
}
function paid(id = 7n, logIndex = 1, amount = 1_000_000n): TransactionReceipt["logs"][number] {
  return { ...metadata(logIndex), address: ALLOWANCE,
    topics: encodeEventTopics({ abi: allowanceAbi, eventName: "Paid", args: { id, to: recipient } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [amount, memo32("invoice-17")]) };
}
function run(id = 8n, logIndex = 1, amountOut = 997_500n, amountIn = 1_000_000n): TransactionReceipt["logs"][number] {
  return { ...metadata(logIndex), address: EXECUTOR,
    topics: encodeEventTopics({ abi: executorAbi, eventName: "RunExecuted", args: { id, sender: owner, destination: recipient } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint32" }, { type: "uint64" }], [amountIn, amountOut, 3, 500n]) };
}
function receipt(logs = [paid()]): TransactionReceipt {
  return { transactionHash: txHash, transactionIndex: 0, blockHash, blockNumber: 100n, from: agent, to: ALLOWANCE,
    cumulativeGasUsed: 80_000n, gasUsed: 80_000n, effectiveGasPrice: 1n, contractAddress: null,
    logs, logsBloom: `0x${"00".repeat(256)}`, status: "success", type: "legacy" };
}
type Fixture = {
  receipt?: TransactionReceipt;
  policy?: Partial<typeof policy>;
  schedule?: Partial<typeof schedule>;
  chainId?: number;
  finalizedNumber?: bigint;
  finalizedHash?: Hex;
  canonicalHashes?: Hex[];
};
function fixture(overrides: Fixture = {}) {
  let blockReads = 0;
  const reads: { functionName: string; blockNumber: bigint; id: bigint }[] = [];
  const pub = {
    getChainId: async () => overrides.chainId ?? 42220,
    getTransactionReceipt: async () => overrides.receipt ?? receipt(),
    getBlock: async ({ blockTag }: { blockTag?: string }) => blockTag === "finalized"
      ? { number: overrides.finalizedNumber ?? 100n, hash: overrides.finalizedHash ?? blockHash }
      : { number: 100n, hash: overrides.canonicalHashes?.[blockReads++] ?? blockHash },
    readContract: async ({ functionName, blockNumber, args }: { functionName: string; blockNumber: bigint; args: [bigint] }) => {
      reads.push({ functionName, blockNumber, id: args[0] });
      return functionName === "policy" ? { ...policy, ...overrides.policy } : { ...schedule, ...overrides.schedule };
    },
  } as unknown as PublicClient;
  const ctx = makeCtx({ pub, account: null, wallet: null, dataSuffix: undefined, store: memoryStore(), fetch,
    endpoints: { requestPayment: "", paymentEvents: "", webhooks: "" }, appOrigin: "https://remesso.test" });
  return { api: makeReceipts(ctx), reads, pub };
}
async function rejects(input: VerifyPaymentInput, overrides: Fixture = {}, code = "conflict") {
  assertEquals((await assertRejects(() => fixture(overrides).api.verify(input), RemessoError)).code, code);
}

Deno.test("receipt verification proves a Paid event using the policy's funds owner and token", async () => {
  const { api, reads } = fixture();
  const proof = await api.verify({ ...expected, policyId: 7 });
  assertEquals(proof.kind, "policy_payment");
  if (proof.kind !== "policy_payment") throw new Error("wrong proof type");
  assertEquals([proof.from, proof.to, proof.token.toLowerCase(), proof.amount, proof.policyId, proof.agent, proof.memo, proof.callerVerified],
    [owner, recipient, usdt.address.toLowerCase(), 1_000_000n, 7n, agent, memo32("invoice-17"), true]);
  assertEquals([proof.txHash, proof.blockHash, proof.blockNumber, proof.logIndex, proof.finality], [txHash, blockHash, 100n, 1, "included"]);
  assertEquals(proof.eventId, `42220:${ALLOWANCE.toLowerCase()}:${txHash}:1`);
  assertEquals(reads, [{ functionName: "policy", blockNumber: 100n, id: 7n }]);
});

Deno.test("receipt verification proves direct schedule delivery using net output, not gross funding", async () => {
  const { api, reads } = fixture({ receipt: receipt([run()]) });
  const proof = await api.verify({ ...expected, memo: undefined, amount: "0.9975", scheduleId: "8" });
  assertEquals(proof.kind, "run");
  if (proof.kind !== "run") throw new Error("wrong proof type");
  assertEquals([proof.amount, proof.amountIn, proof.scheduleId, proof.runNumber], [997_500n, 1_000_000n, 8n, 3]);
  assertEquals(reads, [{ functionName: "getSchedule", blockNumber: 100n, id: 8n }]);
  await rejects({ ...expected, memo: undefined, amount: "1" }, { receipt: receipt([run()]) });
});

Deno.test("receipt verification derives a swap run's received token from its pinned tokenOut", async () => {
  const amountOut = 300n * 10n ** BigInt(cngn.decimals);
  const options: Fixture = { receipt: receipt([run(8n, 1, amountOut)]), schedule: { payoutType: 0, tokenOut: cngn.address as Address } };
  const proof = await fixture(options).api.verify({ ...expected, memo: undefined, token: "cNGN", amount: "300" });
  assertEquals([proof.kind, proof.token.toLowerCase(), proof.amount], ["run", cngn.address.toLowerCase(), amountOut]);
  await rejects({ ...expected, memo: undefined, amount: "300" }, options);
});

Deno.test("receipt verification requires explicit valid expectation terms before using RPC", async () => {
  for (const change of [{ txHash: "0x123" }, { from: undefined }, { to: undefined }, { token: undefined }, { amount: 1 },
    { amount: "0" }, { amount: "1.0000001" }, { policyId: -1 }, { scheduleId: Number.MAX_SAFE_INTEGER + 1 },
    { policyId: 7, scheduleId: 8 }, { scheduleId: 8 }, { memo: "a".repeat(33) }, { finality: "latest" }]) {
    await rejects({ ...expected, ...change } as VerifyPaymentInput, {}, "invalid");
  }
});

Deno.test("receipt verification refuses wrong sender, recipient, token, amount, memo and policy", async () => {
  for (const change of [{ from: agent }, { to: stranger }, { token: "USDC" }, { amount: "2" }, { memo: "another-order" }, { policyId: 9 }, { scheduleId: 8, memo: undefined }]) {
    await rejects({ ...expected, ...change });
  }
});

Deno.test("receipt verification requires the known contract's supported event", async () => {
  await rejects(expected, { receipt: receipt([]) });
  await rejects(expected, { receipt: receipt([{ ...paid(), address: stranger }]) });
  await rejects(expected, { receipt: receipt([{ ...paid(), data: "0x" }]) });
  await rejects({ ...expected, memo: undefined }, { receipt: receipt([run()]), schedule: { feeBps: 0 } });
});

Deno.test("receipt verification validates the agent on direct policy calls", async () => {
  await rejects(expected, { receipt: { ...receipt(), from: stranger } });
  const proof = await fixture({ receipt: { ...receipt(), from: stranger, to: agent } }).api.verify(expected);
  assertEquals(proof.kind === "policy_payment" && proof.callerVerified, false);
});

Deno.test("receipt verification reads immutable policy and schedule terms instead of trusting claimed logs", async () => {
  await rejects(expected, { policy: { owner: stranger } });
  await rejects(expected, { policy: { token: token("USDC").address } });
  const input = { ...expected, memo: undefined, amount: "0.9975" };
  for (const changed of [{ sender: stranger }, { destination: stranger }, { token: token("USDC").address }, { amountIn: 2_000_000n }, { feeBps: 0 }]) {
    await rejects(input, { receipt: receipt([run()]), schedule: changed });
  }
});

Deno.test("receipt verification rejects reverted transactions and another hash's receipt", async () => {
  await rejects(expected, { receipt: { ...receipt(), status: "reverted" } }, "reverted");
  await rejects(expected, { receipt: { ...receipt(), transactionHash: toHex(303, { size: 32 }) } });
  await rejects(expected, { chainId: 1 }, "wrong_chain");
});

Deno.test("receipt verification rejects a reorganized block before and during verification", async () => {
  const changedHash = toHex(303, { size: 32 });
  await rejects(expected, { canonicalHashes: [changedHash] });
  await rejects(expected, { canonicalHashes: [blockHash, changedHash] });
});

Deno.test("receipt verification only returns finalized evidence after the finalized block reaches it", async () => {
  await rejects({ ...expected, finality: "finalized" }, { finalizedNumber: 99n }, "refused");
  const proof = await fixture({ finalizedNumber: 101n }).api.verify({ ...expected, finality: "finalized" });
  assertEquals(proof.finality, "finalized");
  await rejects({ ...expected, finality: "finalized" }, { finalizedHash: toHex(303, { size: 32 }) });
});

Deno.test("receipt verification reports a missing receipt and never treats an RPC failure as payment", async () => {
  const { api, pub } = fixture();
  pub.getTransactionReceipt = async () => { throw new TransactionReceiptNotFoundError({ hash: txHash }); };
  assertEquals((await assertRejects(() => api.verify(expected), RemessoError)).code, "not_found");
  pub.getTransactionReceipt = async () => { throw new Error("RPC unavailable"); };
  await assertRejects(() => api.verify(expected), Error, "RPC unavailable");
});

Deno.test("receipt verification fails closed if the RPC cannot report finalized blocks", async () => {
  const { api, pub } = fixture();
  pub.getBlock = async ({ blockTag } = {}) => {
    if (blockTag === "finalized") throw new Error("finalized tag unsupported");
    return { number: 100n, hash: blockHash } as never;
  };
  await assertRejects(() => api.verify({ ...expected, finality: "finalized" }), Error, "finalized tag unsupported");
});

Deno.test("receipt verification rejects ambiguous payment logs and permits an exact policy restriction", async () => {
  const options = { receipt: receipt([paid(7n, 1), paid(9n, 2)]) };
  await rejects(expected, options);
  const proof = await fixture(options).api.verify({ ...expected, policyId: 9 });
  assertEquals([proof.logIndex, proof.kind === "policy_payment" && proof.policyId], [2, 9n]);
  await rejects({ ...expected, policyId: 7 }, { receipt: receipt([paid(7n, 1), paid(7n, 2)]) });
});

Deno.test("receipt verification ignores removed logs or logs with another receipt's identity", async () => {
  for (const change of [{ removed: true }, { blockHash: toHex(303, { size: 32 }) }, { blockNumber: 99n },
    { transactionHash: toHex(303, { size: 32 }) }, { logIndex: null }]) {
    await rejects(expected, { receipt: receipt([{ ...paid(), ...change } as TransactionReceipt["logs"][number]]) });
  }
});

Deno.test("receipt verification returns the same delivery key on replay and distinct keys for different logs", async () => {
  const first = await fixture().api.verify(expected);
  const replay = await fixture().api.verify(expected);
  const other = await fixture({ receipt: receipt([paid(7n, 2)]) }).api.verify(expected);
  assertEquals(first.eventId, replay.eventId);
  assertEquals(first.eventId === other.eventId, false);
});

Deno.test("receipt verification decodes V5's recorded first mainnet RunExecuted bytes", async () => {
  // The event from tx 0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72,
  // block 80,271,047; also pinned by _shared/receipt.test.ts. Receipt metadata
  // and chain reads here are mocked, while these event bytes are unmodified.
  const realOwner = "0x5b156fe262b54c236563428c56839d8457a5542c" as Address;
  const realRecipient = "0xfd1a3980f7473bdfe7461e78adde78c33d7b006b" as Address;
  const usa = token("USA₮");
  const log: TransactionReceipt["logs"][number] = {
    ...metadata(), address: EXECUTOR,
    topics: [
      "0x950cfba98d7a616c7497f589d2638709b616af197f194d953e0c6f2fb9a18155",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000005b156fe262b54c236563428c56839d8457a5542c",
      "0x000000000000000000000000fd1a3980f7473bdfe7461e78adde78c33d7b006b",
    ],
    data: "0x00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000f387c0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006ad26049",
  };
  const { api } = fixture({ receipt: receipt([log]), schedule: { sender: realOwner, destination: realRecipient, token: usa.address } });
  const proof = await api.verify({ txHash, from: realOwner, to: realRecipient, token: "USA₮", amount: "0.9975", scheduleId: 1 });
  assertEquals([proof.kind, proof.amount, proof.kind === "run" && proof.runNumber], ["run", 997_500n, 1]);
});

Deno.test("receipt verification applies the pinned fee rounded up at a nondivisible boundary", async () => {
  const options: Fixture = { receipt: receipt([run(8n, 1, 997_500n, 1_000_001n)]), schedule: { amountIn: 1_000_001n } };
  const input = { ...expected, memo: undefined, amount: "0.9975", scheduleId: 8 };
  assertEquals((await fixture(options).api.verify(input)).amount, 997_500n);
  // Floor-rounded fees would incorrectly claim 997,501 rather than 997,500.
  await rejects({ ...input, amount: "0.997501" }, { ...options, receipt: receipt([run(8n, 1, 997_501n, 1_000_001n)]) });
  // A later global rate is irrelevant; only the historical schedule's pinned
  // fee is read. This second schedule pins no fee and must deliver its gross.
  const zeroFee: Fixture = { receipt: receipt([run(8n, 1, 1_000_000n)]), schedule: { feeBps: 0 } };
  assertEquals((await fixture(zeroFee).api.verify({ ...input, amount: "1" })).amount, 1_000_000n);
});

Deno.test("receipt verification accepts an agent's self-funded runNow and ignores RunTriggered", async () => {
  const triggerLog: TransactionReceipt["logs"][number] = { ...metadata(1), address: EXECUTOR,
    topics: encodeEventTopics({ abi: executorAbi, eventName: "RunTriggered", args: { id: 8n, by: owner } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint16" }], [0]),
  };
  const { api, reads } = fixture({ receipt: { ...receipt([triggerLog, run(8n, 2)]), from: owner, to: EXECUTOR } });
  const proof = await api.verify({ ...expected, memo: undefined, amount: "0.9975", scheduleId: 8 });
  assertEquals([proof.kind, proof.from, proof.logIndex], ["run", owner, 2]);
  assertEquals(reads.map((r) => r.functionName), ["getSchedule"]);
  await rejects({ ...expected, memo: undefined, amount: "0.9975", scheduleId: 8 }, { receipt: receipt([triggerLog]) });
});

Deno.test("receipt verification ignores nonpayment events emitted by the allowance contract", async () => {
  const revoked: TransactionReceipt["logs"][number] = { ...metadata(1), address: ALLOWANCE,
    topics: encodeEventTopics({ abi: allowanceAbi, eventName: "PolicyRevoked", args: { id: 9n } }) as [Hex, ...Hex[]], data: "0x" };
  const proof = await fixture({ receipt: receipt([revoked, paid(7n, 2)]) }).api.verify(expected);
  assertEquals([proof.kind, proof.logIndex], ["policy_payment", 2]);
  await rejects(expected, { receipt: receipt([revoked]) });
});
