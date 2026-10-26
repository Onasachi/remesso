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
  formatTransactionReceipt,
  keccak256,
  toHex,
} from "viem";
import { prepareTransactionRequest, sendRawTransaction, signTransaction } from "viem/actions";
import { parseTransaction } from "viem/celo";
import { celo } from "viem/chains";
import { erc20Abi } from "./abi.js";
import { CHAIN_ID, type Token } from "./deployment.js";
import { RemessoError } from "./errors.js";
import type { PaymentStore } from "./store.js";
import type { RemittanceStore } from "./remittance-store.js";
import type { SignerCoordinator, SignerLease } from "./coordination.js";

/// A saved, signed transaction whose nonce the chain hasn't used yet. Every
/// journal reports these, so the next nonce can be chosen with them in view.
export type OpenTx = {
  nonce: number;
  hash: Hex;
  raw: Hex;
  /** When the bytes were saved, in ms since the epoch. */
  savedAt: number;
  /** Send these bytes again. False once the intent must not land any more. */
  resend: boolean;
  /** A no-op already signed at this nonce to cancel the bytes above. */
  cancel?: { hash: Hex; raw: Hex };
  /** Sign, save and broadcast a no-op at this nonce. Required when resend is false. */
  cancelNow?: () => Promise<void>;
};

/// Unsent bytes younger than this may still be on their way to a node behind
/// the load balancer, so they are not cancelled yet.
const CANCEL_GRACE_MS = 30_000;
/// How long a nonce noted in this process is trusted over the chain's count.
const NOTED_NONCE_MS = 120_000;

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
  /// The nonce for the next signed transaction. Before choosing it, every
  /// journal's unsent bytes are broadcast again in nonce order, or cancelled
  /// once their deadline has passed, so one lost broadcast can't hold up
  /// every transaction signed after it.
  nextNonce(): Promise<number>;
  noteNonce(nonce: number): Promise<void>;
  /// A journal of signed transactions, read with the first nonce not yet used.
  addJournal(read: (fromNonce: number) => Promise<OpenTx[]>): void;
  /// Broadcast signed bytes, retrying a failing RPC twice. True once a node
  /// accepted them, already had them, or their nonce is already used.
  resend(raw: Hex): Promise<boolean>;
  /// A signed no-op at `nonce`: whichever of it and the bytes it cancels
  /// lands first is the only one that ever can. Given those bytes, it outbids
  /// them, or a node holding them would keep them and refuse it.
  signCancel(nonce: number, gasToken?: Token | null, replaces?: Hex): Promise<{ hash: Hex; raw: Hex }>;
  /// Settle every journal's open transactions below `nonce`, as `nextNonce`
  /// does: a retry of something stuck behind a lost broadcast fills the gap
  /// instead of waiting for some new payment to.
  unblock(nonce: number): Promise<void>;
};

// Multiple clients for the same signer in one process share a queue and nonce
// floor. A second client must not race a payment's durable-store lookup.
const signers = new Map<string, { queue: Promise<unknown>; nonce: number; notedAt: number }>();

const notFound = (e: unknown) => ["TransactionNotFoundError", "TransactionReceiptNotFoundError"].includes((e as { name?: string })?.name ?? "");

