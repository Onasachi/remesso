/// Policies: spending limits a person grants their agent's key on
/// RemessoAgentAllowance. One token, a cap per payment and per day, an
/// expiry, and optionally a list of the only recipients allowed. The agent
/// pays from the person's wallet, and the contract refuses anything outside
/// the policy. No fee: what an agent pays is what arrives.
import { type Address, type Hex, type Log, parseEventLogs } from "viem";
import { allowanceAbi, erc20Abi } from "./abi.js";
import { type Ctx, write } from "./context.js";
import { ALLOWANCE, checksum, findToken, token as tokenOf, toUnits } from "./deployment.js";
import { RemessoError } from "./errors.js";

export type Policy = {
  id: bigint;
  owner: Address;
  agent: Address;
  token: Address;
  /** The token's symbol, when Remesso knows it. */
  symbol: string | null;
  perPayment: bigint;
  perDay: bigint;
  expiresAt: Date;
  allowlistOnly: boolean;
  revoked: boolean;
  remainingToday: bigint;
  ownerBalance: bigint;
  /** The owner's approval to the allowance contract: shared by all their policies for this token. */
  ownerAllowance: bigint;
  /** Not revoked and not expired. */
  active: boolean;
  /** The largest payment the policy allows right now, every limit counted. */
  spendable: bigint;
};

export type CreatePolicyInput = {
  /** The agent's address: the key that will call pay(). */
  agent: string;
  token: string;
  /** Per payment, decimal. */
  perPayment: string;
  /** Per rolling day, decimal. */
  perDay: string;
  /** How long it lasts, in days. Default 30. */
  days?: number;
  /** If given, the only addresses the agent may pay. */
  recipients?: string[];
  /**
   * Added to your token approval for the allowance contract: the most this and
   * your other policies for this token can ever spend together, decimal.
   */
  budget: string;
};

