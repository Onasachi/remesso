"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { useAllowedDirectTokens, useBalances, useIsMiniPay, useMiniPayState, useSchedules } from "@/lib/hooks";
import { recipientLabel } from "@/lib/identity";
import { formatUnits, intervalLabel, relativeTime } from "@/lib/format";
import { SchedulePill } from "@/components/StatusPill";
import { IdentityCard } from "@/components/IdentityCard";
import { PaymentRequests } from "@/components/PaymentRequests";
import { ReapproveButton, useApprovalCover } from "@/components/Reapprove";
import { ActionBar, Amount, MINIPAY_DEPOSIT_URL, Skeleton } from "@/components/ui";
import { isConfigured, tokenFor, USDT, type TokenInfo } from "@/lib/config";
import { one, type Schedule } from "@/lib/types";

export default function SchedulesPage() {
  const { isConnected } = useAccount();
  const { data: schedules, isPending, error } = useSchedules();
  // Which asset the balance strip is showing. The total is always the sum;
  // the switcher only changes which per-asset figure and allowance appear.
  const [token, setToken] = useState<TokenInfo>(USDT);
  const { balances, totalUsd6 } = useBalances();
  const inMiniPay = useIsMiniPay();

  if (!isConfigured()) {
    return (
      <div className="notice-warn mt-2">
        <p className="font-medium">Not configured</p>
        <p className="mt-1">
          <code>NEXT_PUBLIC_REMESSO_EXECUTOR_ADDRESS</code> is unset, so there is no contract
          to read. Deploy <code>RemessoExecutor</code> and set it in <code>.env.local</code>.
        </p>
      </div>
    );
  }

  if (!isConnected) return <Landing />;

  const hasSchedules = Boolean(schedules?.length);

  return (
    <div className="pb-bar">
      <section className="mt-2">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Total balance</p>
            {totalUsd6 === undefined ? (
              <Skeleton className="mt-1.5 h-9 w-36" />
            ) : (
              <p className="font-display text-[36px] leading-none text-ink">
                <span className="mr-0.5 text-[22px] text-ink-3">$</span>
                {formatUnits(totalUsd6, 6)}
              </p>
            )}
          </div>
          {inMiniPay && (
            <a href={MINIPAY_DEPOSIT_URL} className="btn-soft btn-sm">
              Add money
            </a>
          )}
        </div>

        {/* One row per asset the sender can fund with. Tapping one changes
            which allowance is quoted below; the total above never changes.
            Every asset shows, held or not: a sender deciding whether to try
            pesos or USA₮ has to see they are on offer before holding any.
            Inside MiniPay only its own three (USDT, USDC, USDm) — its rules
            forbid offering any other token there.
            Seven tiles do not fit a phone, so the row scrolls sideways
            inside itself rather than widening the page. */}
        <div
          className="-mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
          role="tablist"
          aria-label="Asset"
        >
          {balances.filter(({ token: t }) => !inMiniPay || t.miniPayVisible).map(({ token: t, balance }) => {
            const on = t.symbol === token.symbol;
            return (
              <button
                key={t.symbol}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setToken(t)}
                className={`tile min-h-0 min-w-[5.5rem] flex-1 shrink-0 px-3 py-2.5 ${on ? "tile-on" : ""}`}
              >
                <span className={`block text-[12px] font-medium ${on ? "text-clay-deep" : "text-ink-3"}`}>
                  {t.symbol}
                </span>
                {balance === undefined ? (
                  <Skeleton className="mt-1 h-4 w-12" />
                ) : (
                  <span className="block text-[15px] font-medium text-ink">
                    {formatUnits(balance, t.decimals)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <ApprovalStrip token={token} />

      <IdentityCard />

      {/* Above the schedules: an unanswered request is the only thing on this
          screen waiting on the sender. Below the balance, because "can I
          afford this" is the first thing they will ask of it. */}
      <PaymentRequests />

      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h1 className="font-display text-[26px] text-ink">Schedules</h1>
          {hasSchedules && (
            <span className="text-[13px] text-ink-3">
              {schedules!.filter((s) => s.status === "active").length} active
            </span>
          )}
        </div>

        {error && (
          <div className="notice-danger mb-3">
            <p className="font-medium">Couldn&rsquo;t load your schedules</p>
            <p className="mt-0.5">{error.message}</p>
          </div>
        )}

        {isPending && !error ? (
          <ul className="space-y-3">
            {[0, 1].map((i) => (
              <li key={i} className="card flex items-center gap-4">
                <Skeleton className="h-11 w-11 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </li>
            ))}
          </ul>
        ) : !hasSchedules ? (
          <EmptyState />
        ) : (
          <ul className="stagger space-y-3">
            {schedules!.map((s) => (
              <ScheduleCard key={s.id} schedule={s} />
            ))}
          </ul>
        )}
      </section>

      <ActionBar>
        <Link href="/schedules/new" className="btn-primary flex-1">
          {hasSchedules ? "New schedule" : "Set up your first schedule"}
        </Link>
      </ActionBar>
    </div>
  );
}

/// The allowance, stated against the schedules that depend on it.
///
/// Three states, because one sentence cannot cover them honestly:
///   stuck    an active schedule cannot make even one payment — say so first,
///            and offer the fix here, since MiniPay has nowhere else to do it
///   unused   nothing draws on this asset and nothing is approved — one quiet line
///   covered  the ceiling, under a disclosure: a returning sender came to
///            check on a payment, not to re-read the security model
function ApprovalStrip({ token }: { token: TokenInfo }) {
  const { allowance, active, covers, stuck, low } = useApprovalCover(token);
  const n = active.length;
  const subject = n === 1 ? "Your schedule" : `${n} schedules`;

  if (stuck) {
    return (
      <div className="notice-warn mt-3">
        <p className="font-medium">
          {subject} paid in {token.symbol} can&rsquo;t run
        </p>
        <p className="mt-0.5">
          Remesso can&rsquo;t send any more of your {token.symbol}, so the next payment
          will be skipped. Allow it again to keep {n === 1 ? "it" : "them"} going.
        </p>
        <ReapproveButton token={token} label="Allow payments again" />
      </div>
    );
  }

  // Said with transfers left rather than after the first one is missed.
  if (low) {
    return (
      <div className="notice-info mt-3">
        <p className="font-medium text-ink">
          {covers === 1 ? "One more payment" : `${covers} more payments`} covered
        </p>
        <p className="mt-0.5">
          After that, Remesso can&rsquo;t send any more of your {token.symbol} until you
          allow it. Doing it now means nothing is missed.
        </p>
        <ReapproveButton token={token} label="Allow more payments" />
      </div>
    );
  }

  if (allowance === 0n && !n) {
    return (
      <p className="mt-3 flex min-h-11 items-center rounded-xl bg-sand/70 px-4 text-[13px] text-ink-2">
        No schedules are paid in {token.symbol}.
      </p>
    );
  }

  return (
    <details className="group mt-3 rounded-xl bg-sand/70">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-[13px] text-ink-2 [&::-webkit-details-marker]:hidden">
        <span>
          Remesso can move up to{" "}
          <span className="font-medium text-ink">
            {allowance !== undefined ? formatUnits(allowance, token.decimals) : "—"} {token.symbol}
          </span>{" "}
          in total
        </span>
        <span className="text-ink-3 transition group-open:rotate-180" aria-hidden>
          ▾
        </span>
      </summary>
      <p className="px-4 pb-3 text-[13px] leading-relaxed text-ink-2">
        That is the most Remesso can ever take from your {token.symbol}, across every
        schedule paid in it — the contract enforces the limit, not us.
        {covers !== undefined && n > 0 && ` Enough for ${covers} more ${covers === 1 ? "payment" : "payments"}.`}{" "}
        To stop a payment, pause or cancel its schedule.
      </p>
    </details>
  );
}

function ScheduleCard({ schedule }: { schedule: Schedule }) {
  const recipient = one(schedule.recipients);
  const isBank = recipient?.payout_type === "ngn_bank";
  const name = schedule.label || recipient?.display_name || "Remittance";
  const token = tokenFor(schedule.token_address);
  const quiet = schedule.status !== "active";

  return (
    <li>
      <Link
        href={`/schedules/${schedule.id}`}
        className={`card flex items-center gap-4 transition duration-200 ease-out hover:border-ink-3/60 active:scale-[0.99] ${
          quiet ? "bg-surface/60" : ""
        }`}
      >
        <Initial name={name} muted={quiet} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-[16px] font-medium text-ink">{name}</p>
            <SchedulePill status={schedule.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-ink-2">
            <Amount value={formatUnits(schedule.amount_in, token.decimals)} unit={token.symbol} size="sm" />
            <span className="text-ink-3">·</span>
            <span>{intervalLabel(schedule.interval_seconds).toLowerCase()}</span>
          </p>
          <p className="mt-0.5 truncate text-[13px] text-ink-3">
            {schedule.status === "active"
              ? `Next ${relativeTime(schedule.next_run_at)}`
              : isBank
                ? `${recipient?.account_name ?? "Bank account"} · ${recipient?.account_number ?? ""}`
                : recipientLabel(null, recipient?.wallet_address)}
          </p>
        </div>
      </Link>
    </li>
  );
}

/// A person, not a row. Initials in a warm disc do more for "this is Mum's
/// money" than any icon could.
function Initial({ name, muted }: { name: string; muted?: boolean }) {
  const letter = name.trim().charAt(0).toUpperCase() || "•";
  return (
    <span
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-xl ${
        muted ? "bg-sand text-ink-3" : "bg-clay-soft text-clay-deep"
      }`}
      aria-hidden
    >
      {letter}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-line px-5 py-8">
      <p className="font-display text-[22px] leading-tight text-ink">
        Nothing set up yet.
      </p>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        A schedule is one decision you make once: who, how much, how often. After you
        sign it, it runs by itself — and it can only ever do what you signed.
      </p>
      <ol className="mt-5 space-y-2.5 text-[14px] text-ink">
        {[
          "Pick the person and how they get paid",
          "Set the amount and the rhythm",
          "Sign once in your wallet",
        ].map((step, i) => (
          <li key={step} className="flex items-center gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sand text-[12px] font-semibold text-ink-2">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

const CURRENCY_NAME: Record<string, string> = {
  USD: "US dollars",
  ARS: "Argentine pesos",
  BRL: "Brazilian reais",
  COP: "Colombian pesos",
};

/// "a, b and c".
function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/// Seen only outside MiniPay, or for the moment before MiniPay auto-connects.
function Landing() {
  const miniPay = useMiniPayState();
  const { connect, connectors, isPending } = useConnect();
  const injected = connectors.find((c) => c.id === "injected");

  // What a browser wallet can send beyond MiniPay's three, read from the
  // contract's allowlist like the send form — so this line can never promise
  // a currency the contract would refuse, and USA₮ appears here the day it
  // is allowed without anyone editing copy.
  const beyondMiniPay = useAllowedDirectTokens().filter((t) => !t.miniPayVisible);
  const describe = (t: TokenInfo) => `${t.symbol} (${CURRENCY_NAME[t.currency] ?? t.currency})`;
  const fiat = beyondMiniPay.some((t) => t.currency !== "USD");
  const features: Array<[string, string]> = [
    ["You stay in control", "Nothing moves outside the amount, rhythm and person you signed."],
    ["They see it in MiniPay", "Paid in USDT, USDC or USDm — the balances MiniPay actually shows."],
    ...(beyondMiniPay.length
      ? [[
          "More currencies on the web",
          `With a browser wallet like MetaMask you can also send ${listOf(beyondMiniPay.map(describe))}` +
            (fiat ? ", bought and cashed out at a local bank through Ripio." : "."),
        ] as [string, string]]
      : []),
    ["Stop it any time", "Pause or cancel from your wallet. No calls, no forms."],
  ];

  return (
    <div className="stagger mt-6">
      <h1 className="font-display text-[40px] leading-[1.02] text-ink">
        Send money home,
        <br />
        <span className="text-clay">on a schedule.</span>
      </h1>
      <p className="mt-5 max-w-sm text-[16px] leading-relaxed text-ink-2">
        Decide once who gets what and how often. Sign it in your wallet, and it runs on its
        own — every week or every month, without you remembering.
      </p>

      <ul className="mt-8 divide-y divide-line/70 border-y border-line/70">
        {features.map(([title, body]) => (
          <li key={title} className="py-4">
            <p className="text-[15px] font-medium text-ink">{title}</p>
            <p className="mt-0.5 text-[14px] leading-relaxed text-ink-2">{body}</p>
          </li>
        ))}
      </ul>

      <div className="mt-8">
        {/* No button until we know this is not MiniPay — see ConnectBar. */}
        {miniPay !== false ? (
          <p className="text-[14px] text-ink-3">Connecting to your wallet…</p>
        ) : (
          <button
            className="btn-primary w-full"
            disabled={!injected || isPending}
            onClick={() => injected && connect({ connector: injected })}
          >
            {isPending ? "Connecting…" : injected ? "Connect wallet to begin" : "Open in MiniPay"}
          </button>
        )}
      </div>
    </div>
  );
}
