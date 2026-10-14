"use client";

import type { ScheduleNotice } from "./notices";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts, useSimulateContract } from "wagmi";
import { detectMiniPay } from "./wagmi";
import { supabase } from "./supabase";
import { identityStanding } from "./api";
import { fetchOnchainRuns, goldskyEnabled } from "./goldsky";
import { mergeHistory } from "./history";
import { executorAbi, executorAddressAbi, erc20Abi, quoterAbi } from "./abi";
import {
  CNGN,
  DIRECT_TOKENS,
  EXECUTOR_ADDRESS,
  POOL_FEE,
  QUOTER,
  USDT,
  isConfigured,
  type TokenInfo,
} from "./config";
import type { Numeric, PaymentRequest, Run, Schedule } from "./types";

/// The `senders` row for the connected wallet. Everything else keys off it, so
/// it is fetched once and shared rather than re-derived per component.
export function useSenderId() {
  const { address } = useAccount();
  return useQuery({
    queryKey: ["sender", address],
    enabled: Boolean(address),
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("senders")
        .select("id")
        .eq("wallet_address", address!.toLowerCase())
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.id as string | undefined) ?? null;
    },
  });
}

export function useSchedules() {
  const { data: senderId } = useSenderId();
  return useQuery({
    queryKey: ["schedules", senderId],
    enabled: Boolean(senderId),
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("schedules")
        .select("*, recipients(*)")
        .eq("sender_id", senderId!)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Schedule[];
    },
  });
}

export function useSchedule(id: string) {
  return useQuery({
    queryKey: ["schedule", id],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("schedules")
        .select("*, recipients(*)")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as Schedule | null) ?? null;
    },
  });
}

export function useRuns(scheduleId: string) {
  return useQuery({
    queryKey: ["runs", scheduleId],
    // An in-flight bank payout changes state without any action from this
    // browser, so poll rather than waiting for a refocus.
    refetchInterval: (q) => {
      const runs = q.state.data as Run[] | undefined;
      const open = runs?.some((r) =>
        ["pending", "swapping", "redeeming"].includes(r.status),
      );
      return open ? 15_000 : false;
    },
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("runs")
        .select("*")
        .eq("schedule_id", scheduleId)
        .order("attempt", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Run[];
    },
  });
}

/// `RunExecuted` events for one schedule, from the Goldsky subgraph. Polled
/// hard while a run is expected — the schedule is due, or a row is in flight —
/// because that is the window a sender is actually watching, and a subgraph
/// on Celo's 1s blocks is a few seconds behind the chain, not fifteen.
///
/// Disabled without `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL`; `useHistory` then
/// renders the database alone.
export function useOnchainRuns(schedule: Schedule | null | undefined, dbRuns: Run[] | undefined) {
  const onchainId = schedule?.onchain_id ?? null;
  const active = schedule?.status === "active";
  const inflight = dbRuns?.some((r) => ["pending", "swapping"].includes(r.status)) ?? false;
  // The backend advances `next_run_at` only after the run, so "due" holds from
  // the moment a run should fire until the database catches up — exactly the
  // stretch where the chain is ahead and worth asking often.
  const due =
    active &&
    schedule?.next_run_at != null &&
    Date.parse(schedule.next_run_at) - Date.now() < 60_000;

  return useQuery({
    queryKey: ["onchain-runs", onchainId],
    enabled: goldskyEnabled() && onchainId != null,
    queryFn: ({ signal }) => fetchOnchainRuns(onchainId!, signal),
    refetchInterval: inflight || due ? 3_000 : active ? 15_000 : false,
    refetchOnWindowFocus: true,
  });
}