export function makePolicies(ctx: Ctx) {
  const policyOf = (id: bigint) =>
    ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "policy", args: [id] }) as Promise<{
      owner: Address; agent: Address; token: Address; expiresAt: bigint; allowlistOnly: boolean; revoked: boolean;
      perPayment: bigint; perDay: bigint; spentInWindow: bigint; windowStart: bigint;
    }>;

  /// The policy's token, so an owner holding no CELO can pay for managing it
  /// in that token, as they could for creating it.
  const gasTokenOf = async (id: bigint) => findToken((await policyOf(id)).token) ?? null;

  async function get(id: bigint | number | string): Promise<Policy> {
    const pid = BigInt(id);
    const [p, remaining] = await Promise.all([
      policyOf(pid),
      ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "remainingToday", args: [pid] }) as Promise<bigint>,
    ]);
    if (/^0x0{40}$/i.test(p.owner)) throw new RemessoError("not_found", `there is no policy ${pid}`);
    const [balance, allowance] = await Promise.all([
      ctx.pub.readContract({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [p.owner] }),
      ctx.pub.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [p.owner, ALLOWANCE] }),
    ]);
    const active = !p.revoked && BigInt(Math.floor(Date.now() / 1000)) < p.expiresAt;
    let spendable = active ? remaining : 0n;
    for (const cap of [p.perPayment, balance, allowance]) if (cap < spendable) spendable = cap;
    return {
      id: pid,
      owner: p.owner,
      agent: p.agent,
      token: p.token,
      symbol: findToken(p.token)?.symbol ?? null,
      perPayment: p.perPayment,
      perDay: p.perDay,
      expiresAt: new Date(Number(p.expiresAt) * 1000),
      allowlistOnly: p.allowlistOnly,
      revoked: p.revoked,
      remainingToday: remaining,
      ownerBalance: balance,
      ownerAllowance: allowance,
      active,
      spendable,
    };
  }

  /// Every policy naming `agent` (default: this account), newest first.
  ///
  /// From `payment-events`, which indexes each PolicyCreated by agent, plus
  /// the ids newer than the newest indexed one read from the chain: the
  /// indexer runs up to a minute behind, and a policy created seconds ago must
  /// show. With the endpoint unreachable, every id is read from the chain.
  async function find(agent?: string): Promise<bigint[]> {
    const who = (agent ? checksum(agent) : ctx.requireAccount().address).toLowerCase();
    let indexed: bigint[] = [];
    try {
      const q = new URLSearchParams({ address: who, role: "agent", kind: "policy_created", limit: "500" });
      const { events } = await ctx.get<{ events: { contract: string; refId: string; removed: boolean }[] }>(`${ctx.endpoints.paymentEvents}?${q}`);
      indexed = [...new Set(events.filter((e) => !e.removed && e.contract === ALLOWANCE.toLowerCase()).map((e) => e.refId))].map(BigInt);
    } catch { /* read the chain instead */ }
    const newest = indexed.reduce((a, b) => (b > a ? b : a), 0n);
    const next = await ctx.pub.readContract({ address: ALLOWANCE, abi: allowanceAbi, functionName: "nextPolicyId" }) as bigint;
    const fresh: bigint[] = [];
    // Read by id in multicall batches: forno answers getLogs over 5,000
    // blocks at most, and ids are dense.
    for (let hi = next - 1n; hi > newest; hi -= 250n) {
      const ids: bigint[] = [];
      for (let id = hi; id > newest && id > hi - 250n; id--) ids.push(id);
      const ps = await ctx.pub.multicall({
        allowFailure: false,
        contracts: ids.map((id) => ({ address: ALLOWANCE, abi: allowanceAbi, functionName: "policy", args: [id] })),
      } as never) as unknown as { agent: Address }[];
      ps.forEach((p, i) => {
        if (p.agent.toLowerCase() === who) fresh.push(ids[i]);
      });
    }
    return [...new Set([...fresh, ...indexed])].sort((a, b) => (b > a ? 1 : -1));
  }

  return {
    get,
    find,

    /// As the owner: approve the budget and create a policy for an agent.
    async create(input: CreatePolicyInput): Promise<{ id: bigint; hash: Hex; approveHash: Hex }> {
      const account = ctx.requireAccount();
      await ctx.assertChain();
      const t = tokenOf(input.token);
      const agent = checksum(input.agent);
      const perPayment = toUnits(input.perPayment, t);
      const perDay = toUnits(input.perDay, t);
      const budget = toUnits(input.budget, t);
      if (perPayment <= 0n || perPayment > perDay) throw new RemessoError("invalid", "perPayment must be above zero and at most perDay");
      const days = input.days ?? 30;
      if (!(days > 0)) throw new RemessoError("invalid", "days must be positive");
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.round(days * 86_400));
      const recipients = (input.recipients ?? []).map(checksum);

      const current = await ctx.pub.readContract({ address: t.address as Address, abi: erc20Abi, functionName: "allowance", args: [account.address, ALLOWANCE] });
      let nonce = await ctx.pub.getTransactionCount({ address: account.address, blockTag: "pending" });
      const { hash: approveHash } = await write(ctx, {
        address: t.address as Address, abi: erc20Abi, functionName: "approve", args: [ALLOWANCE, current + budget], gasToken: t, nonce: nonce++,
      });
      const { hash, receipt } = await write(ctx, {
        address: ALLOWANCE,
        abi: allowanceAbi,
        functionName: "createPolicy",
        args: [agent, t.address, perPayment, perDay, expiresAt, recipients.length > 0, recipients],
        gasToken: t,
        nonce,
      });
      const id = policyIdFrom(receipt.logs);
      if (id == null) throw new RemessoError("http", `created, but ${hash} has no PolicyCreated log`, { hash });
      return { id, hash, approveHash };
    },

    /// As the owner: end a policy now.
    async revoke(id: bigint | number | string): Promise<Hex> {
      return (await write(ctx, {
        address: ALLOWANCE, abi: allowanceAbi, functionName: "revoke", args: [BigInt(id)], gasToken: await gasTokenOf(BigInt(id)),
      })).hash;
    },

    /// As the owner: add a recipient to a policy's allowlist, or take one off.
    async setRecipient(id: bigint | number | string, recipient: string, allowed: boolean): Promise<Hex> {
      return (await write(ctx, {
        address: ALLOWANCE, abi: allowanceAbi, functionName: "setRecipient", args: [BigInt(id), checksum(recipient), allowed],
        gasToken: await gasTokenOf(BigInt(id)),
      })).hash;
    },
  };
}

export type Policies = ReturnType<typeof makePolicies>;

/// The id of the policy a transaction created, from its own PolicyCreated log.
export function policyIdFrom(logs: readonly Log[]): bigint | null {
  const created = parseEventLogs({ abi: allowanceAbi, eventName: "PolicyCreated", logs: logs as Log[] })
    .find((l) => l.address.toLowerCase() === ALLOWANCE.toLowerCase());
  return created ? (created.args as { id: bigint }).id : null;
}
