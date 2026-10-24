/// Celo / contract access. viem, because MiniPay does not support ethers.
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
  toFunctionSelector,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
} from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";
import { attributionSuffix } from "./attribution.ts";
import { CELO, DIRECT_TOKENS, type DirectToken, LIMITS } from "./config.ts";
import { runExecutedAbi, runOutcome } from "./receipt.ts";
import type { Seen } from "./recovery.ts";

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO.rpcUrl),
});

export function executorAccount() {
  const pk = Deno.env.get("EXECUTOR_PRIVATE_KEY")!;
  return privateKeyToAccount(pk as `0x${string}`);
}

export function walletClient() {
  return createWalletClient({
    account: executorAccount(),
    chain: celo,
    transport: http(CELO.rpcUrl),
  });
}

/// V4 shape. A static tuple decodes positionally, so a stale struct silently
/// reads the wrong field and shifts everything after it — V3 added `poolFee`
/// and `token`, V4 adds `tokenOut`, `feeBps`, `lastRunAt`, `triggersLeft` and
/// `trigger`. Only `.destination` and the `active`/`cancelled` pair are read
/// today, which is exactly why a wrong shape would go unnoticed.
///
/// One ABI, because one executor runs at a time: `due_schedules` is scoped to
/// the configured contract, so a row from an older deployment is never handed
/// to this client at all.
export const executorAbi = parseAbi([
  "function executeRun(uint256 id, uint256 amountOutMinimum) returns (uint256)",
  "function runnability(uint256 id) view returns (bool due, bool funded, bool approved, uint256 floor, uint64 nextRunAt)",
  "function getSchedule(uint256 id) view returns ((address sender,uint64 interval,uint32 maxRuns,address destination,uint64 nextRunAt,uint32 runsExecuted,uint128 amountIn,uint96 minRateE6,uint24 poolFee,uint64 expiresAt,uint8 payoutType,bool active,bool cancelled,address token,address tokenOut,uint16 feeBps,uint64 lastRunAt,uint16 triggersLeft,address trigger))",
  "function paused() view returns (bool)",
]);

/// V4 only. Kept separate from `executorAbi` so nothing can call these against
/// the V3 address by accident — a `runNow` selector that does not exist there
/// would revert as a plain failure with no hint why.
export const executorV4Abi = parseAbi([
  "function runNow(uint256 id, uint256 amountOutMinimum) returns (uint256)",
  "function triggerability(uint256 id, address caller) view returns (bool canTrigger, uint16 triggersLeft, uint64 earliestTrigger)",
  "function nextScheduleId() view returns (uint256)",
  "function runnability(uint256 id) view returns (bool due, bool funded, bool approved, uint256 floor, uint64 nextRunAt)",
  "function directTokenAllowed(address token) view returns (bool)",
]);

/// The contract `runNow` and the Direct allowlist are read from: the
/// configured executor, V5 since 2026-10-16. It was a separate
/// `REMESSO_EXECUTOR_V4_ADDRESS` while V3 ran the cadence and V4 only took
/// triggers; with one contract doing both, a second variable is only a second
/// thing to forget at the next migration. V5 keeps V4's ABI for every call here.
export const executorV4 = (CELO.executor ?? "") as `0x${string}` | "";

/// V5's `CURRENT_EXECUTOR`: stored as a schedule's `trigger`, it means
/// "whoever is the executor now", so rotating the hot key moves the grant
/// with it. The literal executor address is refused as a trigger on V5.
export const CURRENT_EXECUTOR = "0x0000000000000000000000000000000000000001" as const;

/// Commission as V5 takes it: rounded up. Used to quote what a swap actually
/// converts, which is the amount after the fee.
export function feeOf(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps) + 9_999n) / 10_000n;
}

/// The Direct assets V4 will accept right now, read from its allowlist.
///
/// `DIRECT_TOKENS` names every asset we know how to handle; the contract
/// decides which a schedule may use, and the owner can widen that at any
/// time with `setDirectToken`. Anything that tells an outside caller what it
/// can pay in reads this, so a token is never advertised before the contract
/// takes it. `null` when the read fails — the caller chooses its fallback.
export async function allowedDirectTokens(): Promise<DirectToken[] | null> {
  if (!executorV4) return null;
  try {
    const results = await publicClient.multicall({
      contracts: DIRECT_TOKENS.map((t) => ({
        address: executorV4 as `0x${string}`,
        abi: executorV4Abi,
        functionName: "directTokenAllowed",
        args: [t.address as `0x${string}`],
      })),
    });
    return DIRECT_TOKENS.filter((_, i) => results[i].status === "success" && (results[i].result as unknown) === true);
  } catch (e) {
    console.error("directTokenAllowed read failed:", (e as Error).message);
    return null;
  }
}