/// The history a sender sees: database rows, with the chain allowed to run
/// ahead of them. The merge itself is `mergeHistory` in history.ts; this is
/// the polling and cache side.
export function useHistory(id: string, schedule: Schedule | null | undefined) {
  const db = useRuns(id);
  const chain = useOnchainRuns(schedule, db.data);
  const queryClient = useQueryClient();

  // When the chain shows a run the database has not settled yet, ask the
  // database again now rather than on its own 15s cadence: the row's
  // cNGN reference and gas figures arrive with the backend's write.
  const settledOnchain = chain.data?.length ?? 0;
  const settledInDb = db.data?.filter((r) => r.tx_hash).length ?? 0;
  useEffect(() => {
    if (settledOnchain > settledInDb) {
      queryClient.invalidateQueries({ queryKey: ["runs", id] });
    }
  }, [settledOnchain, settledInDb, queryClient, id]);

  const runs = useMemo(
    () => mergeHistory(schedule, db.data, chain.data ?? null),
    [schedule, db.data, chain.data],
  );
  return { ...db, data: db.data === undefined ? undefined : runs };
}

/// Milliseconds until a moment, re-rendered as it moves.
///
/// Ticks every second inside the last hour and every half minute before that:
/// a countdown nobody can see move is just a re-render. Returns `null` when
/// there is nothing to count towards, and never goes below zero — what
/// happens after the moment is the contract's business, not the clock's.
export function useTimeUntil(target: string | number | null | undefined): number | null {
  const targetMs = target == null
    ? null
    : typeof target === "number"
      ? target * 1000
      : Date.parse(target);

  const [remaining, setRemaining] = useState(() =>
    targetMs == null || Number.isNaN(targetMs) ? null : Math.max(0, targetMs - Date.now())
  );

  useEffect(() => {
    if (targetMs == null || Number.isNaN(targetMs)) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, targetMs - Date.now()));
    tick();
    const far = targetMs - Date.now() > 3600_000;
    const id = setInterval(tick, far ? 30_000 : 1000);
    return () => clearInterval(id);
  }, [targetMs]);

  return remaining;
}

/// The sender's Self verification standing. Optional and gates nothing — it is
/// read for the badge only, never by anything that decides whether a run pays.
///
/// Polls while an attempt is open: the sender finishes in the Self app, not
/// here, so nothing in this browser signals completion except asking.
export function useIdentity() {
  const { data: senderId } = useSenderId();
  return useQuery({
    queryKey: ["identity", senderId],
    enabled: Boolean(senderId),
    queryFn: identityStanding,
    refetchInterval: (q) => (q.state.data?.latest?.status === "pending" ? 10_000 : false),
  });
}

/// The contract's own view of whether a schedule can run. This is the authority
/// — the database mirrors it — so anything that tells a sender "your next
/// payment will go through" reads from here, not from a row.
export function useRunnability(onchainId: Numeric | null, executor?: string | null) {
  // The schedule's own contract, not the one this build creates against. After
  // a migration both exist, ids collide across deployments, and asking the new
  // contract about an old id answers about somebody else's schedule.
  const address = (executor && /^0x[a-fA-F0-9]{40}$/.test(executor)
    ? (executor as `0x${string}`)
    : EXECUTOR_ADDRESS);
  return useReadContract({
    address,
    abi: executorAbi,
    functionName: "runnability",
    args: onchainId ? [BigInt(onchainId)] : undefined,
    query: {
      enabled: Boolean(onchainId) && isConfigured(),
      refetchInterval: 30_000,
      select: (r) => ({
        due: r[0],
        funded: r[1],
        approved: r[2],
        floor: r[3],
        nextRunAt: r[4],
      }),
    },
  });
}

/// The schedule as the contract holds it, including the trigger grant.
///
/// Read from chain rather than mirrored in the database: a grant is an
/// authority, and the only honest source for what authority exists is the
/// contract that enforces it.
export function useOnchainSchedule(onchainId: Numeric | null, executor?: string | null) {
  const address = executor && /^0x[a-fA-F0-9]{40}$/.test(executor)
    ? (executor as `0x${string}`)
    : EXECUTOR_ADDRESS;
  return useReadContract({
    address,
    abi: executorAbi,
    functionName: "getSchedule",
    args: onchainId ? [BigInt(onchainId)] : undefined,
    query: { enabled: Boolean(onchainId) && isConfigured(), refetchInterval: 30_000 },
  });
}

