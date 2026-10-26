import { assertEquals, assertRejects } from "@std/assert";
import { toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import type { Ctx } from "../src/context.ts";
import { ALLOWANCE, EXECUTOR, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import type { Policies, Policy } from "../src/policies.ts";
import { makeQuotes, type QuoteRemittanceInput } from "../src/quotes.ts";
import type { Requests, RequestStatus } from "../src/requests.ts";
import { feeOf, netOf } from "../src/vendor/fee.ts";

const signer = privateKeyToAccount(toHex(919191, { size: 32 }));
const owner = privateKeyToAccount(toHex(919192, { size: 32 })).address;
const recipient = privateKeyToAccount(toHex(919193, { size: 32 })).address;
const asset = token("USDT");
const walletInput: QuoteRemittanceInput = { funding: "wallet", to: recipient, amount: "1", token: "USDT" };
const policyInput: QuoteRemittanceInput = { ...walletInput, funding: "policy", payer: owner };

function policy(id = 1n, overrides: Partial<Policy> = {}): Policy {
  return { id, owner, agent: signer.address, token: asset.address, symbol: asset.symbol,
    perPayment: 10_000_000n, perDay: 100_000_000n, expiresAt: new Date(Date.now() + 86_400_000),
    allowlistOnly: false, revoked: false, remainingToday: 100_000_000n, ownerBalance: 100_000_000n,
    ownerAllowance: 100_000_000n, active: true, spendable: 10_000_000n, ...overrides };
}
function request(overrides: Partial<RequestStatus> = {}): RequestStatus {
  return { id: "11111111-1111-4111-8111-111111111111", reference: "11".repeat(16), status: "pending", payer: signer.address,
    requested: { to: recipient, amount: "1", token: "USDT", intervalSeconds: null, runs: null }, signed: null, payment: null, ...overrides };
}
type HarnessOptions = {
  balance?: bigint; allowance?: bigint; native?: bigint; gasPrice?: bigint; fee?: number; allowed?: boolean;
  recipientAllowed?: boolean; policies?: Policy[]; invoice?: RequestStatus; simulationError?: string; estimateError?: boolean;
  chainId?: number; chainMetadata?: boolean;
};
function harness(opts: HarnessOptions = {}) {
  const reads: string[] = [];
  const simulated: { name: string; args: readonly unknown[]; account: { address: Address } }[] = [];
  const estimated: string[] = [];
  const ps = opts.policies ?? [policy()];
  let invoiceReads = 0;
  const write = () => { throw new Error("a quote must not sign, broadcast, reserve a nonce or write a journal"); };
  const ctx = {
    pub: {
      chain: opts.chainMetadata === false ? undefined : celo,
      getBlock: async () => ({ number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
      getGasPrice: async () => opts.gasPrice ?? 2n,
      getBalance: async () => opts.native ?? 10n ** 20n,
      readContract: async ({ functionName }: { functionName: string }) => {
        reads.push(functionName);
        const values: Record<string, unknown> = {
          directTokenAllowed: opts.allowed ?? true, feeBps: opts.fee ?? 25,
          allowance: opts.allowance ?? 5_000_000n, balanceOf: opts.balance ?? 100_000_000n,
          MAX_LIFETIME: 31_536_000n, allowed: opts.recipientAllowed ?? true,
        };
        if (!(functionName in values)) throw new Error(`unexpected read ${functionName}`);
        return values[functionName];
      },
      simulateContract: async ({ functionName, args, account }: { functionName: string; args: readonly unknown[]; account: { address: Address } }) => {
        simulated.push({ name: functionName, args, account });
        if (opts.simulationError) throw new Error(opts.simulationError);
        return {};
      },
      estimateContractGas: async ({ functionName }: { functionName: string }) => {
        estimated.push(functionName);
        if (opts.estimateError) throw new Error("estimate unavailable");
        return 100_001n;
      },
      sendRawTransaction: write, writeContract: write, signTransaction: write,
    },
    requireAccount: () => signer,
    assertChain: async () => { if ((opts.chainId ?? 42220) !== 42220) throw new RemessoError("wrong_chain", "wrong RPC chain"); },
    wallet: { signTransaction: write, signTypedData: write, writeContract: write },
    store: { save: write, since: write, byKey: write },
    remittanceStore: { save: write, list: write, get: write },
    nextNonce: write, noteNonce: write, serial: write, post: write, get: write, fetch: write,
  } as unknown as Ctx;
  const policies = { find: async () => ps.map((p) => p.id), get: async (id: bigint | number | string) => {
    const p = ps.find((p) => p.id === BigInt(id));
    if (!p) throw new RemessoError("not_found", "policy not found");
    return p;
  } } as Policies;
  const requests = { get: async () => { invoiceReads++; return opts.invoice ?? request(); } } as unknown as Requests;
  return { quotes: makeQuotes(ctx, { policies, requests }), reads, simulated, estimated, invoiceReads: () => invoiceReads };
}

Deno.test("wallet quote uses exact ceiling fees and is entirely read-only", async () => {
  const h = harness();
  const q = await h.quotes.quote(walletInput);
  assertEquals([q.amount, q.grossDebit, q.protocolFee, q.feeBps], [1_000_000n, 1_002_507n, 2_507n, 25]);
  assertEquals(feeOf(q.grossDebit, q.feeBps), q.protocolFee);
  assertEquals(netOf(q.grossDebit, q.feeBps), q.amount);
  assertEquals(netOf(q.grossDebit - 1n, q.feeBps) < q.amount, true);
  assertEquals([q.signingAgent, q.payer, q.to, q.token], [signer.address, signer.address, recipient, asset.address]);
  assertEquals(q.approval, { spender: EXECUTOR, current: 5_000_000n, required: 1_002_507n, additional: 1_002_507n,
    approvedAfter: 6_002_507n, needsApproval: true, canApprove: true });
  assertEquals(h.simulated.map((s) => s.name), ["createSchedule", "approve"]);
  assertEquals([q.checkedBlock, q.canSend, q.issues, h.invoiceReads()], [100n, true, [], 0]);
  assertEquals(q.expiresAt.getTime() - q.checkedAt.getTime(), 60_000);
  assertEquals(q.gas.steps, [{ step: "creation", gas: 125_002n, basis: "rpc_estimate" },
    { step: "approval", gas: 125_002n, basis: "rpc_estimate" }, { step: "execution", gas: 300_000n, basis: "conservative_hint" }]);
  assertEquals(q.gas.estimatedNativeCost, q.gas.estimatedTotalGas * q.gas.gasPrice);
});

Deno.test("wallet quote reports funds, run limits and token readiness without changing allowance", async () => {
  const h = harness({ balance: 999_999n, allowed: false });
  const q = await h.quotes.quote({ ...walletInput, amount: "1001" });
  assertEquals(q.canSend, false);
  assertEquals(q.issues.map((i) => i.code), ["token_not_allowed", "run_limits", "insufficient_balance"]);
  assertEquals(q.balance, 999_999n);
  assertEquals(q.approval.needsApproval, true);
});

Deno.test("wallet simulations return structured refusal and estimates admit fallback uncertainty", async () => {
  const h = harness({ simulationError: "destination forbidden", estimateError: true });
  const q = await h.quotes.quote(walletInput, { ttlSeconds: 12 });
  assertEquals(q.canSend, false);
  assertEquals(q.simulation.map((s) => [s.step, s.success, s.error]), [
    ["creation", false, "destination forbidden"], ["approval", false, "destination forbidden"],
  ]);
  assertEquals(q.issues.every((i) => i.code === "simulation_failed"), true);
  assertEquals(q.gas.steps.every((s) => s.basis === "conservative_hint"), true);
  assertEquals(q.gas.notes.some((s) => s.includes("not an upper bound")), true);
  assertEquals(q.expiresAt.getTime() - q.checkedAt.getTime(), 12_000);
});

Deno.test("policy quotes select a funded eligible policy rather than the newest unusable policy", async () => {
  const h = harness({ policies: [policy(3n, { agent: recipient }), policy(2n, { spendable: 0n, ownerBalance: 0n }), policy(1n)] });
  const q = await h.quotes.quote(policyInput);
  assertEquals([q.canSend, q.selectedPolicyId, q.payer, q.grossDebit, q.protocolFee, q.feeBps], [true, 1n, owner, 1_000_000n, 0n, 0]);
  assertEquals(q.approval, { spender: ALLOWANCE, current: 100_000_000n, required: 1_000_000n, additional: 0n,
    approvedAfter: 100_000_000n, needsApproval: false, canApprove: false });
  assertEquals(h.simulated.map((s) => s.name), ["pay"]);
  assertEquals(h.simulated[0].args.slice(0, 3), [1n, recipient, 1_000_000n]);
});

Deno.test("policy quote exposes owner approval and cap failures without trying to approve as the agent", async () => {
  const h = harness({ policies: [policy(1n, { perPayment: 900_000n, remainingToday: 800_000n, ownerBalance: 700_000n, ownerAllowance: 600_000n, spendable: 600_000n })] });
  const q = await h.quotes.quote({ ...policyInput, policyId: 1n });
  assertEquals(q.canSend, false);
  assertEquals(q.issues.map((i) => i.code), ["policy_per_payment", "policy_daily_limit", "insufficient_balance", "approval_required"]);
  assertEquals([q.approval.additional, q.approval.canApprove, h.simulated], [400_000n, false, []]);
});

Deno.test("explicit policy quote checks owner, agent, token, activation and recipient allowlist", async () => {
  const otherToken = token("USDC").address;
  const h = harness({ policies: [policy(1n, { owner: recipient, agent: owner, token: otherToken, active: false, revoked: true, allowlistOnly: true })], recipientAllowed: false });
  const q = await h.quotes.quote({ ...policyInput, policyId: "1" });
  assertEquals(q.canSend, false);
  for (const code of ["policy_payer", "policy_agent", "policy_token", "policy_inactive", "policy_self_payment", "recipient_not_allowed"]) {
    assertEquals(q.issues.some((i) => i.code === code), true, code);
  }
  assertEquals(h.simulated, []);
});

Deno.test("absent policy is a useful blocked quote without a guessed payer", async () => {
  const h = harness({ policies: [] });
  const q = await h.quotes.quote({ funding: "policy", to: recipient, amount: "1", token: "USDT" });
  assertEquals([q.canSend, q.payer, q.balance, q.selectedPolicyId], [false, null, null, undefined]);
  assertEquals(q.issues.map((i) => i.code), ["no_policy"]);
  assertEquals(q.gas.steps[0].basis, "conservative_hint");
  const missingExplicit = await h.quotes.quote({ ...policyInput, policyId: 999n });
  assertEquals([missingExplicit.canSend, missingExplicit.issues[0].code], [false, "no_policy"]);
});

Deno.test("quotes enforce exact one-off invoice terms and payer before payment simulation", async () => {
  const req = request({ payer: owner });
  const h = harness({ invoice: req });
  const q = await h.quotes.quote({ ...policyInput, requestId: req.id });
  assertEquals([q.canSend, q.payer, h.invoiceReads()], [true, owner, 1]);
  assertEquals(h.simulated[0].args[3], toHex(req.reference, { size: 32 }));
  const changed = harness({ invoice: { ...req, requested: { ...req.requested, amount: "2", intervalSeconds: 3600 } } });
  const mismatch = await changed.quotes.quote({ ...policyInput, requestId: req.id });
  assertEquals([mismatch.canSend, mismatch.issues.some((i) => i.code === "invoice_mismatch"), changed.simulated], [false, true, []]);
  const wrongPayer = harness({ invoice: req });
  const wallet = await wrongPayer.quotes.quote({ ...walletInput, requestId: req.id });
  assertEquals([wallet.canSend, wallet.issues.some((i) => i.code === "invoice_payer")], [false, true]);
});

Deno.test("existing invoice payment evidence cannot prepare a second remittance", async () => {
  const req = request({ payer: owner, payment: { state: "scheduled", schedule: { contract: EXECUTOR, id: "17" }, txs: [], reason: null } });
  const h = harness({ invoice: req });
  const q = await h.quotes.quote({ ...policyInput, requestId: req.id });
  assertEquals(q.issues.some((i) => i.code === "invoice_already_answered"), true);
  assertEquals([q.canSend, h.simulated], [false, []]);
});

Deno.test("quotes validate decimal strings, IDs, options and network without signing", async () => {
  const cases: [unknown, unknown?][] = [
    [{ ...walletInput, funding: "guess" }], [{ ...walletInput, amount: 1.01 }], [{ ...walletInput, amount: "0" }],
    [{ ...walletInput, amount: "1.0000001" }], [{ ...walletInput, token: "DOGE" }], [{ ...walletInput, to: signer.address }],
    [{ ...walletInput, payer: owner }], [{ ...policyInput, policyId: 1.1 }], [{ ...policyInput, policyId: "bad" }],
    [walletInput, { ttlSeconds: 0 }], [walletInput, { ttlSeconds: 301 }], [walletInput, { ttlSeconds: 1.5 }],
  ];
  for (const [input, opts] of cases) {
    const h = harness();
    const e = await assertRejects(() => h.quotes.quote(input as QuoteRemittanceInput, opts as { ttlSeconds?: number }), RemessoError);
    assertEquals(e.code, "invalid"); assertEquals(h.simulated, []);
  }
  const h = harness({ chainId: 1 });
  assertEquals((await assertRejects(() => h.quotes.quote(walletInput), RemessoError)).code, "wrong_chain");
  assertEquals(h.reads, []);
});

Deno.test("gas readiness separates CELO planning cost from unquoted fee-currency charges", async () => {
  const enoughToken = await harness({ native: 0n }).quotes.quote(walletInput);
  assertEquals([enoughToken.canSend, enoughToken.gas.feeCurrency], [true, asset.feeCurrency]);
  assertEquals(enoughToken.gas.notes.some((s) => s.includes("converted network charge is not quoted")), true);
  const justPayment = await harness({ native: 0n, balance: 1_002_507n }).quotes.quote(walletInput);
  assertEquals([justPayment.canSend, justPayment.issues.some((i) => i.code === "insufficient_gas")], [false, true]);
  const policyNoGas = await harness({ native: 0n, balance: 0n }).quotes.quote(policyInput);
  assertEquals([policyNoGas.canSend, policyNoGas.issues.some((i) => i.code === "insufficient_gas")], [false, true]);
});

Deno.test("quotes retain exact 18-decimal token amounts and identify missing Celo chain metadata", async () => {
  const h = harness({ balance: 10n ** 25n, chainMetadata: false });
  const q = await h.quotes.quote({ ...walletInput, token: "USDm", amount: "1.000000000000000001" });
  assertEquals(q.amount, 1_000_000_000_000_000_001n);
  assertEquals(q.grossDebit - q.protocolFee, q.amount);
  assertEquals(q.issues.some((i) => i.code === "missing_chain_metadata"), true);
  assertEquals(q.canSend, false);
});
