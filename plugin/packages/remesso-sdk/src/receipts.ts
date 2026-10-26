/// Independent payment evidence for a recipient: an HTTP response or a
/// successful transaction alone is never enough to deliver a paid service.
import {
  type Address,
  decodeEventLog,
  type Hex,
  zeroAddress,
} from "viem";
import { allowanceAbi, executorAbi } from "./abi.js";
import { type Ctx, receiptOf } from "./context.js";
import { ALLOWANCE, CHAIN_ID, checksum, EXECUTOR, token as tokenOf, toUnits } from "./deployment.js";
import { RemessoError } from "./errors.js";
import { memo32 } from "./payments.js";

export type VerifyPaymentInput = {
  txHash: Hex;
  /** The wallet whose funds moved, rather than the agent or executor sending the transaction. */
  from: string;
  to: string;
  /** The asset received, by symbol or supported token address. */
  token: string;
  /** Exact decimal amount received, after any schedule fee. */
  amount: string;
  /** Restrict the proof to this policy. Cannot be combined with scheduleId. */
  policyId?: bigint | number | string;
  /** Restrict the proof to this schedule. Cannot be combined with policyId. */
  scheduleId?: bigint | number | string;
  /** The same UTF-8 memo passed to pay(); schedules have no memo. */
  memo?: string;
  /** Default included. Finalized requires the receipt's block to be at or below the RPC's finalized block. */
  finality?: "included" | "finalized";
};

type ProofBase = {
  /** Stable delivery key. Persist this before fulfilling an order to reject replayed proofs. */
  eventId: string;
  chainId: typeof CHAIN_ID;
  contract: Address;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
  from: Address;
  to: Address;
  token: Address;
  /** Recipient's amount, in token base units. */
  amount: bigint;
  /** Strongest finality actually checked by this call. Included proofs can still be reorganized. */
  finality: "included" | "finalized";
};

export type PaymentProof = ProofBase & ({
  kind: "policy_payment";
  policyId: bigint;
  agent: Address;
  memo: Hex;
  /** True for direct allowance calls. Internal callers of contract-agent transactions are not exposed by receipts. */
  callerVerified: boolean;
} | {
  kind: "run";
  scheduleId: bigint;
  /** Funding token units before the fee or swap. */
  amountIn: bigint;
  runNumber: number;
});

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hashOf = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);