/// The commission a schedule created right now would be pinned with.
///
/// Read live rather than hardcoded: it is an owner setting, capped in the
/// contract, and a review screen that quotes a stale rate is telling the
/// sender something the contract will not do. Undefined while loading, and
/// treated as zero — never as a guess.
export function useFeeBps() {
  return useReadContract({
    address: EXECUTOR_ADDRESS,
    abi: executorAbi,
    functionName: "feeBps",
    query: { enabled: isConfigured(), staleTime: 5 * 60_000, retry: false },
  });
}

/// The sender's USDT allowance to the executor contract.
///
/// This is the outermost cap on everything Remesso can ever do, and it is
/// revocable without our cooperation — so the UI shows it as a running balance
/// rather than a setup step that disappears once completed.
export function useAllowance(token: `0x${string}` = USDT.address) {
  const { address } = useAccount();
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, EXECUTOR_ADDRESS] : undefined,
    query: { enabled: Boolean(address) && isConfigured(), refetchInterval: 20_000 },
  });
}

/// Balance of the schedule's funding asset — USDT by default, but a Direct
/// schedule may be funded in USDC or USDm.
export function useUsdtBalance(token: `0x${string}` = USDT.address) {
  const { address } = useAccount();
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 20_000 },
  });
}

/// Every asset the sender can fund a schedule with, in one read.
///
/// The dollar stablecoins are summed at 1:1 — close enough for a balance
/// line, and honest as long as it is labelled "USD" rather than pretending to
/// quote a market. wFIAT is left out of the total: a peso is not a dollar,
/// and converting would mean quoting a rate here. `totalUsd6` is at 6dp so
/// USDm's 18dp does not have to be carried through the display path.
/// Every asset the home screen shows a balance for. cNGN is among them, so a
/// wallet holding it can see it and cash it out (lib/textile.ts).
const HELD_TOKENS: TokenInfo[] = DIRECT_TOKENS;

export function useBalances() {
  const { address } = useAccount();
  const reads = useReadContracts({
    contracts: HELD_TOKENS.map((t) => ({
      address: t.address,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: address ? [address] : undefined,
    })),
    query: { enabled: Boolean(address), refetchInterval: 20_000 },
  });

  const balances: Array<{ token: TokenInfo; balance?: bigint }> = HELD_TOKENS.map((token, i) => {
    const r = reads.data?.[i];
    return { token, balance: r?.status === "success" ? (r.result as bigint) : undefined };
  });
  const loaded = balances.filter((b) => b.balance !== undefined && b.token.currency === "USD");
  const totalUsd6 = loaded.length
    ? loaded.reduce(
        (acc, b) => acc + (b.balance! * 1_000_000n) / 10n ** BigInt(b.token.decimals),
        0n,
      )
    : undefined;

  return { balances, totalUsd6, isPending: reads.isPending };
}

/// The Direct assets the contract will accept for a NEW schedule, read from
/// its allowlist. The owner widens it with `setDirectToken`; offering a token
/// before then would let a sender fill in the whole form and meet
/// TokenNotAllowed at signing. While loading, or if the read fails, the
/// dollar stablecoins — allowed since deploy, so the fallback can hide a
/// token but never offer one the contract refuses.
export function useAllowedDirectTokens(): TokenInfo[] {
  const reads = useReadContracts({
    contracts: DIRECT_TOKENS.map((t) => ({
      address: EXECUTOR_ADDRESS,
      abi: executorAbi,
      functionName: "directTokenAllowed" as const,
      args: [t.address],
    })),
    query: { enabled: isConfigured(), staleTime: 5 * 60_000 },
  });
  return useMemo(() => {
    if (!reads.data) return DIRECT_TOKENS.filter((t) => t.currency === "USD");
    return DIRECT_TOKENS.filter((_, i) => {
      const r = reads.data[i];
      return r?.status === "success" && r.result === true;
    });
  }, [reads.data]);
}

