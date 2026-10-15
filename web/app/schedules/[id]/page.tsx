"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { classifyRun } from "@/lib/ai";
import { useAccount, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { txOverrides } from "@/lib/tx";
import { executorAbi } from "@/lib/abi";
import { EXECUTOR_ADDRESS, EXPLORER, CNGN, tokenFor } from "@/lib/config";
import { supabase } from "@/lib/supabase";
import {
  useHistory,
  useIsMiniPay,
  useOnchainSchedule,
  useRunnability,
  useSchedule,
  useTimeUntil,
  useTriggerAddress,
} from "@/lib/hooks";
import { recipientLabel } from "@/lib/identity";
import { TEXTILE_NAIRA_WITHDRAW, textileNairaCashOut } from "@/lib/textile";
import {
  countdown,
  everyLabel,
  formatUnits,
  rateToNairaPerUsd,
  relativeTime,
} from "@/lib/format";
import { RunPill, SchedulePill } from "@/components/StatusPill";
import { ReapproveButton } from "@/components/Reapprove";
import { Amount, CopyValue, MINIPAY_DEPOSIT_URL, Row, Sheet, Skeleton } from "@/components/ui";
import { one, type Run } from "@/lib/types";
import { failureCopy } from "@/lib/failures";
import { Notices } from "@/components/Notices";

/// No trigger. `setTrigger(id, ZERO, 0)` withdraws a grant.
const ZERO = "0x0000000000000000000000000000000000000000" as const;

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const justCreated = useSearchParams().get("created") === "1";
  const inMiniPay = useIsMiniPay();
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const { address: connected } = useAccount();
  const { data: triggerAddress } = useTriggerAddress();

  // `isPending`, not `isLoading`: the latter drops to false between retry
  // attempts, and this page would then say the schedule does not exist while
  // the fetch was still in flight.
  const { data: schedule, isPending, error: loadError, refetch } = useSchedule(id);
  // Database rows with the chain allowed ahead of them — see `useHistory`.
  const { data: runs } = useHistory(id, schedule);
  const { data: runnability } = useRunnability(
    schedule?.onchain_id ?? null,
    schedule?.executor_address,
  );
  const { data: onchain, refetch: refetchOnchain } = useOnchainSchedule(
    schedule?.onchain_id ?? null,
    schedule?.executor_address,
  );

  // The contract's own next-run time when it has answered, the database mirror
  // until then. Both are advisory here — this is a clock, not a promise.
  const nextRunAt = runnability?.nextRunAt != null
    ? Number(runnability.nextRunAt)
    : schedule?.next_run_at ?? null;
  const untilNext = useTimeUntil(schedule?.status === "active" ? nextRunAt : null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (isPending) return <DetailSkeleton />;
  // A failed fetch and a missing row are different answers. Telling someone
  // their schedule "doesn't exist" because the network dropped is the kind of
  // message that makes them think their money is gone.
  if (loadError) {
    return (
      <div className="notice-danger mt-2 flex items-center justify-between gap-3">
        <span>Couldn&rsquo;t load this schedule. Check your connection.</span>
        <button className="btn-ink btn-sm shrink-0" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!schedule) return <div className="notice-info mt-2">This schedule doesn&rsquo;t exist.</div>;

  const recipient = one(schedule.recipients);
  const isBank = recipient?.payout_type === "ngn_bank";
  // A sender paying their own wallet. Rare, but the one case where showing
  // the recipient address would be showing them their own — which MiniPay's
  // listing rules forbid outright.
  const isOwnWallet =
    Boolean(connected) &&
    recipient?.wallet_address?.toLowerCase() === connected?.toLowerCase();
  // Direct moves the funding asset untouched — there is no swap to link to.
  const converts = recipient?.payout_type !== "direct";
  const live = schedule.status === "active" || schedule.status === "paused";

  async function act(action: "pause" | "resume" | "cancel" | "revoke") {
    if (!schedule?.onchain_id) return;
    setError(null);
    setBusy(
      action === "cancel" ? "Cancelling…" : action === "revoke" ? "Revoking…" : "Updating…",
    );
    try {
      const hash =
        // Withdrawing a grant is `setTrigger(id, 0, 0)`: nobody may collect,
        // and nothing else about the schedule moves.
        action === "revoke"
          ? await writeContractAsync({
              address: EXECUTOR_ADDRESS,
              abi: executorAbi,
              functionName: "setTrigger",
              args: [BigInt(schedule.onchain_id), ZERO, 0],
              ...txOverrides(),
            })
          : action === "cancel"
          ? await writeContractAsync({
              address: EXECUTOR_ADDRESS,
              abi: executorAbi,
              functionName: "cancelSchedule",
              args: [BigInt(schedule.onchain_id)],
              ...txOverrides(),
            })
          : await writeContractAsync({
              address: EXECUTOR_ADDRESS,
              abi: executorAbi,
              functionName: "setScheduleActive",
              args: [BigInt(schedule.onchain_id), action === "resume"],
              ...txOverrides(),
            });
      await waitForTransactionReceipt(wagmiConfig, { hash });

      // A grant lives only on-chain, so there is no mirror to update — just
      // re-read it.
      if (action === "revoke") {
        await refetchOnchain();
      } else {
        // The contract is already the authority; this mirrors it so the executor
        // loop stops picking the schedule up on its next tick.
        await supabase()
          .from("schedules")
          .update({
            status: action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "active",
          })
          .eq("id", schedule.id);
      }

      await queryClient.invalidateQueries({ queryKey: ["schedule", schedule.id] });
      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      if (action === "cancel") router.push("/");
    } catch (e) {
      const msg = (e as Error).message;
      setError(/User rejected|denied/i.test(msg) ? "You cancelled the signature." : msg.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  const token = tokenFor(schedule.token_address);
  const name = schedule.label || recipient?.display_name || "Remittance";

  return (
    <div className="stagger">
      {justCreated && (
        <div className="notice-good mt-2 flex items-start gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-naira text-[11px] text-surface" aria-hidden>
            ✓
          </span>
          <span>
            <span className="font-medium">You&rsquo;re all set.</span> This runs on its own now
            — nothing else to do. Come back any time to check on it.
          </span>
        </div>
      )}

      <section className="mt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-clay-soft font-display text-2xl text-clay-deep" aria-hidden>
              {name.trim().charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[17px] font-medium text-ink">{name}</h1>
              <p className="truncate text-[13px] text-ink-2">
                {isBank
                  ? `${recipient?.account_name} · ${recipient?.account_number}`
                  : recipient?.phone_masked || recipientLabel(null, recipient?.wallet_address)}
              </p>
            </div>
          </div>
          <SchedulePill status={schedule.status} />
        </div>

        <div className="mt-5">
          <Amount value={formatUnits(schedule.amount_in, token.decimals)} unit={token.symbol} size="hero" />
          <p className="mt-2 text-[15px] text-ink-2">
            {everyLabel(schedule.interval_seconds)}
            {schedule.status === "active" && untilNext !== null && (
              <>
                <span className="text-ink-3"> · </span>
                {untilNext > 0 ? "next in " : ""}
                <span className={`font-medium tabular-nums ${untilNext > 0 ? "text-ink" : "text-clay-deep"}`}>
                  {countdown(untilNext)}
                </span>
              </>
            )}
          </p>
        </div>
      </section>

      {/* Everything the pre-flight agent found about this schedule's next
          payment, each with its fix. */}
      <Notices scheduleId={schedule.id} />

      <dl className="mt-5 divide-y divide-line/70 border-y border-line/70">
        {converts && (
          <Row label="Rate floor">₦{rateToNairaPerUsd(schedule.min_rate_e6).toFixed(0)} per USDT</Row>
        )}
        {schedule.max_runs > 0 && <Row label="Transfers">{schedule.max_runs}</Row>}
        {schedule.expires_at && (
          <Row label="Expires">
            {new Date(schedule.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          </Row>
        )}
        {/* The recipient's address, in full and copyable.
            Shown so a sender can hand it to an agent that needs to watch for
            these payments, and so they can check against what they were given
            before the next transfer goes out. Never rendered when it is the
            sender's own wallet: MiniPay's rules forbid showing the user their
            own address, truncated forms included. Inside MiniPay it is never
            shown at all — the rule covers every address, and a recipient
            found by phone number is named by that number instead. */}
        {!isBank && recipient?.phone_masked && (
          <Row label="Paid to">MiniPay · {recipient.phone_masked}</Row>
        )}
        {!isBank && recipient?.wallet_address && !isOwnWallet && !inMiniPay && !recipient?.phone_masked && (
          <Row label="Paid to">
            <CopyValue
              value={recipient.wallet_address}
              display={`${recipient.wallet_address.slice(0, 10)}…${recipient.wallet_address.slice(-6)}`}
            />
          </Row>
        )}
        {schedule.onchain_id && (
          <Row label="Reference">
            <span className="mono">#{schedule.onchain_id}</span>
          </Row>
        )}
      </dl>

      {/* How a Nigerian recipient of USDT gets naira into a bank: Textile's
          swap to cNGN, then its Withdraw NGN. Theirs to do, on Textile, with
          their own wallet; Remesso only links (lib/textile.ts). Not inside
          MiniPay, which has its own cash-out and whose rules keep a Mini App
          from sending people to withdraw elsewhere. */}
      {!isBank && !inMiniPay && textileNairaCashOut(token) && (
        <p className="hint mt-3">
          Recipient in Nigeria? They can turn this USDT into naira in their bank account on{" "}
          <a href={textileNairaCashOut(token)!} target="_blank" rel="noopener noreferrer" className="underline">
            Textile
          </a>
          : swap it to cNGN, then Withdraw NGN. They do it from their own wallet.
        </p>
      )}
      {!isBank && !inMiniPay && token.currency === "NGN" && recipient?.payout_type === "direct" && (
        <p className="hint mt-3">
          They receive cNGN and can{" "}
          <a href={TEXTILE_NAIRA_WITHDRAW} target="_blank" rel="noopener noreferrer" className="underline">
            withdraw it to their own Nigerian bank account on Textile
          </a>
          , from their own wallet.
        </p>
      )}

      {/* The contract's own answer, not our mirror of it. If these disagree, the
          contract is right and the sender needs to know which one is blocking. */}
      {runnability && live && (
        <section className="mt-6">
          <p className="eyebrow mb-3">Next transfer</p>
          <ul className="space-y-2.5">
            <Check
              ok={runnability.funded}
              label={`Enough ${token.symbol} in your wallet`}
              failLabel={`Not enough ${token.symbol} in your wallet`}
              fix={
                inMiniPay ? (
                  <a href={MINIPAY_DEPOSIT_URL} className="font-medium text-clay-deep underline underline-offset-2">
                    Add money
                  </a>
                ) : (
                  "Top up your wallet."
                )
              }
            />
            <Check
              ok={runnability.approved}
              label="Allowed to send the next one"
              failLabel="Not allowed to send any more"
              fix={
                <>
                  Remesso can&rsquo;t send any more of your {token.symbol}.
                  <ReapproveButton token={token} label="Allow payments again" />
                </>
              }
            />
            <Check
              ok={runnability.due || schedule.status !== "active"}
              label="Due now"
              failLabel="Not due yet"
              fix={
                untilNext !== null && untilNext > 0
                  ? `Next attempt in ${countdown(untilNext)}.`
                  : "Due now — waiting for it to go through."
              }
              neutral
            />
          </ul>
        </section>
      )}

      {live && onchain?.trigger && onchain.trigger !== ZERO && (
        <section className="mt-6">
          <p className="eyebrow mb-3">Collecting early</p>
          <div className="rounded-xl border border-line bg-surface p-4">
            <p className="text-[15px] text-ink">
              A program can bring forward{" "}
              <span className="font-medium">
                {onchain.triggersLeft} {onchain.triggersLeft === 1 ? "transfer" : "transfers"}
              </span>
            </p>
            {/* "Remesso" when it is our executor, hex when it is not — the
                same rule as the review step. A sender who never typed an
                address cannot check one. */}
            <p className="mt-1 text-[12px] text-ink-2">
              {triggerAddress && onchain.trigger.toLowerCase() === triggerAddress.toLowerCase()
                ? "Remesso, on your behalf"
                : (
                  <span className="mono">
                    {onchain.trigger.slice(0, 10)}…{onchain.trigger.slice(-6)}
                  </span>
                )}
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Same amount, same person, and never more often than once a minute. It
              cannot change anything you signed.
            </p>
            <button
              className="btn-soft btn-sm mt-3"
              disabled={Boolean(busy)}
              onClick={() => act("revoke")}
            >
              {busy === "Revoking…" ? "Withdrawing…" : "Withdraw this"}
            </button>
          </div>
        </section>
      )}

      {live && (
        <div className="mt-6 flex gap-2">
          <button
            className="btn-soft flex-1"
            disabled={Boolean(busy)}
            onClick={() => act(schedule.status === "active" ? "pause" : "resume")}
          >
            {busy && busy !== "Cancelling…" ? busy : schedule.status === "active" ? "Pause" : "Resume"}
          </button>
          <button
            className="btn-danger flex-1"
            disabled={Boolean(busy)}
            onClick={() => setConfirmCancel(true)}
          >
            {busy === "Cancelling…" ? busy : "Cancel"}
          </button>
        </div>
      )}
      {error && (
        <div className="notice-danger mt-3" role="alert">
          {error}
        </div>
      )}

      <Sheet open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel this schedule?">
        <p className="text-[15px] leading-relaxed text-ink-2">
          No more transfers to {name}. This is written to the contract and cannot be undone —
          to start again you would set up a new schedule.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            className="btn-danger bg-danger text-surface hover:bg-danger/90"
            onClick={() => {
              setConfirmCancel(false);
              act("cancel");
            }}
          >
            Yes, cancel it
          </button>
          <button className="btn-ghost" onClick={() => setConfirmCancel(false)}>
            Keep it
          </button>
        </div>
      </Sheet>

      <section className="mt-8">
        <h2 className="font-display text-[22px] text-ink">History</h2>
        {!runs?.length ? (
          <p className="mt-2 text-[14px] text-ink-2">
            {schedule.status === "active"
              ? "Nothing yet. The first transfer will show up here."
              : "No transfers were made."}
          </p>
        ) : (
          <ol className="mt-3">
            {runs.map((r, i) => (
              <RunRow key={r.id} run={r} isBank={isBank} converts={converts} last={i === runs.length - 1} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mt-4" aria-busy>
      <div className="flex items-center gap-3">
        <Skeleton className="h-12 w-12 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="mt-6 h-11 w-2/3" />
      <Skeleton className="mt-3 h-4 w-1/2" />
      <div className="mt-6 space-y-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    </div>
  );
}

const DOT: Record<Run["status"], string> = {
  pending: "bg-amber",
  swapping: "bg-amber",
  delivered: "bg-naira",
  redeeming: "bg-amber",
  paid_out: "bg-naira",
  failed: "bg-danger",
  skipped: "bg-ink-3",
};

function RunRow({
  run,
  isBank,
  converts,
  last,
}: {
  run: Run;
  isBank: boolean;
  converts: boolean;
  last: boolean;
}) {
  const token = tokenFor(run.token_address);
  // A bank run's `delivered` is mid-flight, not done, so its dot stays amber.
  const dot = isBank && run.status === "delivered" ? "bg-amber" : DOT[run.status];

  return (
    <li className="relative flex gap-4 pb-6">
      {!last && <span className="absolute left-[5px] top-4 h-full w-px bg-line" aria-hidden />}
      <span className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full ring-4 ring-paper ${dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[15px] text-ink">
              <Amount value={formatUnits(run.amount_in, token.decimals)} unit={token.symbol} size="sm" />
              {run.amount_out && run.amount_out !== run.amount_in && (
                <>
                  <span className="text-ink-3"> → </span>
                  <span className="font-medium text-naira">₦{formatUnits(run.amount_out, CNGN.decimals, 0)}</span>
                </>
              )}
            </p>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {relativeTime(run.started_at)} · #{run.attempt}
            </p>
          </div>
          <RunPill status={run.status} isBank={isBank} converts={converts} />
        </div>

        {/* The distinction this whole design exists to preserve: the swap landing
            is not the recipient being paid. */}
        {isBank && (run.status === "redeeming" || run.status === "delivered") && (
          <p className="notice-info mt-2">
            The conversion is done and the bank payout is in progress. It isn&rsquo;t settled
            until the bank confirms it.
          </p>
        )}

        {run.failure_reason && (
          <WhatHappened reason={run.failure_reason} skipped={run.status === "skipped"} />
        )}

        {(run.tx_hash || run.cngn_trx_ref) && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {run.tx_hash && (
              <a
                className="text-ink-2 underline underline-offset-2 hover:text-ink"
                href={`${EXPLORER}/tx/${run.tx_hash}`}
                target="_blank"
                rel="noreferrer"
              >
                {converts ? "View conversion" : "View transfer"}
              </a>
            )}
            {run.cngn_trx_ref && <span className="mono text-ink-3">{run.cngn_trx_ref}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

/// One readiness line. A failing check names the problem rather than showing
/// a red mark beside a sentence that says the opposite.
function Check({
  ok,
  label,
  failLabel,
  fix,
  neutral,
}: {
  ok: boolean;
  label: string;
  failLabel: string;
  fix: React.ReactNode;
  neutral?: boolean;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
          ok ? "bg-naira text-surface" : neutral ? "border border-line text-ink-3" : "bg-danger text-surface"
        }`}
        aria-hidden
      >
        {ok ? "✓" : neutral ? "" : "!"}
      </span>
      <div className="text-[15px] text-ink">
        {ok ? label : failLabel}
        {!ok && <div className="text-[13px] text-ink-2">{fix}</div>}
      </div>
    </li>
  );
}

/// The backend's reason, in Remesso's own words.
///
/// The raw string is always rendered and never replaced — it is what actually
/// happened, and it is what someone will quote when asking for help. Above it
/// sits one of our sentences, chosen by category: the backend matches the
/// reasons it writes itself, and asks Jev only about reasons it has never
/// seen. No model writes the words a sender reads about their money; the worst
/// a wrong category can do is show a sentence that fits less well than it
/// could, with the real reason directly underneath.
function WhatHappened({ reason, skipped }: { reason: string; skipped: boolean }) {
  const { data } = useQuery({
    queryKey: ["classify", reason],
    queryFn: () => classifyRun(reason),
    // Reasons repeat across runs and a category is not time-sensitive, so this
    // is cached hard rather than re-asked per render.
    staleTime: 24 * 3600 * 1000,
    gcTime: 24 * 3600 * 1000,
    retry: false,
  });

  const copy = failureCopy(data?.category);
  // A skip is usually the contract doing its job — the floor held, or the
  // wallet was short — so it is drawn as a caution, not a failure.
  const calm = skipped || copy.expected;

  return (
    <div className={`${calm ? "notice-warn" : "notice-danger"} mt-2`}>
      <p className="text-ink">
        <span className="font-medium">{copy.title}.</span> {copy.detail}
        {copy.action && <span className="font-medium"> {copy.action}.</span>}
      </p>
      <p className="mono mt-1.5 border-t border-ink/10 pt-1.5 text-[12px] opacity-80">{reason}</p>
    </div>
  );
}
