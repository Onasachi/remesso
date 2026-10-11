"use client";

import { useEffect, useState } from "react";
import { useMarketRate, useTriggerAddress } from "@/lib/hooks";
import {
  INTERVALS,
  SELECTABLE_INTERVALS,
  formatUnits,
  parseUnits,
  rateToNairaPerUsd,
} from "@/lib/format";
import { CNGN, type TokenInfo } from "@/lib/config";
import { transfersBeforeExpiry } from "@/lib/allowance";

export type TermsDraft = {
  amount: string;          // decimal USDT as typed
  intervalSeconds: number;
  floorPercent: number;    // how far below market the sender will accept
  maxRuns: string;         // "" = unlimited
  expiresAt: string;       // yyyy-mm-dd — required; V2 rejects a schedule with no expiry
  startNow: boolean;
  /// Who else may pull a transfer early, and how many times. Empty and "0" —
  /// the default — means only the cadence runs this schedule, exactly as V3
  /// behaved. See `runNow` in RemessoExecutorV4.
  trigger: string;
  triggersLeft: string;
};

/// yyyy-mm-dd, `days` from now.
function isoDate(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

/// The day the last transfer lands on, with an hour's margin — clamped to what
/// the contract allows (today at the earliest, 364 days at the latest).
///
/// The expiry is mandatory (V3 rejects a schedule without one) but it is not a
/// question a sender arrives with an answer to. They know who, how much, how
/// often and how many; the date those add up to is arithmetic, so the form
/// does it. Anyone who wants it to stop sooner can still change the field, and
/// from then on it stays theirs.
///
/// Measured in time rather than whole days, because "two transfers five
/// minutes apart, ending today" is a sentence senders actually write, and
/// rounding it up to two days contradicts them. The hour of margin is what
/// keeps a same-day schedule honest: a run fires on the tick after its due
/// time, not at a precise instant.
function expiryFor(t: Pick<TermsDraft, "intervalSeconds" | "maxRuns" | "startNow">): string {
  const runs = Number(t.maxRuns);
  // Open-ended: nothing to derive from, so it stays a year — the ceiling the
  // contract imposes anyway.
  if (!runs || !Number.isFinite(runs)) return isoDate(330);

  const spanMs = (t.startNow ? runs - 1 : runs) * t.intervalSeconds * 1000;
  const lastTransfer = Date.now() + spanMs + 3600_000;
  const max = Date.now() + 364 * 86400_000;
  return new Date(Math.min(lastTransfer, max)).toISOString().slice(0, 10);
}

export const defaultTerms: TermsDraft = {
  amount: "",
  intervalSeconds: INTERVALS.find((i) => i.label === "Monthly")!.seconds,
  floorPercent: 3,
  maxRuns: "12",
  // V2 requires every schedule to expire, capped at MAX_LIFETIME (365 days).
  // A floor rate that never has to be re-consented is the stale-floor defect
  // the security review found, so "never" is no longer offered.
  expiresAt: expiryFor({ intervalSeconds: INTERVALS.find((i) => i.label === "Monthly")!.seconds, maxRuns: "12", startNow: true }),
  startNow: true,
  trigger: "",
  triggersLeft: "0",
};

/// Why this expiry cannot be signed, or null.
///
/// The date field can be typed into, so the picker's own min and max are a
/// hint rather than a rule, and each of these ends badly *after* the sender
/// has already paid for an approval: the contract reverts a date that has
/// passed (`ScheduleExpired`) or one beyond a year (`ScheduleLifetimeTooLong`),
/// and a schedule whose first transfer falls after its expiry is created,
/// charged for, and then never runs.
export function expiryProblem(terms: TermsDraft): string | null {
  if (!terms.expiresAt) return "Choose an end date to continue";

  // Matches what is sent on-chain: the end of that day, UTC.
  const expiry = Date.parse(`${terms.expiresAt}T23:59:59Z`);
  if (Number.isNaN(expiry)) return "That end date isn't a real date";

  const now = Date.now();
  if (expiry <= now) return "That date has already passed — pick a later one";
  if (expiry > now + 365 * 86400_000) return "A schedule can run for a year at most";

  // `startNow` fires the first transfer immediately; otherwise the contract
  // waits one full interval before the first one.
  const firstTransfer = terms.startNow ? now : now + terms.intervalSeconds * 1000;
  if (expiry <= firstTransfer) {
    return terms.startNow
      ? "That date is too soon for a transfer to go through"
      : "It ends before the first transfer — pick a later date, or send the first one now";
  }
  return null;
}

/// Why this trigger grant cannot be signed, or null.
///
/// Set by the "Let this be sent early" switch, which fills in our own
/// executor's address so a sender never handles one. The address field behind
/// "use a different address" is for someone pointing at their own agent.
///
/// A grant is a pull on the sender's wallet. It is bounded — one transfer, to
/// the destination they fixed, at most `triggersLeft` times, no more than once
/// a minute, revocable — but it is still an authority handed to someone else,
/// so it is validated here rather than discovered as a revert.
export function triggerProblem(t: TermsDraft): string | null {
  const granted = t.trigger.trim();
  const count = Number(t.triggersLeft);

  if (!granted) {
    return count > 0 ? "Enter the agent's address, or set pulls to none" : null;
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(granted)) return "That agent address isn't valid";
  if (!Number.isInteger(count) || count < 0 || count > 65535) {
    return "Pulls must be a whole number, up to 65535";
  }
  if (count === 0) return "Set how many transfers the agent may pull, or clear its address";
  return null;
}

/// Parsed at the funding token's own scale — USDm is 18dp while USDT and USDC
/// are 6dp, so a fixed 6 would be wrong by 10^12 for a third of the assets.
export function amountInUnits(t: TermsDraft, decimals: number): bigint | null {
  try {
    const v = parseUnits(t.amount, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/// Amounts a sender can tap instead of type. Small on purpose: this audience
/// sends tens of dollars, not hundreds, and the field is right there.
const QUICK_AMOUNTS = ["10", "20", "50", "100"];
const QUICK_COUNTS = ["6", "12", ""];

export function TermsStep({
  value,
  onChange,
  token,
  converts,
}: {
  value: TermsDraft;
  onChange: (t: TermsDraft) => void;
  token: TokenInfo;
  /// Direct schedules move the asset untouched, so there is no rate, no floor
  /// and nothing to quote.
  converts: boolean;
}) {
  const set = (patch: Partial<TermsDraft>) => onChange({ ...value, ...patch });
  const amount = amountInUnits(value, token.decimals);
  // Whether the count is being typed rather than tapped. Without this, typing
  // "6" on the way to "60" would light the 6 chip and empty the field.
  const [customCount, setCustomCount] = useState(!QUICK_COUNTS.includes(value.maxRuns));
  // Until the sender edits the date themselves, it follows their answers. After
  // that it is theirs and nothing here moves it.
  const [dateIsTheirs, setDateIsTheirs] = useState(false);
  const market = useMarketRate(converts ? (amount ?? 0n) : 0n);

  // A typed date can be anything at all, so it is checked where it is typed —
  // the same check that stops the sender reaching the wallet with it.
  const problem = expiryProblem(value);

  const derived = expiryFor(value);
  useEffect(() => {
    if (!dateIsTheirs && value.expiresAt !== derived) onChange({ ...value, expiresAt: derived });
    // `value` and `onChange` are deliberately absent: this reacts to the three
    // answers the date is derived from, not to every keystroke in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, dateIsTheirs]);

  const floorE6 = market.rateE6
    ? (market.rateE6 * BigInt(100 - value.floorPercent)) / 100n
    : undefined;

  return (
    <div className="space-y-7">
      {/* The amount is the headline of the whole screen, so it is set like one:
          large, borderless, unit beside it, nothing competing. */}
      <div>
        <label className="label" htmlFor="amount">
          Amount per transfer
        </label>
        <div className="flex items-baseline gap-2 border-b-2 border-line pb-2 transition-colors focus-within:border-clay">
          <input
            id="amount"
            className="min-w-0 flex-1 bg-transparent font-display text-[44px] leading-none text-ink outline-none placeholder:text-ink-3/50"
            inputMode="decimal"
            placeholder="0"
            autoComplete="off"
            value={value.amount}
            onChange={(e) => set({ amount: e.target.value.replace(/[^0-9.]/g, "") })}
          />
          <span className="text-lg font-medium text-ink-3">{token.symbol}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {QUICK_AMOUNTS.map((q) => (
            <button
              key={q}
              type="button"
              className={`chip ${value.amount === q ? "border-clay bg-clay-soft text-clay-deep" : ""}`}
              onClick={() => set({ amount: q })}
            >
              {q}
            </button>
          ))}
        </div>
        {converts && market.rateE6 && amount ? (
          <p className="hint">
            About{" "}
            <span className="font-medium text-naira">
              ₦{formatUnits((amount * market.rateE6) / 1_000_000n, CNGN.decimals, 0)}
            </span>{" "}
            at today&rsquo;s rate of ₦{rateToNairaPerUsd(market.rateE6).toFixed(2)} per USDT.
          </p>
        ) : null}
      </div>

      <div>
        <p className="label">How often</p>
        <div className="grid grid-cols-2 gap-2">
          {SELECTABLE_INTERVALS.map((i) => (
            <button
              key={i.seconds}
              type="button"
              onClick={() => set({ intervalSeconds: i.seconds })}
              aria-pressed={value.intervalSeconds === i.seconds}
              className={`tile min-h-12 text-center text-[15px] font-medium ${
                value.intervalSeconds === i.seconds ? "tile-on" : ""
              }`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>

      {converts && (
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label mb-0" htmlFor="floor">
              Rate floor
            </label>
            {floorE6 !== undefined && (
              <span className="text-[15px] font-medium text-ink">
                ₦{rateToNairaPerUsd(floorE6).toFixed(0)}
                <span className="text-ink-3"> / USDT</span>
              </span>
            )}
          </div>
          <input
            id="floor"
            type="range"
            min={1}
            max={10}
            step={1}
            className="mt-3 w-full accent-clay"
            value={value.floorPercent}
            onChange={(e) => set({ floorPercent: Number(e.target.value) })}
          />
          <p className="mt-1 text-[14px] text-ink-2">
            Skip a run if the rate drops more than{" "}
            <span className="font-medium text-ink">{value.floorPercent}%</span> below today.
          </p>
          {/* This is the single most important number a sender sets, so it says
              plainly what it protects them from. */}
          <p className="hint">
            Written into the contract. Nobody — not Remesso, not a stolen backend key — can
            run a transfer below this rate. Tighter means fewer bad transfers and more
            skipped months.
          </p>
        </div>
      )}

      <div>
        <p className="label">How many transfers</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_COUNTS.map((n) => (
            <button
              key={n || "open"}
              type="button"
              className={`chip ${!customCount && value.maxRuns === n ? "border-clay bg-clay-soft text-clay-deep" : ""}`}
              onClick={() => {
                setCustomCount(false);
                set({ maxRuns: n });
              }}
            >
              {n || "Until I stop it"}
            </button>
          ))}
          <input
            className={`field min-h-9 w-24 rounded-full px-3.5 py-0 text-[13px] ${
              customCount ? "border-clay bg-clay-soft text-clay-deep" : ""
            }`}
            inputMode="numeric"
            placeholder="Other"
            aria-label="Number of transfers"
            value={customCount ? value.maxRuns : ""}
            onFocus={() => {
              setCustomCount(true);
              set({ maxRuns: "" });
            }}
            onChange={(e) => set({ maxRuns: e.target.value.replace(/\D/g, "") })}
          />
        </div>
        <CountVsExpiry value={value} set={set} />
      </div>

      <div>
        <label className="label" htmlFor="expires">
          Expires on
        </label>
        <input
          id="expires"
          type="date"
          value={value.expiresAt}
          min={isoDate(1)}
          max={isoDate(364)}
          className={`field ${problem ? "field-invalid" : ""}`}
          onChange={(e) => {
            setDateIsTheirs(true);
            set({ expiresAt: e.target.value });
          }}
        />
        {problem && <p className="mt-2 text-[13px] text-danger">{problem}</p>}
        <p className="hint">
          {dateIsTheirs || !Number(value.maxRuns)
            ? "Up to a year."
            : `Set from your ${value.maxRuns} ${
              Number(value.maxRuns) === 1 ? "transfer" : "transfers"
            } — the day the last one lands. Change it to end sooner.`}{" "}
          Your {converts ? "floor rate is" : "terms are"} fixed for the life of the
          schedule, so it has to be re-confirmed rather than drift against the market
          forever.
        </p>
      </div>

      <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3.5">
        <span className="text-[15px] text-ink">
          Send the first one now
          <span className="mt-0.5 block text-[13px] text-ink-2">
            Otherwise the first transfer waits one full interval.
          </span>
        </span>
        <Switch checked={value.startNow} onChange={(v) => set({ startNow: v })} />
      </label>

      <EarlySending value={value} set={set} />
    </div>
  );
}

/// "Let this be sent early" — the grant that makes a schedule callable.
///
/// This is the control that turns a schedule from something only the clock can
/// move into something a sender's app or assistant can act on. It was an
/// address field and a count once, which asked an audience that found the word
/// "approve" hard to paste a hex string and pick a number. Now it is a switch:
/// on means our executor, for as many transfers as the schedule has.
///
/// What the switch does NOT do is worth being exact about, because a sender
/// reading "let something else send this" deserves to know the shape of what
/// they are handing over. `runNow` sends ONE transfer, of the amount they
/// fixed, to the person they fixed, and consumes a scheduled payment rather
/// than adding one — so the total can never exceed what they signed for. It
/// cannot repeat within 60 seconds, cannot outlive the expiry, and can be
/// withdrawn at any moment. The grant buys timing; it buys nothing else.
function EarlySending({
  value,
  set,
}: {
  value: TermsDraft;
  set: (patch: Partial<TermsDraft>) => void;
}) {
  const { data: trigger } = useTriggerAddress();
  const [custom, setCustom] = useState(false);

  // As many as the schedule has. An open-ended schedule gets the contract's
  // own ceiling: `triggersLeft` is a uint16, and each pull still consumes a
  // scheduled payment, so this is "any of them", not "more of them".
  const grantCount = () => String(Number(value.maxRuns) || 65535);

  const on = Boolean(value.trigger);
  const mine = trigger && value.trigger.toLowerCase() === trigger.toLowerCase();

  function toggle(next: boolean) {
    if (!next) return set({ trigger: "", triggersLeft: "0" });
    if (!trigger) return; // address not read yet; the switch stays off
    set({ trigger, triggersLeft: grantCount() });
  }

  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <label className="flex items-center justify-between gap-4">
        <span className="text-[15px] text-ink">
          Let this be sent early
          <span className="mt-0.5 block text-[13px] text-ink-2">
            Something you authorise — an app, an assistant — can bring a transfer
            forward. It still goes to the same person, for the same amount, and
            stops when you say.
          </span>
        </span>
        <Switch checked={on} onChange={toggle} />
      </label>

      {on && (
        <p className="hint mt-3">
          {mine && !custom
            ? "Remesso can bring a transfer forward on your behalf. Nothing else can."
            : "That address can bring a transfer forward. Nothing else can."}{" "}
          You can withdraw this at any time from the schedule.
        </p>
      )}

      {/* Behind a disclosure because almost nobody wants it, and the ones who
          do are pointing at an agent they run themselves. */}
      {on && (
        <>
          {!custom && (
            <button
              type="button"
              className="mt-2 text-[13px] text-ink-2 underline underline-offset-2"
              onClick={() => setCustom(true)}
            >
              Use a different address
            </button>
          )}
          {custom && (
            <div className="mt-3 space-y-2">
              <input
                className="field"
                placeholder="0x… the address you are allowing"
                autoComplete="off"
                spellCheck={false}
                value={value.trigger}
                onChange={(e) => set({ trigger: e.target.value.trim() })}
              />
              <input
                className="field"
                inputMode="numeric"
                placeholder="How many transfers it may bring forward"
                value={value.triggersLeft === "0" ? "" : value.triggersLeft}
                onChange={(e) => set({ triggersLeft: e.target.value.replace(/\D/g, "") })}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/// A switch that looks like the one in the phone's own settings, which is the
/// control this audience already knows how to read.
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 ${
        checked ? "bg-clay" : "bg-line"
      }`}
    >
      <span
        className={`absolute left-0 top-0.5 h-6 w-6 rounded-full bg-surface shadow-card transition-transform duration-200 ease-out ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/// The transfer count and the expiry date are separate answers that can
/// contradict each other, and the contract enforces both — it stops at
/// whichever comes first. Choosing fewer transfers than fit is a real choice
/// and stays silent; choosing more than can happen is not, so it is said here
/// rather than discovered when the payments stop.
function CountVsExpiry({
  value,
  set,
}: {
  value: TermsDraft;
  set: (patch: Partial<TermsDraft>) => void;
}) {
  const wanted = Number(value.maxRuns);
  if (!wanted) return null;

  const fits = transfersBeforeExpiry({
    intervalSeconds: value.intervalSeconds,
    expiresAtMs: value.expiresAt ? Date.parse(`${value.expiresAt}T23:59:59`) : null,
    startNow: value.startNow,
  });
  if (fits === null || wanted <= fits) return null;

  const expiry = new Date(`${value.expiresAt}T12:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="notice-warn mt-3">
      {fits === 0
        ? `None of these fit before ${expiry}.`
        : `Only ${fits} of these fit before ${expiry} — the rest would never be sent.`}{" "}
      A schedule can last a year at most, so move the date out or send fewer.
      {fits > 0 && (
        <button
          type="button"
          className="btn-soft btn-sm mt-2 block bg-surface"
          onClick={() => set({ maxRuns: String(fits) })}
        >
          Send {fits} instead
        </button>
      )}
    </div>
  );
}
