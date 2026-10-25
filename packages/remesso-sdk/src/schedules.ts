/// Schedules: a payer signs once, on-chain, a fixed amount to a fixed address
/// on a fixed cadence, and Remesso's executor sends each payment when it is
/// due. After signing, nothing can change the recipient, the amount or the
/// cadence: not Remesso, not the contract's owner, not the payer. Cancelling
/// is the only edit. Extracted from `examples/create-schedule.ts`.
import { type Address, type Hex, type Log, parseEventLogs, zeroAddress } from "viem";
import { erc20Abi, executorAbi } from "./abi.js";
import { type Ctx, write } from "./context.js";
import {
  checksum,
  CURRENT_EXECUTOR,
  EXECUTOR,
  findToken,
  formatAmount,
  runLimits,
  token as tokenOf,
  toUnits,
  type Token,
} from "./deployment.js";
import { RemessoError } from "./errors.js";
import type { RequestStatus } from "./requests.js";
import { grossFor, netOf } from "./vendor/fee.js";

export const CADENCES = {
  week: 7 * 86_400,
  fortnight: 14 * 86_400,
  month: 30 * 86_400,
  quarter: 90 * 86_400,
} as const;
export type Cadence = keyof typeof CADENCES;

/// Direct: the recipient receives the token the payer funds, with no swap.
const DIRECT = 2;

export type CreateScheduleInput = {
  /** Who gets paid. With `request`, the request's own address. */
  to?: string;
  /** Per payment, what leaves your wallet, as a decimal string: "1.50". Use this or `receive`. */
  amount?: string;
  /** Per payment, what the recipient receives after Remesso's fee. The SDK works out what to send. */
  receive?: string;
  /** Symbol or address. Default USDT, or the request's token. */
  token?: string;
  /** week | fortnight | month | quarter, or seconds (at least an hour). Default week, or the request's. */
  every?: Cadence | number;
  /** How many payments. With `request`, defaults to the request's. */
  runs?: number;
  /** When the first payment is due. Default now: it goes out within minutes. */
  firstRunAt?: Date;
  /**
   * Who may bring a payment forward: "remesso" for Remesso's executor (whoever it is
   * at the time), or an address. Same recipient, same amount, never an extra payment.
   * Default nobody.
   */
  trigger?: "remesso" | string | null;
  /** How many early sends the trigger may make. Default: all of them. */
  triggers?: number;
  /** A payment request this schedule answers. Its terms fill whatever you leave out. */
  request?: string;
  /**
   * Approve the contract for this schedule's total on top of what is already
   * approved (the default), or not at all when you manage approvals yourself.
   */
  approve?: boolean;
};

export type CreatedSchedule = {
  id: bigint;
  hash: Hex;
  approveHash: Hex | null;
  to: Address;
  token: Token["symbol"];
  /** What leaves the payer's wallet each payment, in base units. */
  amountIn: bigint;
  /** What the recipient receives each payment, in base units, after the fee. */
  recipientGets: bigint;
  feeBps: number;
  runs: number;
  intervalSeconds: number;
  firstRunAt: Date;
  expiresAt: Date;
  /** With `request`: how the request took the answer, or why it didn't. */
  request?: { status: string; signed: unknown } | { error: string };
  warnings: string[];
};

export type Schedule = {
  id: bigint;
  sender: Address;
  to: Address;
  token: Address;
  amountIn: bigint;
  recipientGets: bigint;
  feeBps: number;
  intervalSeconds: number;
  maxRuns: number;
  runsExecuted: number;
  nextRunAt: Date;
  lastRunAt: Date | null;
  expiresAt: Date;
  active: boolean;
  cancelled: boolean;
  payoutType: number;
  trigger: Address;
  triggersLeft: number;
};

type Deps = {
  getRequest(id: string): Promise<RequestStatus>;
  answer(id: string, scheduleId: bigint): Promise<{ status: string; signed: unknown }>;
};