/// Can this executor trigger an early send for `id`, and how many are left?
export async function triggerability(id: bigint) {
  const [canTrigger, triggersLeft, earliestTrigger] = await publicClient.readContract({
    address: executorV4 as `0x${string}`,
    abi: executorV4Abi,
    functionName: "triggerability",
    args: [id, executorAccount().address],
  });
  return { canTrigger, triggersLeft, earliestTrigger };
}

/// The floor the contract will enforce for this schedule, as V4 computes it.
export async function v4Runnability(id: bigint) {
  const [due, funded, approved, floor, nextRunAt] = await publicClient.readContract({
    address: executorV4 as `0x${string}`,
    abi: executorV4Abi,
    functionName: "runnability",
    args: [id],
  });
  return { due, funded, approved, floor, nextRunAt };
}

/// A run, signed and not yet sent.
///
/// The hash is known before anything leaves this process, so the caller
/// writes it down first. An invocation that dies mid-broadcast then leaves a
/// hash the recovery pass can look up, never a payment nobody recorded.
export type SignedRun = { hash: Hex; serialized: Hex; nonce: number };

/// Simulate one run, then sign it.
///
/// `executeRun` is the cadence's run. `runNow` sends one early, as the address
/// the sender nominated as trigger. Every limit still applies inside the
/// contract either way: the destination, the amount, the floor, the run cap,
/// the expiry, and the sender's own allowance of early sends. This only asks;
/// the contract decides.
///
/// Throws the contract's revert if the run would fail, before a nonce is used.
/// The nonce is fetched here, so hold the executor lease (`lease.ts`) from
/// this call until the transaction is mined, and pass its floor.
export async function signRun(
  fn: "executeRun" | "runNow",
  id: bigint,
  amountOutMinimum: bigint,
  nonceFloor: number | null = null,
): Promise<SignedRun> {
  const wc = walletClient();
  const to = (fn === "executeRun" ? CELO.executor : executorV4) as `0x${string}`;
  const args = [id, amountOutMinimum] as const;
  let call: Hex;
  if (fn === "executeRun") {
    await publicClient.simulateContract({ address: to, abi: executorAbi, functionName: fn, args, account: wc.account });
    call = encodeFunctionData({ abi: executorAbi, functionName: fn, args });
  } else {
    await publicClient.simulateContract({ address: to, abi: executorV4Abi, functionName: fn, args, account: wc.account });
    call = encodeFunctionData({ abi: executorV4Abi, functionName: fn, args });
  }

  const pending = await publicClient.getTransactionCount({ address: wc.account.address, blockTag: "pending" });
  const nonce = Math.max(pending, nonceFloor ?? 0);
  const request = await wc.prepareTransactionRequest({
    to,
    nonce,
    // Appended after the calldata, invisible to the contract. Every run is a
    // Celo transaction this app caused, and untagged ones cannot be claimed
    // later — see _shared/attribution.ts.
    data: attributionSuffix ? concat([call, attributionSuffix]) : call,
  });
  const serialized = await wc.signTransaction(request);
  return { hash: keccak256(serialized), serialized, nonce };
}

/// Send a signed run. A thrown error doesn't prove it wasn't sent: a node can
/// accept a transaction and fail to answer. Callers confirm by hash either way.
export async function broadcast(run: SignedRun): Promise<void> {
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: run.serialized });
  // A typed transaction's hash is the hash of its signed bytes, so these can
  // only differ if the node is lying. Loud, because the row holds ours.
  if (hash.toLowerCase() !== run.hash.toLowerCase()) {
    console.error(`broadcast: node answered ${hash} for signed run ${run.hash}`);
  }
}

/// Wait for a run's receipt and say what it did (`receipt.ts`). Throws only
/// when no receipt arrives in time: the outcome is then unknown, and the row
/// is left for the recovery pass.
export async function confirmRun(
  hash: Hex,
  id: bigint,
  { confirmations, timeoutMs }: { confirmations: number; timeoutMs: number },
) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations, timeout: timeoutMs });
  return { receipt, outcome: runOutcome(receipt, CELO.executor, id) };
}

