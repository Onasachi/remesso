/// What every part of the client shares: the chain, the account, the
/// endpoints, and the few rules every write follows.
import {
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  concat,
  encodeFunctionData,
  formatEther,
  keccak256,
} from "viem";
import { prepareTransactionRequest, sendRawTransaction, signTransaction } from "viem/actions";
import { celo } from "viem/chains";
import { erc20Abi } from "./abi.js";
import { ALLOWANCE, CHAIN_ID, EXECUTOR, type Token } from "./deployment.js";
import { RemessoError } from "./errors.js";
import type { PaymentStore } from "./store.js";
import type { RemittanceStore } from "./remittance-store.js";
import type { SignerCoordinator, SignerLease } from "./coordination.js";

export type Ctx = {
  pub: PublicClient;
  wallet: WalletClient | null;
  account: Account | null;
  endpoints: { requestPayment: string; paymentEvents: string; webhooks: string };
  appOrigin: string;
  fetch: typeof fetch;
  dataSuffix: Hex | undefined;
  store: PaymentStore;
  remittanceStore?: RemittanceStore;
  coordinator?: SignerCoordinator;
  fetchText?: (url: string) => Promise<string>;
  assertChain(): Promise<void>;
  requireAccount(): Account;
  post<T>(url: string, body: unknown): Promise<T>;
  get<T>(url: string): Promise<T>;
  /// One at a time: two sends in parallel would sign with the same nonce.
  serial<T>(fn: () => Promise<T>): Promise<T>;
  assertActive(): Promise<void>;
  nextNonce(): Promise<number>;
  noteNonce(nonce: number): Promise<void>;
};

// Multiple clients for the same signer in one process share a queue and nonce
// floor. A second client must not race a payment's durable-store lookup.
const signers = new Map<string, { queue: Promise<unknown>; nonce: number }>();

