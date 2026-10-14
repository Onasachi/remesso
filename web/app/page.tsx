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
import { Notices } from "@/components/Notices";
import { Icon } from "@/components/Icon";
import { ripioRampUrl } from "@/lib/ripio";
import { TEXTILE_NAIRA_WITHDRAW, TEXTILE_SWAP_TO_CNGN } from "@/lib/textile";
import { ReapproveButton, useApprovalCover } from "@/components/Reapprove";
import { ActionBar, Amount, CopyValue, MINIPAY_DEPOSIT_URL, Skeleton } from "@/components/ui";
import { CNGN, isConfigured, tokenFor, USDT, type TokenInfo } from "@/lib/config";
import { flagOf, REGIONS, regionOf, type Region } from "@/lib/regions";
import { one, type Schedule } from "@/lib/types";

export default function SchedulesPage() {
  const { isConnected, address } = useAccount();
  const { data: schedules, isPending, error } = useSchedules();
  // Which asset the balance strip is showing. The total is always the sum;
  // the switcher only changes which per-asset figure and allowance appear.
  const [token, setToken] = useState<TokenInfo>(USDT);
  const [region, setRegion] = useState<Region>("usd");
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

        {/* Assets in three groups — Dollars, LatAm, Nigeria — one group on
            screen at a time, so eight tiles never crowd a 360px phone. Every
            asset shows, held or not: a sender deciding whether to try pesos
            has to see they are on offer before holding any. Inside MiniPay
            there are no tabs and only its own four dollars: its rules forbid
            offering any other token there. Tapping a tile changes which
            allowance and actions show below; the total never changes. */}
        {!inMiniPay && (
          <div className="seg mt-4 grid-cols-3" role="tablist" aria-label="Currency group">
            {REGIONS.map((r) => (
              <button
                key={r.key}
                type="button"
                role="tab"
                aria-selected={region === r.key}
                onClick={() => {
                  setRegion(r.key);
                  const first = balances.find((b) => regionOf(b.token) === r.key);
                  if (first) setToken(first.token);
                }}
                className={`seg-item ${region === r.key ? "seg-on" : ""}`}
              >
                {r.icon && <Icon name={r.icon} size={18} />}
                {r.flags && <span className="tracking-[-1px]">{r.flags}</span>}
                <span>{r.label}</span>
              </button>
            ))}
          </div>
        )}
        {(() => {
          const shown = balances.filter(({ token: t }) =>
            inMiniPay ? t.miniPayVisible : regionOf(t) === region,
          );
          return (
            <div
              className={`mt-2.5 grid gap-2 ${shown.length >= 4 ? "grid-cols-4" : "grid-cols-3"}`}
              role="tablist"
              aria-label="Asset"
            >
              {shown.map(({ token: t, balance }) => {
                const on = t.symbol === token.symbol;
                return (
                  <button
                    key={t.symbol}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setToken(t)}
                    className={`tile min-w-0 px-3 py-2.5 ${on ? "tile-on" : ""}`}
                  >
                    <span className={`flex items-center gap-1 text-[12px] font-medium ${on ? "text-clay-deep" : "text-ink-3"}`}>
                      {flagOf(t) && <span>{flagOf(t)}</span>}
                      <span className="truncate">{t.symbol}</span>
                    </span>
                    {balance === undefined ? (
                      <Skeleton className="mt-1 h-4 w-12" />
                    ) : (
                      <span className="block truncate text-[15px] font-medium text-ink">
                        {formatUnits(balance, t.decimals)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })()}
      </section>

      <ApprovalStrip token={token} />
      {/* Getting the selected local currency in and out — a sender who holds
          no pesos or cNGN gets them here, not halfway through the send form.
          Links only; never inside MiniPay, which shows none of these. */}
      {!inMiniPay && <LocalActions token={token} address={address} />}

      <IdentityCard />

      {/* Above the schedules: an unanswered request is the only thing on this
          screen waiting on the sender. Below the balance, because "can I
          afford this" is the first thing they will ask of it. */}
      <PaymentRequests />

      {/* The pre-flight agent's findings about upcoming payments. Allowance
          problems are left to ApprovalStrip above, so nothing is said twice. */}
      <Notices kinds={["balance_short", "rate_moved"]} />

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
                <Skeleton className="h-6 w-14 rounded-full" />
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
          <Icon name="add" />
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
/// Under the tiles when a local currency is selected: buy it and cash it out.
/// Pesos and reais through Ripio's hosted ramp, cNGN through Textile — both
/// links, done there from this wallet; Remesso never sees the bank side.
function LocalActions({ token, address }: { token: TokenInfo; address?: string }) {
  const ng = token.symbol === CNGN.symbol;
  const buy = ng ? TEXTILE_SWAP_TO_CNGN : ripioRampUrl("on", token, { address });
  // Ripio takes the wallet in the link, both ways; Textile cannot, so the
  // caption names the wallet to connect there, with a copy button.
  const out = ng ? TEXTILE_NAIRA_WITHDRAW : ripioRampUrl("off", token, { address });
  if (!buy || !out) return null;
  return (
    <>
      <div className="mt-2 flex items-center gap-2">
        <a href={buy} target="_blank" rel="noopener noreferrer" className="well-btn">
          <Icon name={ng ? "swap_horiz" : "add"} size={18} />
          {ng ? "Get cNGN" : `Buy ${token.symbol}`}
        </a>
        <a href={out} target="_blank" rel="noopener noreferrer" className="well-btn">
          <Icon name="account_balance" size={18} />
          {ng ? "Withdraw" : "Cash out"}
        </a>
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-[12px] text-ink-3">
        <Icon name="open_in_new" size={14} />
        {ng ? "Via Textile · about ₦1 per cNGN" : "Via Ripio · this wallet is filled in for you"}
      </p>
      {ng && address && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-sand/70 px-3 py-2 text-[12px] text-ink-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon name="account_balance_wallet" size={16} className="shrink-0 text-ink-3" />
            <span className="truncate">On Textile, connect this same wallet</span>
          </span>
          <CopyValue value={address} display={`${address.slice(0, 6)}…${address.slice(-4)}`} />
        </div>
      )}
    </>
  );
}

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
      <p className="mt-3 flex min-h-10 items-center gap-2 rounded-xl bg-sand/70 px-3 text-[13px] text-ink-2">
        <Icon name="event_busy" size={18} className="text-ink-3" />
        No schedules paid in {token.symbol}
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
    <div className="rounded-[20px] border border-dashed border-line px-5 py-6">
      <p className="font-display text-[22px] leading-tight text-ink">Nothing set up yet.</p>
      <p className="mt-1.5 text-[14px] text-ink-2">Set it once. It only does what you signed.</p>
      <ol className="mt-5 grid grid-cols-3 gap-2">
        {[
          ["person_add", "Pick who"],
          ["event_repeat", "Amount & rhythm"],
          ["draw", "Sign once"],
        ].map(([icon, label]) => (
          <li key={label} className="flex flex-col items-center gap-2 text-center text-[13px] text-ink">
            <span className="disc h-10 w-10">
              <Icon name={icon} />
            </span>
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}

/// Seen only outside MiniPay, or for the moment before MiniPay auto-connects.
function Landing() {
  const miniPay = useMiniPayState();
  const { connect, connectors, isPending } = useConnect();
  const injected = connectors.find((c) => c.id === "injected");

  // Both lists are read from the contract's allowlist like the send form, so
  // neither can promise a currency the contract would refuse — and a token
  // appears here the day it is allowed, without anyone editing copy.
  const allowed = useAllowedDirectTokens();
  const inMiniPay = allowed.filter((t) => t.miniPayVisible);
  const local = allowed.filter((t) => !t.miniPayVisible);

  return (
    <div className="stagger mt-6">
      <h1 className="font-display text-[40px] leading-[1.02] text-ink">
        Send money home,
        <br />
        <span className="text-clay">on a schedule.</span>
      </h1>
      <p className="mt-4 max-w-sm text-[16px] leading-relaxed text-ink-2">
        Set it once in your wallet. It runs every week or month on its own.
      </p>

      <div className="mt-7 grid grid-cols-2 gap-2">
        <Feature icon="shield_lock" title="You stay in control" body="Only what you signed moves." />
        <Feature icon="pause_circle" title="Stop any time" body="Pause or cancel. No forms." />
      </div>

      <div className="mt-2 rounded-2xl border border-line/70 bg-surface">
        <TokenRow icon="smartphone" tone="naira" title="Shows in MiniPay" tokens={inMiniPay} />
        {local.length > 0 && (
          <>
            <div className="mx-3.5 h-px bg-line/70" />
            <TokenRow icon="language" tone="clay" title="Local currencies on the web" tokens={local} />
          </>
        )}
      </div>

      <div className="mt-6">
        {/* No button until we know this is not MiniPay — see ConnectBar. */}
        {miniPay !== false ? (
          <p className="text-[14px] text-ink-3">Connecting to your wallet…</p>
        ) : (
          <button
            className="btn-primary w-full"
            disabled={!injected || isPending}
            onClick={() => injected && connect({ connector: injected })}
          >
            <Icon name="account_balance_wallet" />
            {isPending ? "Connecting…" : injected ? "Connect wallet to begin" : "Open in MiniPay"}
          </button>
        )}
      </div>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-line/70 bg-surface p-3.5">
      <span className="disc h-9 w-9">
        <Icon name={icon} />
      </span>
      <div>
        <p className="text-[14px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{body}</p>
      </div>
    </div>
  );
}

function TokenRow({
  icon,
  tone,
  title,
  tokens,
}: {
  icon: string;
  tone: "naira" | "clay";
  title: string;
  tokens: TokenInfo[];
}) {
  return (
    <div className="flex items-center gap-3 p-3.5">
      <span className={`disc h-9 w-9 ${tone === "naira" ? "bg-naira-soft text-naira" : ""}`}>
        <Icon name={icon} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {tokens.map((t) => (
            <span key={t.symbol} className="flex items-center gap-1 rounded-full bg-sand px-2 py-0.5 text-[12px] font-medium text-ink-2">
              {flagOf(t) && <span>{flagOf(t)}</span>}
              {t.symbol}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