/// What the chain knows about one of our run transactions, for the recovery
/// pass. "Not found" is asked three times, a second apart: forno balances
/// across nodes, and one that lags can answer null for a receipt another has.
export async function lookupRunTx(hash: Hex, id: bigint): Promise<Seen> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000));
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return {
        kind: "mined",
        hash,
        outcome: runOutcome(receipt, CELO.executor, id),
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    } catch (e) {
      if (!(e instanceof TransactionReceiptNotFoundError)) throw e;
    }
    try {
      await publicClient.getTransaction({ hash });
      return { kind: "pending", hash };
    } catch (e) {
      if (!(e instanceof TransactionNotFoundError)) throw e;
    }
  }
  return { kind: "unknown_tx", hash };
}

const EXECUTE_RUN = toFunctionSelector("function executeRun(uint256 id, uint256 amountOutMinimum)");

/// Our own `executeRun` of schedule `id` sent after `sinceMs`, for a row with
/// no hash. Today's code never broadcasts before saving the hash, but a row
/// written before 2026-10-24 could have been sent without one.
///
/// One read settles the usual case: if the schedule's `lastRunAt` is before
/// the row, nothing has run since.
export async function findOwnRunSince(id: bigint, sinceMs: number): Promise<Seen> {
  const s = await getSchedule(id);
  // Block seconds against row milliseconds: a second of slack, on the side of
  // looking.
  if (Number(s.lastRunAt) * 1000 < sinceMs - 1000) return { kind: "never_sent" };

  // If the run was ours, it went out within the invocation that wrote the
  // row, minutes at most. Celo makes a block a second, so one window of
  // forno's 5,000-block limit, from just before the row, covers it.
  const head = await publicClient.getBlock();
  const back = BigInt(Math.ceil(Number(head.timestamp) - sinceMs / 1000)) + 300n;
  const fromBlock = head.number > back ? head.number - back : 0n;
  const toBlock = fromBlock + 4_999n < head.number ? fromBlock + 4_999n : head.number;
  const logs = await publicClient.getLogs({
    address: CELO.executor,
    event: runExecutedAbi[0],
    args: { id },
    fromBlock,
    toBlock,
  });

  const me = executorAccount().address.toLowerCase();
  const sinceSecs = BigInt(Math.floor(sinceMs / 1000));
  for (const log of logs) {
    // The window starts early, so it can hold the previous row's run. An
    // `executeRun` sets `nextRunAt` to its block time plus the interval, so
    // the event dates itself: anything before this row is not this row's.
    if (log.args.nextRunAt! - s.interval < sinceSecs - 5n) continue;
    const hash = log.transactionHash!;
    const tx = await publicClient.getTransaction({ hash });
    // An early send is a `runNow`, from `trigger-run` or from a trigger the
    // sender named. Neither belongs to a cron row.
    if (tx.from.toLowerCase() !== me || !tx.input.startsWith(EXECUTE_RUN)) continue;
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return {
      kind: "mined",
      hash,
      outcome: runOutcome(receipt, CELO.executor, id),
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    };
  }
  return { kind: "never_sent" };
}

/// Would `runNow` go through right now? Throws the contract's revert if not.
/// Moves nothing and signs nothing — `trigger-run` asks this before it takes
/// a payer's money, so a run that would revert charges nobody.
export async function simulateRunNow(id: bigint, amountOutMinimum: bigint): Promise<void> {
  await publicClient.simulateContract({
    address: executorV4 as `0x${string}`,
    abi: executorV4Abi,
    functionName: "runNow",
    args: [id, amountOutMinimum],
    account: executorAccount(),
  });
}

const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

/// Live quote for USDT -> cNGN, plus the slippage bound to hand the contract.
///
/// The contract enforces the sender's own floor rate independently; this is
/// the tighter, market-aware bound on top of it.
export async function quoteUsdtToCngn(amountIn: bigint): Promise<{
  amountOut: bigint;
  minOut: bigint;
  rateE6: bigint;
}> {
  const { result } = await publicClient.simulateContract({
    address: CELO.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{
      tokenIn: CELO.usdt,
      tokenOut: CELO.cngn,
      amountIn,
      fee: CELO.poolFee,
      sqrtPriceLimitX96: 0n,
    }],
  });

  const amountOut = result[0];
  const minOut = (amountOut * BigInt(10_000 - LIMITS.maxSlippageBps)) / 10_000n;
  const rateE6 = (amountOut * 1_000_000n) / amountIn;
  return { amountOut, minOut, rateE6 };
}

