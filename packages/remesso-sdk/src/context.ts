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
  formatEther,
} from "viem";
import { celo } from "viem/chains";
import { erc20Abi } from "./abi.js";
import { CHAIN_ID, type Token } from "./deployment.js";
import { RemessoError } from "./errors.js";
import type { PaymentStore } from "./store.js";

export type Ctx = {
  pub: PublicClient;
  wallet: WalletClient | null;
  account: Account | null;
  endpoints: { requestPayment: string; paymentEvents: string; webhooks: string };
  appOrigin: string;
  fetch: typeof fetch;
  dataSuffix: Hex | undefined;
  store: PaymentStore;
  fetchText?: (url: string) => Promise<string>;
  assertChain(): Promise<void>;
  requireAccount(): Account;
  post<T>(url: string, body: unknown): Promise<T>;
  get<T>(url: string): Promise<T>;
  /// One at a time: two sends in parallel would sign with the same nonce.
  serial<T>(fn: () => Promise<T>): Promise<T>;
};

export function makeCtx(parts: Omit<Ctx, "assertChain" | "requireAccount" | "post" | "get" | "serial">): Ctx {
  let chainCheck: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

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
    assertChain() {
      chainCheck ??= parts.pub.getChainId().then((id) => {
        if (id !== CHAIN_ID) {
          throw new RemessoError("wrong_chain", `the RPC answers chain ${id}, not Celo mainnet (${CHAIN_ID}), so nothing is signed`);
        }
      }).catch((e) => {
        chainCheck = null; // ask again next time: the RPC may have been down
        throw e;
      });
      return chainCheck;
    },
    requireAccount() {
      if (!parts.account) throw new RemessoError("no_account", "this needs an account: createRemesso({ account })");
      return parts.account;
    },
    post: (url, body) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    get: (url) => request(url, { method: "GET" }),
    serial(fn) {
      const run = queue.then(fn, fn);
      queue = run.catch(() => {});
      return run;
    },
  };
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
  const fee = await gasFor(ctx, w.gasToken);
  try {
    await ctx.pub.simulateContract({ address: w.address, abi: w.abi, functionName: w.functionName, args: w.args, account, ...fee } as never);
  } catch (e) {
    throw new RemessoError("refused", `the contract would refuse ${w.functionName}: ${refusal(e)}`, { cause: String(e) });
  }
  const hash = await ctx.wallet.writeContract({
    address: w.address,
    abi: w.abi,
    functionName: w.functionName,
    args: w.args,
    account,
    chain: celo,
    dataSuffix: ctx.dataSuffix,
    ...(w.nonce != null ? { nonce: w.nonce } : {}),
    ...fee,
  } as never);
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
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
