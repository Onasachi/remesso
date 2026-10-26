/// Read-only readiness checks. A quote is a snapshot, not a reservation or an
/// atomic price guarantee: send() must check its debit and expiry bounds again.
import { type Address, zeroAddress } from "viem";
import { allowanceAbi, erc20Abi, executorAbi } from "./abi.js";
import { type Ctx, refusal } from "./context.js";
import { ALLOWANCE, CHAIN_ID, EXECUTOR, checksum, runLimits, token as tokenOf, toUnits } from "./deployment.js";
import { RemessoError } from "./errors.js";
import { memo32 } from "./payments.js";
import type { Policies, Policy } from "./policies.js";
import { exactRequest, type RemittanceFunding } from "./remittances.js";
import type { Requests, RequestStatus } from "./requests.js";
import { grossFor } from "./vendor/fee.js";

export type QuoteRemittanceInput = RemittanceFunding & {
  to: string;
  amount: string;
  token: string;
  requestId?: string;
  idempotencyKey?: string;
};
export type QuoteOptions = { /** Snapshot lifetime, from 1 to 300 seconds. Default 60. */ ttlSeconds?: number };
export type QuoteIssue = { code: string; message: string; step?: string };
export type QuoteGasStep = { step: "policy_payment" | "approval" | "creation" | "execution"; gas: bigint; basis: "rpc_estimate" | "conservative_hint" };
export type RemittanceQuote = {
  funding: "wallet" | "policy";
  chainId: typeof CHAIN_ID;
  signingAgent: Address;
  payer: Address | null;
  to: Address;
  token: Address;
  symbol: string;
  decimals: number;
  /** Exact recipient amount, in token base units. */
  amount: bigint;
  /** Token debit, including the protocol fee but excluding network gas. */
  grossDebit: bigint;
  protocolFee: bigint;
  feeBps: number;
  selectedPolicyId?: bigint;
  approval: {
    spender: Address;
    current: bigint;
    required: bigint;
    additional: bigint;
    /** Actual allowance target used by the wallet send implementation. */
    approvedAfter: bigint;
    needsApproval: boolean;
    /** Policy approvals need the policy owner's separate signature. */
    canApprove: boolean;
  };
  balance: bigint | null;
  canSend: boolean;
  issues: QuoteIssue[];
  simulation: { step: "policy_payment" | "approval" | "creation"; success: boolean; error?: string }[];
  gas: {
    steps: QuoteGasStep[];
    estimatedTotalGas: bigint;
    /** Current native gas price, not a future transaction fee cap. */
    gasPrice: bigint;
    estimatedNativeCost: bigint;
    feeCurrency?: Address;
    notes: string[];
  };
  /** Reference block; discovery and invoice HTTP reads are not an atomic snapshot. */
  checkedBlock: bigint;
  checkedAt: Date;
  expiresAt: Date;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const UINT256 = 2n ** 256n;

function policyId(value: bigint | number | string): bigint {
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error();
    if (typeof value === "string" && !/^\d+$/.test(value)) throw new Error();
    const id = BigInt(value);
    if (id < 0n || id >= UINT256) throw new Error();
    return id;
  } catch { throw new RemessoError("invalid", "policyId must be a nonnegative uint256 integer"); }
}