/// A read-only quote for any single pool: how much `tokenOut` the pool would
/// return for `amountIn` right now. Sells nothing and signs nothing — the
/// LatAm rate services use it to price wARS and wBRL at the caller's own
/// size. Kept here with the cNGN quote so every Uniswap call stays in this
/// file (the swap venue is a replaceable component). Throws if the pool
/// does not exist or cannot fill the size.
export async function quoteExactIn(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: CELO.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

/// The cNGN/USDT pool is the single venue on Celo and holds roughly $95k.
/// Before every run we confirm the pool can still fill it at a sane price —
/// a run that would move the price more than `maxAcceptableImpactBps` is
/// skipped and the sender notified, never executed at any cost.
export async function liquidityIsHealthy(amountIn: bigint): Promise<{
  ok: boolean;
  impactBps: number;
  quote: { amountOut: bigint; minOut: bigint; rateE6: bigint };
}> {
  const probe = 1_000_000n; // 1 USDT reference trade
  const [small, actual] = await Promise.all([
    quoteUsdtToCngn(probe),
    quoteUsdtToCngn(amountIn),
  ]);
  const impactBps = Number(
    ((small.rateE6 - actual.rateE6) * 10_000n) / small.rateE6,
  );
  // The quote is returned, not recomputed by the caller. Quoting twice cost an
  // extra RPC round trip and, worse, let the price move in between — so the
  // minOut actually sent was not the one this health check approved.
  return {
    ok: impactBps <= LIMITS.maxAcceptableImpactBps,
    impactBps,
    quote: actual,
  };
}

export type Runnability = {
  due: boolean;
  funded: boolean;
  approved: boolean;
  floor: bigint;
  nextRunAt: bigint;
};

export async function runnability(onchainId: bigint): Promise<Runnability> {
  const r = await publicClient.readContract({
    address: CELO.executor,
    abi: executorAbi,
    functionName: "runnability",
    args: [onchainId],
  }) as readonly [boolean, boolean, boolean, bigint, bigint];
  return { due: r[0], funded: r[1], approved: r[2], floor: r[3], nextRunAt: r[4] };
}

export type OnchainSchedule = {
  sender: Address;
  interval: bigint;
  maxRuns: number;
  destination: Address;
  nextRunAt: bigint;
  runsExecuted: number;
  amountIn: bigint;
  minRateE6: bigint;
  poolFee: number;
  expiresAt: bigint;
  payoutType: number;
  active: boolean;
  cancelled: boolean;
  /// The asset this schedule actually moves. Direct schedules pin their own.
  token: Address;
  tokenOut: Address;
  feeBps: number;
  lastRunAt: bigint;
  triggersLeft: number;
  trigger: Address;
};

/// The sender-signed policy, read from the contract rather than our mirror of
/// it. Used where being wrong costs money — chiefly checking that a cNGN
/// redemption address matches the destination the sender actually authorised,
/// and that a row's sender is the schedule's.
///
/// `contract` defaults to the configured executor; `blockNumber` pins the read
/// to a receipt's block, because forno can answer from a block behind right
/// after a transaction and a mirror written from that answer is wrong.
export async function getSchedule(
  onchainId: bigint,
  opts: { contract?: `0x${string}`; blockNumber?: bigint } = {},
): Promise<OnchainSchedule> {
  return await publicClient.readContract({
    address: opts.contract ?? CELO.executor,
    abi: executorAbi,
    functionName: "getSchedule",
    args: [onchainId],
    ...(opts.blockNumber ? { blockNumber: opts.blockNumber } : {}),
  }) as OnchainSchedule;
}

const erc20ReadAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

/// What a sender holds of `token` and what they let this executor move — the
/// two numbers `runnability()` compares with a payment, read separately so the
/// pre-flight agent can say by how much a payment falls short, not just that
/// it does.
export async function walletPosition(token: Address, owner: Address): Promise<{ balance: bigint; allowance: bigint }> {
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "balanceOf", args: [owner] }),
    publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "allowance", args: [owner, CELO.executor] }),
  ]);
  return { balance, allowance };
}

/// One past the highest schedule id this contract has issued.
///
/// The upper bound for finding schedules created without the app — see
/// `sync-schedules`. Cheap, and it needs no event indexing to be correct.
export async function nextScheduleId(): Promise<bigint> {
  return await publicClient.readContract({
    address: CELO.executor,
    abi: executorV4Abi,
    functionName: "nextScheduleId",
  }) as bigint;
}

/// Is the contract globally paused?
///
/// The deployed V1's `runnability()` omits this, so it reports due = true while
/// paused. That matters because a bank run opens a real cNGN redemption BEFORE
/// calling executeRun — so believing `due` during a pause commits an
/// irreversible off-chain payout for a run that then reverts, every cycle.
/// Checked here until V2 folds it into runnability itself.
export async function isPaused(): Promise<boolean> {
  return await publicClient.readContract({
    address: CELO.executor,
    abi: executorAbi,
    functionName: "paused",
  }) as boolean;
}