export function makeCtx(parts: Omit<Ctx, "assertChain" | "requireAccount" | "post" | "get" | "serial" | "assertActive" | "nextNonce" | "noteNonce" | "addJournal" | "resend" | "signCancel" | "unblock">): Ctx {
  const key = parts.account?.address.toLowerCase();
  const state = (key && signers.get(key)) || { queue: Promise.resolve(), nonce: 0, notedAt: 0 };
  if (key) signers.set(key, state);
  const scope = key ? `${CHAIN_ID}:${key}` : null;
  let lease: SignerLease | undefined;
  const assertActive = async () => { if (lease) await lease.assertActive(); };
  const journals: Array<(fromNonce: number) => Promise<OpenTx[]>> = [];

  async function resend(raw: Hex): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      await assertActive();
      try {
        await sendRawTransaction(parts.pub, { serializedTransaction: raw });
        return true;
      } catch (e) {
        const said = String((e as { details?: string })?.details ?? (e as Error)?.message ?? e).toLowerCase();
        // The node has these bytes, or their nonce is spent: nothing to retry.
        // An underpriced replacement is a refusal: other bytes hold the nonce.
        if (/already known|known transaction|already imported|nonce too low/.test(said)) return true;
        if (attempt >= 2) return false;
        await new Promise((r) => setTimeout(r, attempt ? 1_500 : 500));
      }
    }
  }

  const seen = (hash: Hex) => parts.pub.getTransaction({ hash }).then(() => true, (e: unknown) => {
    if (notFound(e)) return false;
    throw e; // an RPC that can't answer is no evidence the bytes are lost
  });

  /// One open transaction, before anything is signed above it.
  async function settle(open: OpenTx): Promise<void> {
    await assertActive();
    if (open.cancel) {
      await resend(open.cancel.raw);
      return;
    }
    if (await seen(open.hash)) return; // mined after the count was read, or in a mempool
    if (open.resend) {
      await resend(open.raw);
      return;
    }
    if (!open.cancelNow) return;
    // Bytes saved moments ago may still be reaching a node behind the load
    // balancer: wait out the grace rather than sign above a gap no retry of a
    // later payment would ever come back to.
    const young = CANCEL_GRACE_MS - (Date.now() - open.savedAt);
    if (young > 0) {
      await new Promise((r) => setTimeout(r, young));
      await assertActive();
      if (await seen(open.hash)) return;
    }
    await open.cancelNow();
  }

  /// Every journal's transactions the chain hasn't used the nonce of yet.
  async function openAbove(latest: number): Promise<OpenTx[]> {
    return (await Promise.all(journals.map((read) => read(latest)))).flat()
      .filter((t) => t.nonce >= latest)
      .sort((a, b) => a.nonce - b.nonce);
  }

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

  const ctx: Ctx = {
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
      const address = parts.account.address;
      const [latest, pending] = await Promise.all([
        parts.pub.getTransactionCount({ address, blockTag: "latest" }),
        parts.pub.getTransactionCount({ address, blockTag: "pending" }),
      ]);
      const open = await openAbove(latest);
      // Saved bytes go out again in nonce order, or are cancelled once they must
      // not land. Either way the nonce they hold gets used, so nothing signed
      // after them waits forever behind a broadcast that was lost.
      for (const t of open) await settle(t);
      // A new key after restart must not replace another key's signed bytes,
      // even when the pending RPC lags or the funding model changes.
      let nonce = Math.max(latest, pending, ...open.map((t) => t.nonce + 1));
      if (state.nonce > nonce && Date.now() - state.notedAt < NOTED_NONCE_MS) nonce = state.nonce;
      return parts.coordinator?.nextNonce && scope ? await parts.coordinator.nextNonce(scope, nonce) : nonce;
    },
    async noteNonce(nonce) {
      state.nonce = Math.max(state.nonce, nonce + 1);
      state.notedAt = Date.now();
      await assertActive();
      if (parts.coordinator?.noteNonce && scope) await parts.coordinator.noteNonce(scope, nonce);
    },
    addJournal(read) {
      journals.push(read);
    },
    resend,
    async signCancel(nonce, gasToken = null, replaces) {
      const account = ctx.requireAccount();
      if (account.type !== "local") throw new RemessoError("no_account", "cancelling a saved transaction needs a local account");
      // A node holding the original keeps it unless its replacement pays the
      // same fee currency and at least a tenth more on every fee; an eighth
      // more clears that.
      // Bytes that don't parse can't be waiting in any pool, so there is nothing to outbid.
      type Fees = { feeCurrency?: Address; gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
      let original: Fees | null = null;
      try { original = replaces ? parseTransaction(replaces as Parameters<typeof parseTransaction>[0]) as Fees : null; } catch { original = null; }
      const fee = original ? (original.feeCurrency ? { feeCurrency: original.feeCurrency } : {}) : await gasFor(ctx, gasToken, 60_000n);
      const request = await prepareTransactionRequest(parts.pub, {
        account, nonce, to: account.address, value: 0n, data: "0x", ...fee,
      } as never) as { gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
      if (original) {
        const outbid = (now?: bigint, then?: bigint) => then === undefined ? now : now === undefined || now < then + then / 8n + 1n ? then + then / 8n + 1n : now;
        if (request.maxFeePerGas !== undefined) {
          request.maxFeePerGas = outbid(request.maxFeePerGas, original.maxFeePerGas ?? original.gasPrice);
          request.maxPriorityFeePerGas = outbid(request.maxPriorityFeePerGas, original.maxPriorityFeePerGas ?? original.gasPrice);
          if (request.maxPriorityFeePerGas! > request.maxFeePerGas!) request.maxFeePerGas = request.maxPriorityFeePerGas;
        } else request.gasPrice = outbid(request.gasPrice, original.gasPrice ?? original.maxFeePerGas);
      }
      await assertActive();
      const raw = await signTransaction(parts.pub, { ...request, account } as never);
      return { hash: keccak256(raw), raw };
    },
    async unblock(nonce) {
      if (!parts.account) return;
      const latest = await parts.pub.getTransactionCount({ address: parts.account.address, blockTag: "latest" });
      if (latest >= nonce) return;
      for (const t of await openAbove(latest)) if (t.nonce < nonce) await settle(t);
    },
  };

  // Generic contract writes saved by a shared coordinator. Whoever signed one
  // was told it may not have gone out, so it is cancelled rather than resent.
  const coordinator = parts.coordinator;
  if (coordinator?.openSigned && scope) {
    ctx.addJournal(async (fromNonce) => (await coordinator.openSigned!(scope, fromNonce)).map((t) => ({
      nonce: t.nonce, hash: t.hash, raw: t.raw, savedAt: t.savedAt, resend: false,
      ...(t.cancel ? { cancel: t.cancel } : {}),
      cancelNow: async () => {
        const cancel = await ctx.signCancel(t.nonce, null, t.raw);
        if (!coordinator.recordCancel) throw new RemessoError("invalid", "the coordinator saves signed writes but can't save their cancellation");
        await coordinator.recordCancel(scope, t.nonce, cancel);
        await resend(cancel.raw);
      },
    })));
  }
  return ctx;
}