function refId(value: bigint | number | string | undefined, name: string): bigint | undefined {
  if (value === undefined) return undefined;
  if ((typeof value === "number" && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) {
    throw new RemessoError("invalid", `${name} must be a positive integer`);
  }
  const id = BigInt(value);
  if (id <= 0n || id >= 2n ** 256n) throw new RemessoError("invalid", `${name} must fit a positive uint256`);
  return id;
}

export function makeReceipts(ctx: Ctx) {
  async function verify(input: VerifyPaymentInput): Promise<PaymentProof> {
    if (!input || !hashOf(input.txHash)) throw new RemessoError("invalid", "txHash must be a 32-byte transaction hash");
    if (typeof input.from !== "string" || typeof input.to !== "string" || typeof input.token !== "string" || typeof input.amount !== "string") {
      throw new RemessoError("invalid", "from, to, token and an exact decimal amount are required to verify a payment");
    }
    const from = checksum(input.from);
    const to = checksum(input.to);
    if (same(from, zeroAddress) || same(to, zeroAddress)) throw new RemessoError("invalid", "from and to must be nonzero wallets");
    const t = tokenOf(input.token);
    const amount = toUnits(input.amount, t);
    if (amount <= 0n) throw new RemessoError("invalid", "amount received must be positive");
    const policyId = refId(input.policyId, "policyId");
    const scheduleId = refId(input.scheduleId, "scheduleId");
    if (policyId !== undefined && scheduleId !== undefined) throw new RemessoError("invalid", "choose policyId or scheduleId, not both");
    if (input.memo !== undefined && typeof input.memo !== "string") throw new RemessoError("invalid", "memo must be the UTF-8 string passed to pay()");
    if (scheduleId !== undefined && input.memo !== undefined) throw new RemessoError("invalid", "schedule runs do not carry a memo");
    const memo = input.memo === undefined ? undefined : memo32(input.memo);
    const finality = input.finality ?? "included";
    if (finality !== "included" && finality !== "finalized") throw new RemessoError("invalid", "finality must be included or finalized");
    const chainId = await ctx.pub.getChainId();
    if (chainId !== CHAIN_ID) throw new RemessoError("wrong_chain", `payment proofs require Celo mainnet (${CHAIN_ID}), got ${chainId}`);

    const receipt = await receiptOf(ctx.pub, input.txHash);
    if (!receipt) throw new RemessoError("not_found", "the transaction has no included receipt", { txHash: input.txHash });
    if (!same(receipt.transactionHash, input.txHash)) throw new RemessoError("conflict", "the RPC returned a different transaction's receipt");
    if (receipt.status !== "success") throw new RemessoError("reverted", "the transaction reverted; it is not payment evidence", { txHash: input.txHash });
    if (!hashOf(receipt.blockHash) || typeof receipt.blockNumber !== "bigint") throw new RemessoError("conflict", "the receipt is not included in a block");

    const assertCanonical = async () => {
      const block = await ctx.pub.getBlock({ blockNumber: receipt.blockNumber });
      if (block.number !== receipt.blockNumber || !hashOf(block.hash) || !same(block.hash, receipt.blockHash)) throw new RemessoError("conflict", "the payment's block is no longer canonical; verify it again", { txHash: input.txHash });
    };
    await assertCanonical();
    const proofs: PaymentProof[] = [];
    const readPolicy = (id: bigint) => ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "policy", args: [id], blockNumber: receipt.blockNumber });
    const readSchedule = (id: bigint) => ctx.pub.readContract({ address: EXECUTOR, abi: executorAbi, functionName: "getSchedule", args: [id], blockNumber: receipt.blockNumber });
    const policies = new Map<bigint, ReturnType<typeof readPolicy>>();
    const schedules = new Map<bigint, ReturnType<typeof readSchedule>>();

    for (const log of receipt.logs) {
      if (log.removed || !hashOf(log.transactionHash) || !same(log.transactionHash, input.txHash) || !hashOf(log.blockHash) || !same(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber || !Number.isSafeInteger(log.logIndex) || log.logIndex! < 0) continue;
      if (!same(log.address, ALLOWANCE) && !same(log.address, EXECUTOR)) continue;
      const contract = same(log.address, ALLOWANCE) ? ALLOWANCE : EXECUTOR;
      const base: ProofBase = {
        eventId: `${CHAIN_ID}:${contract.toLowerCase()}:${input.txHash.toLowerCase()}:${log.logIndex}`,
        chainId: CHAIN_ID, contract, txHash: receipt.transactionHash, logIndex: log.logIndex!,
        blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
        from, to, token: t.address as Address, amount, finality,
      };
      if (contract === ALLOWANCE && scheduleId === undefined) {
        let event;
        try { event = decodeEventLog({ abi: allowanceAbi, eventName: "Paid", topics: log.topics, data: log.data, strict: true }); } catch { continue; }
        // eventName narrows viem's inferred type; the full ABI can still decode
        // another event's topic at runtime (e.g. PolicyCreated).
        if (event.eventName !== "Paid") continue;
        const { id, to: recipient, amount: paid, memo: actualMemo } = event.args;
        if (!same(recipient, to) || paid !== amount || (policyId !== undefined && id !== policyId) || (memo !== undefined && !same(actualMemo, memo))) continue;
        if (!policies.has(id)) policies.set(id, readPolicy(id));
        const p = await policies.get(id)!;
        if (!same(p.owner, from) || !same(p.token, t.address)) continue;
        const callerVerified = receipt.to !== null && same(receipt.to, ALLOWANCE);
        if (callerVerified && !same(receipt.from, p.agent)) throw new RemessoError("conflict", "the direct payment caller differs from the policy's agent");
        proofs.push({ ...base, kind: "policy_payment", policyId: id, agent: p.agent, memo: actualMemo, callerVerified });
      } else if (contract === EXECUTOR && policyId === undefined && memo === undefined) {
        let event;
        try { event = decodeEventLog({ abi: executorAbi, eventName: "RunExecuted", topics: log.topics, data: log.data, strict: true }); } catch { continue; }
        if (event.eventName !== "RunExecuted") continue;
        const { id, sender, destination, amountIn, amountOut, runsExecuted } = event.args;
        if (!same(sender, from) || !same(destination, to) || amountOut !== amount || (scheduleId !== undefined && id !== scheduleId)) continue;
        if (!schedules.has(id)) schedules.set(id, readSchedule(id));
        const s = await schedules.get(id)!;
        const receivedToken = s.payoutType === 2 ? s.token : s.tokenOut;
        if (!same(s.sender, from) || !same(s.destination, to) || !same(receivedToken, t.address) || s.amountIn !== amountIn) continue;
        // Direct runs emit the net amount after the schedule's pinned fee.
        // Swaps emit the measured output, denominated in its pinned tokenOut.
        if (s.payoutType === 2 && amountOut !== amountIn - (amountIn * BigInt(s.feeBps) + 9_999n) / 10_000n) continue;
        proofs.push({ ...base, kind: "run", scheduleId: id, amountIn, runNumber: runsExecuted });
      }
    }
    if (proofs.length === 0) throw new RemessoError("conflict", "the receipt contains no supported payment matching every expected term", { txHash: input.txHash });
    if (proofs.length !== 1) throw new RemessoError("conflict", "multiple payments match these terms; specify a policyId or scheduleId to identify exactly one event", { txHash: input.txHash });
    if (finality === "finalized") {
      const finalized = await ctx.pub.getBlock({ blockTag: "finalized" });
      if (!hashOf(finalized.hash) || typeof finalized.number !== "bigint" || finalized.number < receipt.blockNumber) throw new RemessoError("refused", "the payment is included but has not reached the RPC's finalized block", { txHash: input.txHash, blockNumber: String(receipt.blockNumber) });
      if (finalized.number === receipt.blockNumber && !same(finalized.hash, receipt.blockHash)) throw new RemessoError("conflict", "the finalized block differs from the payment's block");
    }
    // A reorg while reading the policy/schedule must not produce a proof.
    await assertCanonical();
    return proofs[0];
  }
  return { verify };
}

export type Receipts = ReturnType<typeof makeReceipts>;
