/// Celo / contract access. viem, because MiniPay does not support ethers.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
} from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";
import { attributionSuffix } from "./attribution.ts";
import { CELO, DIRECT_TOKENS, type DirectToken, LIMITS } from "./config.ts";

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

/// The V4 deployment. Empty until the migration; `trigger-run` is the only
/// thing that reads it, and it answers 503 rather than guessing.
export const executorV4 = (Deno.env.get("REMESSO_EXECUTOR_V4_ADDRESS") ?? "") as `0x${string}` | "";

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

/// Send one run early, as the address the sender nominated as trigger.
///
/// Every limit still applies inside the contract: the destination, the amount,
/// the floor, the run cap, the expiry, and the sender's own allowance of early
/// sends. This only asks; the contract decides.
export async function runNow(id: bigint, amountOutMinimum: bigint) {
  const wc = walletClient();
  const { request } = await publicClient.simulateContract({
    address: executorV4 as `0x${string}`,
    abi: executorV4Abi,
    functionName: "runNow",
    args: [id, amountOutMinimum],
    account: wc.account,
    ...(attributionSuffix ? { dataSuffix: attributionSuffix } : {}),
  });
  const hash = await wc.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  return { hash, receipt };
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
};

/// The sender-signed policy, read from the contract rather than our mirror of
/// it. Used where being wrong costs money — chiefly checking that a cNGN
/// redemption address matches the destination the sender actually authorised.
export async function getSchedule(onchainId: bigint): Promise<OnchainSchedule> {
  return await publicClient.readContract({
    address: CELO.executor,
    abi: executorAbi,
    functionName: "getSchedule",
    args: [onchainId],
  }) as OnchainSchedule;
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

export async function executeRun(onchainId: bigint, minOut: bigint) {
  const wc = walletClient();
  const { request } = await publicClient.simulateContract({
    address: CELO.executor,
    abi: executorAbi,
    functionName: "executeRun",
    args: [onchainId, minOut],
    account: wc.account,
    // Appended after the calldata, invisible to the contract. Every run is a
    // Celo transaction this app caused, and untagged ones cannot be claimed
    // later — see _shared/attribution.ts.
    ...(attributionSuffix ? { dataSuffix: attributionSuffix } : {}),
  });
  const hash = await wc.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  return { hash, receipt };
}