/// A receipt, read with care. Nodes behind forno's load balancer don't all
/// index old transactions: for one a day or more old, about two lookups in
/// five came back empty though the transaction was mined. So a miss is asked
/// again, then answered from the receipts of the block the transaction is in.
export async function receiptOf(pub: PublicClient, hash: Hex): Promise<TransactionReceipt | null> {
  const direct = () => pub.getTransactionReceipt({ hash }).catch((e: unknown) => {
    if (notFound(e)) return null;
    throw e;
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await direct();
    if (found) return found;
  }
  const tx = await pub.getTransaction({ hash }).catch((e: unknown) => {
    if (notFound(e)) return null;
    throw e;
  });
  if (!tx || tx.blockNumber == null) return null; // pending, or unknown
  const block = await pub.request({ method: "eth_getBlockReceipts" as never, params: [toHex(tx.blockNumber)] as never })
    .catch(() => null) as Record<string, unknown>[] | null;
  const hit = block?.find((r) => typeof r?.transactionHash === "string" && r.transactionHash.toLowerCase() === hash.toLowerCase());
  return hit ? formatTransactionReceipt(hit as never) as TransactionReceipt : null;
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

/// A read pinned to a block can reach a node that hasn't got that block yet:
/// forno spreads calls across nodes, and one behind answers a call at that
/// block with "block is out of range" and a lookup of it with nothing. The
/// first wallet-funded mainnet run (2026-10-26) stopped that way, between a
/// head read and a call pinned to it. Such a node catches up within seconds,
/// so the read is tried again before the error is passed on.
export async function atBlock<T>(read: () => Promise<T>, waitMs = 8_000): Promise<T> {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      return await read();
    } catch (e) {
      if (!behind(e) || Date.now() >= until) throw e;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

/// What a node answers about a block it hasn't reached.
export function behind(e: unknown): boolean {
  const { name, message } = (e ?? {}) as { name?: string; message?: string };
  return name === "BlockNotFoundError" || /block is out of range|header not found|unknown block/i.test(message ?? String(e));
}

/// The gas a policy payment is budgeted at. Measured at about 85,000 to
/// 105,000 (the most for a recipient's first payment).
export const PAY_GAS = 120_000n;

/// CELO an account must hold to send a transaction of `gas` at `price`. A node
/// refuses one whose gas limit times its fee cap exceeds the balance, and viem
/// sets the cap above the current price; payments carry their own estimate,
/// so they need less headroom than a write budgeted generously.
export function gasNeeded(gas: bigint, price: bigint, headroom: "payment" | "write" = "write"): bigint {
  return headroom === "payment" ? gas * price * 5n / 4n : gas * price * 2n;
}

/// Gas: CELO if the account holds enough, else the token itself through
/// Celo's fee abstraction, for the tokens that support it. A payer who holds
/// only USD₮ can still create a schedule.
export async function gasFor(ctx: Ctx, t: Token | null, gas = 300_000n, headroom: "payment" | "write" = "write"): Promise<{ feeCurrency?: Address }> {
  const account = ctx.requireAccount();
  const [native, price] = await Promise.all([ctx.pub.getBalance({ address: account.address }), ctx.pub.getGasPrice()]);
  const need = gasNeeded(gas, price, headroom);
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
    } catch (e) {
      throw new RemessoError("conflict", `${w.functionName} has signed transaction ${hash}; inspect its nonce journal and original hash before retrying this action`, { hash, nonce, cause: String(e) });
    }
    if (!await ctx.resend(raw)) {
      const seen = await ctx.pub.getTransaction({ hash }).catch(() => null);
      if (!seen) {
        throw new RemessoError("conflict", `${w.functionName} was signed as ${hash} but no node accepted it. It is saved: before this signer's next transaction it is cancelled with a no-op unless a node has it by then. Check that hash before retrying`, { hash, nonce });
      }
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