export function makeQuotes(ctx: Ctx, deps: { policies: Policies; requests: Requests }) {
  return {
    async quote(input: QuoteRemittanceInput, opts: QuoteOptions = {}): Promise<RemittanceQuote> {
      if (!input || !["wallet", "policy"].includes(input.funding)) throw new RemessoError("invalid", "choose funding: wallet or policy explicitly");
      const ttl = opts.ttlSeconds ?? 60;
      if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300) throw new RemessoError("invalid", "ttlSeconds must be an integer from 1 to 300");
      if (typeof input.amount !== "string") throw new RemessoError("invalid", "amount must be a decimal string");
      const account = ctx.requireAccount();
      const to = checksum(input.to);
      const t = tokenOf(input.token);
      const amount = toUnits(input.amount, t);
      if (amount <= 0n) throw new RemessoError("invalid", "amount must be positive");
      if (same(to, zeroAddress)) throw new RemessoError("invalid", "to must be a nonzero recipient");
      if (input.funding === "wallet" && (input.policyId != null || input.payer != null)) throw new RemessoError("invalid", "wallet funding cannot name another payer or a policy");
      if (input.funding === "wallet" && (BigInt(to) < 0x10000n || same(to, EXECUTOR) || same(to, account.address))) throw new RemessoError("invalid", "to must be another wallet and a valid schedule destination");
      const explicitPolicy = input.funding === "policy" && input.policyId != null ? policyId(input.policyId) : undefined;
      const requestedPayer = input.funding === "policy" && input.payer ? checksum(input.payer) : undefined;
      // No foreign-chain values are offered as a Celo quote.
      await ctx.assertChain();
      const [block, gasPrice, native] = await Promise.all([
        ctx.pub.getBlock(), ctx.pub.getGasPrice(), ctx.pub.getBalance({ address: account.address }),
      ]);
      const checkedAt = new Date();
      const issues: QuoteIssue[] = [];
      const simulation: RemittanceQuote["simulation"] = [];
      const steps: QuoteGasStep[] = [];
      const notes = ["Estimates are not transaction fee caps. Balances, fees, policies and gas prices can change before signing."];
      const issue = (code: string, message: string, step?: string) => issues.push({ code, message, ...(step ? { step } : {}) });
      if (account.type !== "local") issue("unsupported_signer", "durable remittance signing needs a local account with signTransaction support");
      if (ctx.pub.chain?.id !== CHAIN_ID) issue("missing_chain_metadata", "signing requires publicClient configured with chain: celo");
      let request: RequestStatus | undefined;
      if (input.requestId) {
        request = await deps.requests.get(input.requestId);
        try { exactRequest(request, input); }
        catch (e) { issue("invoice_mismatch", (e as Error).message, "invoice"); }
        if (request.payment) issue("invoice_already_answered", "the invoice already has payment or schedule evidence; reconcile it instead of preparing a new send", "invoice");
        if (input.funding === "wallet" && (request.status !== "pending" || !same(request.payer, account.address))) issue("invoice_payer", "a new wallet payment requires a pending invoice addressed to this wallet", "invoice");
        if (requestedPayer && !same(request.payer, requestedPayer)) issue("invoice_payer", "the requested policy payer differs from the invoice payer", "invoice");
      }
      let payer: Address | null = input.funding === "wallet" ? account.address : requestedPayer ?? request?.payer ?? null;
      let selected: Policy | undefined;
      let feeBps = 0;
      let grossDebit = amount;
      let balance: bigint | null = null;
      let approval: RemittanceQuote["approval"] = {
        spender: input.funding === "wallet" ? EXECUTOR : ALLOWANCE,
        current: 0n, required: amount, additional: amount, approvedAfter: amount,
        needsApproval: true, canApprove: input.funding === "wallet",
      };
      const simulate = async (step: RemittanceQuote["simulation"][number]["step"], address: Address, abi: typeof allowanceAbi | typeof executorAbi | typeof erc20Abi, functionName: string, args: readonly unknown[]) => {
        try {
          await ctx.pub.simulateContract({ address, abi, functionName, args, account, blockNumber: block.number } as never);
          simulation.push({ step, success: true });
          return true;
        } catch (e) {
          const message = refusal(e);
          simulation.push({ step, success: false, error: message });
          issue("simulation_failed", message, step);
          return false;
        }
      };
      const estimate = async (step: QuoteGasStep["step"], address: Address, abi: typeof allowanceAbi | typeof executorAbi | typeof erc20Abi, functionName: string, args: readonly unknown[], fallback: bigint) => {
        try {
          const gas = await ctx.pub.estimateContractGas({ address, abi, functionName, args, account, blockNumber: block.number } as never);
          if (gas <= 0n) throw new Error("empty gas estimate");
          // Leave headroom; this still is a hint, not a promised upper bound.
          steps.push({ step, gas: (gas * 125n + 99n) / 100n, basis: "rpc_estimate" });
        } catch {
          steps.push({ step, gas: fallback, basis: "conservative_hint" });
          notes.push(`${step}: RPC gas estimation was unavailable; the fallback is a planning hint, not an upper bound.`);
        }
      };

      if (input.funding === "wallet") {
        const [allowed, fee, current, held, lifetime] = await Promise.all([
          ctx.pub.readContract({ address: EXECUTOR, abi: executorAbi, functionName: "directTokenAllowed", args: [t.address], blockNumber: block.number }),
          ctx.pub.readContract({ address: EXECUTOR, abi: executorAbi, functionName: "feeBps", blockNumber: block.number }),
          ctx.pub.readContract({ address: t.address, abi: erc20Abi, functionName: "allowance", args: [account.address, EXECUTOR], blockNumber: block.number }),
          ctx.pub.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address], blockNumber: block.number }),
          ctx.pub.readContract({ address: EXECUTOR, abi: executorAbi, functionName: "MAX_LIFETIME", blockNumber: block.number }),
        ]);
        feeBps = Number(fee);
        if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) throw new RemessoError("refused", "the live protocol fee is outside the supported range");
        grossDebit = grossFor(amount, feeBps);
        balance = held;
        approval = { spender: EXECUTOR, current, required: grossDebit, additional: grossDebit, approvedAfter: current + grossDebit, needsApproval: true, canApprove: true };
        notes.push("Wallet sends create one capped schedule, then add this payment's budget to the existing token allowance before execution.");
        if (!allowed) issue("token_not_allowed", "the live executor does not accept this token for new Direct payments");
        try {
          const limits = runLimits(t);
          if (grossDebit < limits.min || grossDebit > limits.max) issue("run_limits", "the gross debit is outside this token's executor run limits");
        } catch (e) { issue("run_limits", (e as Error).message); }
        if (grossDebit >= 2n ** 128n) issue("amount_overflow", "the gross debit does not fit the schedule's uint128 amount");
        if (held < grossDebit) issue("insufficient_balance", "the wallet token balance cannot cover the exact recipient amount and protocol fee");
        if (approval.approvedAfter >= UINT256) issue("approval_overflow", "adding this payment's budget would overflow the token approval");
        const first = block.timestamp + 3600n;
        const expiry = block.timestamp + (lifetime < 86_400n ? lifetime : 86_400n);
        const args = [to, grossDebit, 3600n, 0n, 1, expiry, first, 2, t.address, zeroAddress, account.address, 1] as const;
        if (grossDebit < 2n ** 128n) {
          await simulate("creation", EXECUTOR, executorAbi, "createSchedule", args);
          await estimate("creation", EXECUTOR, executorAbi, "createSchedule", args, 450_000n);
        } else steps.push({ step: "creation", gas: 450_000n, basis: "conservative_hint" });
        if (approval.approvedAfter < UINT256) {
          await simulate("approval", t.address, erc20Abi, "approve", [EXECUTOR, approval.approvedAfter]);
          await estimate("approval", t.address, erc20Abi, "approve", [EXECUTOR, approval.approvedAfter], 100_000n);
        } else steps.push({ step: "approval", gas: 100_000n, basis: "conservative_hint" });
        steps.push({ step: "execution", gas: 300_000n, basis: "conservative_hint" });
        notes.push("Execution cannot be simulated until the schedule and allowance exist. Its gas is a conservative planning hint; creation simulation does not prove later execution will succeed.");
      } else {
        const acceptable = async (p: Policy) => {
          if (!p.active || !same(p.agent, account.address) || !same(p.token, t.address) || (payer && !same(p.owner, payer)) || p.spendable < amount || same(p.owner, to)) return false;
          return !p.allowlistOnly || await ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "allowed", args: [p.id, to], blockNumber: block.number });
        };
        if (explicitPolicy != null) {
          try { selected = await deps.policies.get(explicitPolicy); }
          catch (e) {
            if (!(e instanceof RemessoError) || e.code !== "not_found") throw e;
          }
        }
        else {
          const candidates: Policy[] = [];
          for (const id of await deps.policies.find()) {
            const p = await deps.policies.get(id);
            if (await acceptable(p)) { selected = p; break; }
            if (same(p.agent, account.address) && same(p.token, t.address) && (!payer || same(p.owner, payer))) candidates.push(p);
          }
          selected ??= candidates[0];
        }
        if (!selected) issue("no_policy", "no policy for this agent, token and requested payer was found");
        else {
          const p = selected;
          if (payer && !same(p.owner, payer)) issue("policy_payer", "the selected policy belongs to another payer");
          payer = p.owner;
          balance = p.ownerBalance;
          approval = { spender: ALLOWANCE, current: p.ownerAllowance, required: amount,
            additional: p.ownerAllowance < amount ? amount - p.ownerAllowance : 0n,
            approvedAfter: p.ownerAllowance < amount ? amount : p.ownerAllowance,
            needsApproval: p.ownerAllowance < amount, canApprove: same(p.owner, account.address) };
          if (!same(p.agent, account.address)) issue("policy_agent", "the policy names a different agent");
          if (!same(p.token, t.address)) issue("policy_token", "the policy spends a different token");
          if (!p.active || p.expiresAt.getTime() <= checkedAt.getTime()) issue("policy_inactive", p.revoked ? "the policy was revoked" : "the policy has expired");
          if (same(p.owner, to)) issue("policy_self_payment", "a policy cannot pay its own owner");
          if (amount > p.perPayment) issue("policy_per_payment", "the amount exceeds the policy's per-payment cap");
          if (amount > p.remainingToday) issue("policy_daily_limit", "the amount exceeds the remaining fixed 24-hour policy window");
          if (amount > p.ownerBalance) issue("insufficient_balance", "the policy owner's balance is too low");
          if (amount > p.ownerAllowance) issue("approval_required", "the policy owner must increase their token approval before this payment can proceed");
          if (p.allowlistOnly && !await ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "allowed", args: [p.id, to], blockNumber: block.number })) issue("recipient_not_allowed", "the recipient is not on the policy allowlist");
          if (issues.length === 0) {
            const args = [p.id, to, amount, memo32(request?.reference)] as const;
            await simulate("policy_payment", ALLOWANCE, allowanceAbi, "pay", args);
            await estimate("policy_payment", ALLOWANCE, allowanceAbi, "pay", args, 160_000n);
          }
        }
        if (steps.length === 0) steps.push({ step: "policy_payment", gas: 160_000n, basis: "conservative_hint" });
        notes.push("Policy discovery and availability reads may span blocks; no daily budget or allowance is reserved by this quote.");
      }
      const estimatedTotalGas = steps.reduce((sum, step) => sum + step.gas, 0n);
      const estimatedNativeCost = estimatedTotalGas * gasPrice;
      let feeCurrency: Address | undefined;
      if (native < estimatedNativeCost * 2n) {
        if (t.feeCurrency) {
          const signerTokens = input.funding === "wallet" ? balance ?? 0n : await ctx.pub.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address], blockNumber: block.number });
          if (signerTokens > (input.funding === "wallet" ? grossDebit : 0n)) {
            feeCurrency = t.feeCurrency as Address;
            notes.push("The signer has a supported Celo fee currency. Its converted network charge is not quoted here; estimatedNativeCost is CELO-denominated only and does not include an adapter conversion rate.");
          } else issue("insufficient_gas", "the signer needs CELO or a supported fee-currency balance beyond the payment debit");
        } else issue("insufficient_gas", "the signer needs CELO to cover network gas");
      }
      return {
        funding: input.funding, chainId: CHAIN_ID, signingAgent: account.address, payer, to, token: t.address,
        symbol: t.symbol, decimals: t.decimals, amount, grossDebit, protocolFee: grossDebit - amount, feeBps,
        ...(selected ? { selectedPolicyId: selected.id } : {}), approval, balance,
        canSend: issues.length === 0, issues, simulation,
        gas: { steps, estimatedTotalGas, gasPrice, estimatedNativeCost, ...(feeCurrency ? { feeCurrency } : {}), notes },
        checkedBlock: block.number, checkedAt, expiresAt: new Date(checkedAt.getTime() + ttl * 1000),
      };
    },
  };
}

export type Quotes = ReturnType<typeof makeQuotes>;
