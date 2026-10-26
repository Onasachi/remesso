/// Payment events, read from the chain by Remesso's indexer: every schedule
/// run and agent policy payment, new or changed. Free, public, by address.
///
/// `seq` moves whenever an event changes (recorded, final, or removed by a
/// reorg), so a reader that passes back `next` sees every change, and an
/// event it saw before it was final comes round again once it is.
import type { Address, Hex } from "viem";
import type { Ctx } from "./context.js";
import { checksum } from "./deployment.js";
import { RemessoError } from "./errors.js";

export type EventKind = "run" | "schedule_created" | "policy_payment" | "policy_created" | "policy_revoked";

export type PaymentEvent = {
  seq: number;
  chainId: number;
  contract: Address;
  kind: EventKind;
  /** The schedule id for a run, the policy id for a policy event. */
  refId: string;
  from: Address | null;
  to: Address | null;
  agent: Address | null;
  token: Address | null;
  /** Base units, after the fee: what arrived. */
  amount: string | null;
  /** For a run, base units before the fee. */
  amountIn: string | null;
  memo: Hex | null;
  memoText: string | null;
  runNumber: number | null;
  early: boolean | null;
  details: Record<string, unknown> | null;
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  blockHash: Hex;
  blockTime: string;
  /** At or below Celo's finalized block. */
  final: boolean;
  /** Undone by a reorg. */
  removed: boolean;
};

export type EventQuery = {
  /** Default: this account. */
  address?: string;
  /** Which side of the event the address is on. Default any. */
  role?: "to" | "from" | "agent" | "any";
  kinds?: EventKind[];
  /** The `next` of a previous page. Default 0: from the start. */
  after?: number;
  /** 1 to 500. Default 100. */
  limit?: number;
};

export function makeEvents(ctx: Ctx) {
  async function list(q: EventQuery = {}): Promise<{ events: PaymentEvent[]; next: number }> {
    const address = (q.address ? checksum(q.address) : ctx.account?.address)?.toLowerCase();
    if (!address) throw new RemessoError("invalid", "address is required without an account");
    const params = new URLSearchParams({ address, role: q.role ?? "any", after: String(q.after ?? 0), limit: String(q.limit ?? 100) });
    if (q.kinds?.length) params.set("kind", q.kinds.join(","));
    return await ctx.get<{ events: PaymentEvent[]; next: number }>(`${ctx.endpoints.paymentEvents}?${params}`);
  }

  /// Every event from `after` on, then each new one or change as it comes,
  /// until `signal` aborts. Polls every `intervalMs` (default 15s) when idle.
  async function* watch(q: EventQuery & { intervalMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<PaymentEvent> {
    let after = q.after ?? 0;
    while (!q.signal?.aborted) {
      const page = await list({ ...q, after, limit: q.limit ?? 500 });
      for (const e of page.events) yield e;
      after = page.next;
      if (page.events.length < (q.limit ?? 500)) await sleep(q.intervalMs ?? 15_000, q.signal);
    }
  }

  return {
    list,
    watch,
    /// The first event, from `after` on, that `match` accepts.
    async waitFor(
      match: (e: PaymentEvent) => boolean,
      q: EventQuery & { timeoutMs?: number; intervalMs?: number } = {},
    ): Promise<PaymentEvent> {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), q.timeoutMs ?? 20 * 60_000);
      try {
        for await (const e of watch({ ...q, signal: stop.signal })) if (match(e)) return e;
      } finally {
        clearTimeout(timer);
      }
      throw new RemessoError("timeout", "no matching payment event in time");
    },
  };
}

export type Events = ReturnType<typeof makeEvents>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