export function makeSchedules(ctx: Ctx, deps: Deps) {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.pub.readContract({ address: EXECUTOR, abi: executorAbi, functionName, args } as never) as Promise<T>;
  /// The schedule's token, so a sender holding no CELO can pay for managing
  /// it in that token, as they could for creating it.
  const gasTokenOf = async (id: bigint | number | string) => findToken((await get(id)).token) ?? null;

  async function get(id: bigint | number | string): Promise<Schedule> {
    const s = await read<{
      sender: Address; interval: bigint; maxRuns: number; destination: Address; nextRunAt: bigint; runsExecuted: number;
      amountIn: bigint; poolFee: number; expiresAt: bigint; payoutType: number; active: boolean; cancelled: boolean;
      token: Address; feeBps: number; lastRunAt: bigint; triggersLeft: number; trigger: Address;
    }>("getSchedule", [BigInt(id)]);
    if (s.sender === zeroAddress) throw new RemessoError("not_found", `there is no schedule ${id} on ${EXECUTOR}`);
    return {
      id: BigInt(id),
      sender: s.sender,
      to: s.destination,
      token: s.token,
      amountIn: s.amountIn,
      recipientGets: netOf(s.amountIn, s.feeBps),
      feeBps: s.feeBps,
      intervalSeconds: Number(s.interval),
      maxRuns: s.maxRuns,
      runsExecuted: s.runsExecuted,
      nextRunAt: new Date(Number(s.nextRunAt) * 1000),
      lastRunAt: s.lastRunAt ? new Date(Number(s.lastRunAt) * 1000) : null,
      expiresAt: new Date(Number(s.expiresAt) * 1000),
      active: s.active,
      cancelled: s.cancelled,
      payoutType: s.payoutType,
      trigger: s.trigger,
      triggersLeft: s.triggersLeft,
    };
  }

  async function create(input: CreateScheduleInput): Promise<CreatedSchedule> {
    const account = ctx.requireAccount();
    await ctx.assertChain();
    const me = account.address.toLowerCase();
    const warnings: string[] = [];

    // A request's terms fill whatever was left out. It must be addressed to
    // this wallet: paying someone else's request answers nothing, and it is
    // what an injected instruction would ask for.
    let req: RequestStatus | null = null;
    let { to, amount, receive, token: tokenIn, every, runs } = input;
    if (input.request) {
      req = await deps.getRequest(input.request);
      if (req.payer.toLowerCase() !== me) {
        throw new RemessoError("refused", `request ${req.id} was sent to ${req.payer}, not to ${account.address}`);
      }
      if (req.status !== "pending") throw new RemessoError("refused", `request ${req.id} is ${req.status}, so there is nothing to answer`);
      if (to && to.toLowerCase() !== req.requested.to.toLowerCase()) {
        throw new RemessoError("refused", `request ${req.id} asks to be paid at ${req.requested.to}, not ${to}`);
      }
      to = req.requested.to;
      tokenIn ??= req.requested.token ?? undefined;
      every ??= req.requested.intervalSeconds ?? undefined;
      runs ??= req.requested.runs ?? undefined;
      if (amount == null && receive == null && req.requested.amount) receive = req.requested.amount;
    }

    if (!to) throw new RemessoError("invalid", "to is required: who gets paid");
    const dest = checksum(to);
    if (dest.toLowerCase() === me) throw new RemessoError("invalid", "to is this wallet: a schedule paying itself only loses the fee");
    const t = tokenOf(tokenIn ?? "USDT");
    const interval = intervalOf(every ?? "week");
    if (runs == null) throw new RemessoError("invalid", "runs is required: how many payments");
    if (!Number.isInteger(runs) || runs < 1 || runs > 4_294_967_295) throw new RemessoError("invalid", "runs must be a whole number of payments");
    if ((amount == null) === (receive == null)) throw new RemessoError("invalid", "give amount (what you send each time) or receive (what arrives), not both");

    const [allowed, feeBps, maxLifetime, approved, balance] = await ctx.pub.multicall({
      allowFailure: false,
      contracts: [
        { address: EXECUTOR, abi: executorAbi, functionName: "directTokenAllowed", args: [t.address as Address] },
        { address: EXECUTOR, abi: executorAbi, functionName: "feeBps" },
        { address: EXECUTOR, abi: executorAbi, functionName: "MAX_LIFETIME" },
        { address: t.address as Address, abi: erc20Abi, functionName: "allowance", args: [account.address, EXECUTOR] },
        { address: t.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] },
      ],
    } as never) as unknown as [boolean, number, bigint, bigint, bigint];
    if (!allowed) throw new RemessoError("refused", `the contract doesn't take ${t.symbol} for new schedules`);

    const amountIn = receive != null ? grossFor(toUnits(receive, t), Number(feeBps)) : toUnits(amount!, t);
    const { min, max } = runLimits(t);
    if (amountIn < min || amountIn > max) {
      throw new RemessoError(
        "refused",
        `Remesso's executor sends ${formatAmount(min, t)} to ${formatAmount(max, t)} per payment, and this is ${formatAmount(amountIn, t)}. ` +
          `A schedule outside that is valid on-chain and never runs.`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const first = input.firstRunAt ? Math.floor(input.firstRunAt.getTime() / 1000) : now;
    if (first < now - 60) throw new RemessoError("invalid", "firstRunAt is in the past");
    // An interval and an hour past the first payment's slot, as the example
    // and the app do, so a run sent late still lands inside the schedule's
    // life. `runs` still caps how many go out.
    const expiresAt = first + runs * interval + 3600;
    if (BigInt(expiresAt - now) > maxLifetime) {
      throw new RemessoError("refused", `${runs} payments every ${interval / 86_400} days don't fit in a schedule's year`);
    }

    let trigger: Address = zeroAddress;
    if (input.trigger === "remesso") trigger = CURRENT_EXECUTOR;
    else if (input.trigger) trigger = checksum(input.trigger);
    const triggersLeft = trigger === zeroAddress ? 0 : Math.min(input.triggers ?? runs, 65_535);

    const total = amountIn * BigInt(runs);
    if (balance < amountIn) warnings.push(`the balance (${formatAmount(balance, t)}) is below one payment: payments fail until it's funded`);

    // The allowance is the real ceiling on what can ever be taken. Approve
    // this schedule's total ON TOP of what is approved already: `approve`
    // replaces rather than adds, and another schedule may rely on it.
    let nonce = await ctx.pub.getTransactionCount({ address: account.address, blockTag: "pending" });
    let approveHash: Hex | null = null;
    if (input.approve !== false) {
      ({ hash: approveHash } = await write(ctx, {
        address: t.address as Address, abi: erc20Abi, functionName: "approve", args: [EXECUTOR, approved + total], gasToken: t, nonce,
      }));
      nonce++;
    }

    const { hash, receipt } = await write(ctx, {
      address: EXECUTOR,
      abi: executorAbi,
      functionName: "createSchedule",
      args: [dest, amountIn, BigInt(interval), 0n, runs, BigInt(expiresAt), BigInt(input.firstRunAt ? first : 0), DIRECT, t.address, zeroAddress, trigger, triggersLeft],
      gasToken: t,
      nonce,
    });

    const id = scheduleIdFrom(receipt.logs);
    if (id == null) throw new RemessoError("http", `created, but ${hash} has no ScheduleCreated log: read the receipt yourself`, { hash });

    let answered: CreatedSchedule["request"];
    if (req) {
      try {
        answered = await deps.answer(req.id, id);
      } catch (e) {
        answered = { error: (e as Error).message };
      }
    }

    return {
      id,
      hash,
      approveHash,
      to: dest,
      token: t.symbol,
      amountIn,
      recipientGets: netOf(amountIn, Number(feeBps)),
      feeBps: Number(feeBps),
      runs,
      intervalSeconds: interval,
      firstRunAt: new Date(first * 1000),
      expiresAt: new Date(expiresAt * 1000),
      ...(answered ? { request: answered } : {}),
      warnings,
    };
  }

  return {
    create,
    get,
    /// Whether a payment is due now, and whether it can go: funded and approved.
    async status(id: bigint | number | string) {
      const [due, funded, approved, , nextRunAt] = await read<[boolean, boolean, boolean, bigint, bigint]>("runnability", [BigInt(id)]);
      return { due, funded, approved, nextRunAt: new Date(Number(nextRunAt) * 1000) };
    },
    /// The ids of every schedule `sender` (default: this account) has created.
    async list(sender?: string): Promise<bigint[]> {
      const who = sender ? checksum(sender) : ctx.requireAccount().address;
      return [...(await read<readonly bigint[]>("schedulesOf", [who]))];
    },
    /// Stops it for good. The approval stays: lower it if nothing else needs it.
    async cancel(id: bigint | number | string): Promise<Hex> {
      return (await write(ctx, {
        address: EXECUTOR, abi: executorAbi, functionName: "cancelSchedule", args: [BigInt(id)], gasToken: await gasTokenOf(id),
      })).hash;
    },
    /// Pauses (false) or resumes (true) the payments.
    async setActive(id: bigint | number | string, active: boolean): Promise<Hex> {
      return (await write(ctx, {
        address: EXECUTOR, abi: executorAbi, functionName: "setScheduleActive", args: [BigInt(id), active], gasToken: await gasTokenOf(id),
      })).hash;
    },
    /// Changes who may bring a payment forward; `null` revokes.
    async setTrigger(id: bigint | number | string, trigger: "remesso" | string | null, triggers = 0): Promise<Hex> {
      const who = trigger === "remesso" ? CURRENT_EXECUTOR : trigger ? checksum(trigger) : zeroAddress;
      return (await write(ctx, {
        address: EXECUTOR, abi: executorAbi, functionName: "setTrigger", args: [BigInt(id), who, who === zeroAddress ? 0 : triggers],
        gasToken: await gasTokenOf(id),
      })).hash;
    },
  };
}

export type Schedules = ReturnType<typeof makeSchedules>;

/// The id of the schedule a transaction created, from its own ScheduleCreated
/// log, never from re-reading the counter: a node a block behind would answer
/// with somebody else's id. Null when there is none.
export function scheduleIdFrom(logs: readonly Log[]): bigint | null {
  const created = parseEventLogs({ abi: executorAbi, eventName: "ScheduleCreated", logs: logs as Log[] })
    .find((l) => l.address.toLowerCase() === EXECUTOR.toLowerCase());
  return created ? (created.args as { id: bigint }).id : null;
}

/// Seconds for a cadence name or a number of seconds.
export function intervalOf(every: Cadence | number | string): number {
  if (typeof every === "number") {
    if (!Number.isInteger(every) || every < 3600) throw new RemessoError("invalid", "every, in seconds, must be a whole number of at least 3600");
    return every;
  }
  const named = CADENCES[String(every).toLowerCase().replace(/ly$/, "") as Cadence];
  if (named) return named;
  if (/^\d+$/.test(String(every))) return intervalOf(Number(every));
  throw new RemessoError("invalid", `every must be ${Object.keys(CADENCES).join(", ")} or seconds`);
}