export function makeCtx(parts: Omit<Ctx, "assertChain" | "requireAccount" | "post" | "get" | "serial" | "assertActive" | "nextNonce" | "noteNonce">): Ctx {
  const key = parts.account?.address.toLowerCase();
  const state = (key && signers.get(key)) || { queue: Promise.resolve(), nonce: 0 };
  if (key) signers.set(key, state);
  const scope = key ? `${CHAIN_ID}:${key}` : null;
  let lease: SignerLease | undefined;
  const assertActive = async () => { if (lease) await lease.assertActive(); };

  const request = async <T>(url: string, init: RequestInit): Promise<T> => {
    let res: Response;
    try {
      res = await parts.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new RemessoError("http", `couldn't reach ${url}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    if (!res.ok) {
      const said = (body as { error?: string; detail?: string } | null);
      const message = said?.error ? `${said.error}${said.detail ? `: ${said.detail}` : ""}` : `${res.status} ${text.slice(0, 200)}`;
      const code = res.status === 400 ? "invalid" : res.status === 404 ? "not_found" : res.status === 409 ? "conflict"
        : [401, 403, 429].includes(res.status) ? "refused" : "http";
      throw new RemessoError(code, message, { status: res.status, body });
    }
    return body as T;
  };

  return {
    ...parts,
    async assertChain() {
      // Browser wallets can switch networks, and caller-supplied public and
      // wallet clients can point at different RPCs. Check both on every write.
      const ids = await Promise.all([parts.pub.getChainId(), ...(parts.wallet ? [parts.wallet.getChainId()] : [])]);
      for (const id of ids) {
        if (id !== CHAIN_ID) {
          throw new RemessoError("wrong_chain", `the RPC answers chain ${id}, not Celo mainnet (${CHAIN_ID}), so nothing is signed`);
        }
      }
    },
    requireAccount() {
      if (!parts.account) throw new RemessoError("no_account", "this needs an account: createRemesso({ account })");
      return parts.account;
    },
    post: (url, body) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    get: (url) => request(url, { method: "GET" }),
    serial(fn) {
      const locked = () => parts.coordinator && scope ? parts.coordinator.runExclusive(scope, async (held) => {
        lease = held;
        try { await assertActive(); return await fn(); }
        finally { lease = undefined; }
      }) : fn();
      const run = state.queue.then(locked, locked);
      state.queue = run.catch(() => {});
      return run;
    },
    assertActive,
    async nextNonce() {
      await assertActive();
      if (!parts.account) throw new RemessoError("no_account", "this needs an account");
      const address = parts.account.address.toLowerCase();
      const policyScope = `${CHAIN_ID}:${ALLOWANCE.toLowerCase()}:${address}`;
      const walletScope = `${CHAIN_ID}:${EXECUTOR.toLowerCase()}:${address}`;
      const [pending, payments, remittances] = await Promise.all([
        parts.pub.getTransactionCount({ address: parts.account.address, blockTag: "pending" }),
        parts.store.since(0),
        parts.remittanceStore?.list(walletScope) ?? Promise.resolve([]),
      ]);
      // A new key after restart must not replace another key's signed bytes,
      // even when the pending RPC lags or the funding model changes.
      let nonce = Math.max(state.nonce, pending);
      for (const payment of payments) if (payment.deployment === policyScope) nonce = Math.max(nonce, payment.nonce + 1);
      for (const record of remittances) {
        if (record.scope !== walletScope || record.payer.toLowerCase() !== address) throw new RemessoError("conflict", "the remittance store returned another signer's nonce history");
        for (const step of [record.approval, record.creation, record.execution, record.cancellation]) if (step) nonce = Math.max(nonce, step.nonce + 1);
      }
      return parts.coordinator?.nextNonce && scope ? await parts.coordinator.nextNonce(scope, nonce) : nonce;
    },
    async noteNonce(nonce) {
      state.nonce = Math.max(state.nonce, nonce + 1);
      await assertActive();
      if (parts.coordinator?.noteNonce && scope) await parts.coordinator.noteNonce(scope, nonce);
    },
  };
}

/// Reads until `ready` holds, for a few seconds at most. Right after a
/// transaction lands, a node behind forno's load balancer can still answer
/// from an earlier block, so a schedule or policy this client created a
/// moment ago can read as empty. The mainnet run hit exactly that.
export async function untilVisible<T>(read: () => Promise<T>, ready: (v: T) => boolean, waitMs = 6_000): Promise<T> {
  const until = Date.now() + waitMs;
  for (;;) {
    const v = await read();
    if (ready(v) || Date.now() >= until) return v;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/// Gas: CELO if the account holds enough, else the token itself through
/// Celo's fee abstraction, for the tokens that support it. A payer who holds
/// only USD₮ can still create a schedule.
export async function gasFor(ctx: Ctx, t: Token | null, gas = 300_000n): Promise<{ feeCurrency?: Address }> {
  const account = ctx.requireAccount();
  const [native, price] = await Promise.all([ctx.pub.getBalance({ address: account.address }), ctx.pub.getGasPrice()]);
  const need = gas * price * 2n;
  if (native >= need) return {};
  if (t?.feeCurrency) {
    const held = await ctx.pub.readContract({ address: t.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (held > 0n) return { feeCurrency: t.feeCurrency as Address };
  }
  throw new RemessoError(
    "no_gas",
    `${account.address} has ${formatEther(native)} CELO, and this costs about ${formatEther(gas * price)}. ` +
      `Send it a little CELO${t?.feeCurrency ? `, or hold some ${t.symbol}, which can pay for gas` : ""}.`,
  );
}

type WriteArgs = {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  gasToken: Token | null;
  /// For a second transaction straight after a first: right after one lands,
  /// a node behind forno's load balancer can still report the old count.
  nonce?: number;
};

/// Simulate, send, and wait for the receipt. A mined transaction isn't a
/// successful one: viem returns a reverted receipt without throwing, so this
/// checks it.
export async function write(ctx: Ctx, w: WriteArgs): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  await ctx.assertChain();
  const account = ctx.requireAccount();
  if (!ctx.wallet) throw new RemessoError("no_account", "this needs an account that can send transactions");
  if (ctx.coordinator && (account.type !== "local" || !ctx.coordinator.recordSigned || ctx.pub.chain?.id !== CHAIN_ID)) {
    throw new RemessoError("invalid", "coordinated writes need a sign-only local account, publicClient configured with chain: celo, and coordinator.recordSigned so transaction bytes are saved before broadcast");
  }
  const fee = await gasFor(ctx, w.gasToken);
  try {
    await ctx.pub.simulateContract({ address: w.address, abi: w.abi, functionName: w.functionName, args: w.args, account, ...fee } as never);
  } catch (e) {
    throw new RemessoError("refused", `the contract would refuse ${w.functionName}: ${refusal(e)}`, { cause: String(e) });
  }
  const nonce = w.nonce ?? await ctx.nextNonce();
  await ctx.assertActive();
  let hash: Hex;
  if (ctx.coordinator) {
    const data = encodeFunctionData({ abi: w.abi, functionName: w.functionName, args: w.args });
    const request = await prepareTransactionRequest(ctx.pub, {
      account, nonce, to: w.address, data: ctx.dataSuffix ? concat([data, ctx.dataSuffix]) : data, ...fee,
    } as never);
    await ctx.assertActive();
    const raw = await signTransaction(ctx.pub, { ...request, account } as never);
    hash = keccak256(raw);
    try {
      await ctx.assertActive();
      await ctx.coordinator.recordSigned!(`${CHAIN_ID}:${account.address.toLowerCase()}`, { nonce, hash, raw });
      await ctx.noteNonce(nonce);
      await ctx.assertActive();
      await sendRawTransaction(ctx.pub, { serializedTransaction: raw });
    } catch (e) {
      throw new RemessoError("conflict", `${w.functionName} has signed transaction ${hash}; inspect its nonce journal and original hash before retrying this action`, { hash, nonce, cause: String(e) });
    }
  } else {
    hash = await ctx.wallet.writeContract({
      address: w.address, abi: w.abi, functionName: w.functionName, args: w.args,
      account, chain: celo, dataSuffix: ctx.dataSuffix, nonce, ...fee,
    } as never);
    await ctx.noteNonce(nonce);
  }
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new RemessoError("conflict", `${w.functionName} was replaced; its replacement is not proof this action succeeded`, { hash, replacement: receipt.transactionHash });
  }
  if (receipt.status !== "success") {
    throw new RemessoError("reverted", `${w.functionName} reverted on-chain, so nothing changed: https://celoscan.io/tx/${hash}`, { hash });
  }
  return { hash, receipt };
}

/// Why the contract refused, in words a person can act on. Errors neither
/// contract names fall through to viem's short message.
export function refusal(e: unknown): string {
  const err = e as { cause?: { data?: { errorName?: string } }; data?: { errorName?: string }; shortMessage?: string; message?: string };
  const name = err?.cause?.data?.errorName ?? err?.data?.errorName ??
    (err as { cause?: { cause?: { data?: { errorName?: string } } } })?.cause?.cause?.data?.errorName;
  const known: Record<string, string> = {
    // RemessoAgentAllowance
    NotAgent: "the policy names a different agent",
    NotOwner: "only the policy's owner can do that",
    Revoked: "the policy was revoked",
    Expired: "the policy has expired",
    OverPerPayment: "the amount is over the policy's per-payment cap",
    OverPerDay: "today's cap is used up; it resets 24 hours after the day's first payment",
    RecipientNotAllowed: "the recipient isn't on the policy's allowlist",
    SelfPayment: "a policy can't pay its own owner",
    SafeERC20FailedOperation: "the token refused the transfer: the balance or the approval is too low",
    BadExpiry: "the expiry is in the past or too far ahead",
    BadLimits: "the per-payment cap must be above zero and at most the daily cap",
    TooManyRecipients: "too many recipients for one policy",
    // RemessoExecutorV5
    TokenNotAllowed: "the contract doesn't accept this token for new schedules",
    InvalidAmount: "the amount is zero or too large",
    InvalidInterval: "the interval is out of range",
    InvalidDestination: "the recipient address isn't allowed",
    ScheduleLifetimeTooLong: "the schedule would last longer than a year",
    FirstRunAfterExpiry: "the first payment would fall after the schedule expires",
    NotScheduleOwner: "only the schedule's sender can do that",
    ScheduleIsCancelled: "the schedule is cancelled",
    InvalidTrigger: "that address can't be a trigger (grant Remesso with the CURRENT_EXECUTOR sentinel)",
    ZeroAddress: "an address is zero",
    ZeroAmount: "the amount is zero",
  };
  return (name && known[name]) ?? name ?? String(err?.shortMessage ?? err?.message ?? e);
}