/// A live USDT -> cNGN rate from the one pool that exists on Celo.
///
/// Shown so the sender's floor rate is set against the actual market rather
/// than a number they guessed. Quoted at the real trade size, because the pool
/// holds around $95k and a large run does not get the headline rate.
export function useMarketRate(amountIn: bigint) {
  const sim = useSimulateContract({
    address: QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: USDT.address,
        tokenOut: CNGN.address,
        amountIn: amountIn > 0n ? amountIn : 1_000_000n,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
    query: { enabled: isConfigured(), refetchInterval: 60_000, retry: 1 },
  });

  const amountOut = sim.data?.result?.[0];
  const effective = amountIn > 0n && amountOut !== undefined
    ? (amountOut * 1_000_000n) / amountIn
    : undefined;

  return {
    /// Floor-rate units: cNGN base units out per 1e6 USDT base units in.
    rateE6: effective,
    amountOut,
    isLoading: sim.isLoading,
    error: sim.error,
  };
}

/// Where MiniPay detection stands: `undefined` while still deciding, then a
/// boolean. Anything that would render a Connect button must wait for `false`
/// — rendering one during `undefined` is exactly what MiniPay rejects.
///
/// Also hydration-safe: the server and the first client pass both see
/// `undefined`, so React keeps the server HTML.
export function useMiniPayState(): boolean | undefined {
  const [state, setState] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    detectMiniPay().then((v) => live && setState(v));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/// True only once MiniPay is confirmed. For choices that are safe to make as
/// "not MiniPay" while detection runs (copy, links). Event handlers should
/// keep calling `isMiniPay()` directly; they only ever run on the client.
export function useIsMiniPay(): boolean {
  return useMiniPayState() === true;
}

/// Open notices from the pre-flight agent (supabase/functions/preflight): what
/// it found wrong with an upcoming payment. Read-only for the sender — the
/// agent resolves a notice itself once the problem is fixed, so a notice that
/// disappears is one that no longer applies.
export function useNotices() {
  const { address } = useAccount();
  return useQuery({
    queryKey: ["schedule-notices", address],
    enabled: Boolean(address),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("schedule_notices")
        .select("id, schedule_id, kind, severity, details, updated_at")
        .is("resolved_at", null)
        .order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as ScheduleNotice[];
    },
  });
}

/// Inbound "please pay me" requests addressed to this wallet.
///
/// Keyed on the connected address rather than the sender id: whoever is asking
/// knows a wallet and nothing else about us, which is the whole point of the
/// endpoint they used.
export function usePaymentRequests() {
  const { address } = useAccount();
  return useQuery({
    queryKey: ["payment-requests", address],
    enabled: Boolean(address),
    // These arrive while the app is open, and a request nobody sees is a
    // request that did not happen. Cheap query, small table.
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase().rpc("payment_requests_for", {
        p_address: address!,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as PaymentRequest[];
    },
  });
}

/// The address a sender grants when they allow early sending.
///
/// Read from the contract, not configured. `setExecutor` can change it, and a
/// grant naming a stale address is a grant that silently does nothing — the
/// schedule would look permissive and refuse every call.
export function useTriggerAddress() {
  const q = useReadContract({
    address: EXECUTOR_ADDRESS,
    abi: executorAddressAbi,
    functionName: "executor",
    query: { enabled: isConfigured(), staleTime: 60 * 60_000 },
  });
  // Narrowed by hand: viem infers nothing useful from a one-entry
  // human-readable ABI, and an address that arrives as `{}` is an address the
  // caller will happily write into a grant.
  return { ...q, data: q.data as `0x${string}` | undefined };
}
