"use client";

import { useState } from "react";
import { parseSchedule, type Draft } from "@/lib/ai";
import { CNGN_RAILS_ENABLED, DIRECT_TOKENS } from "@/lib/config";
import { TEST_INTERVALS_ENABLED } from "@/lib/format";
import { findPhone } from "@/lib/phone";
import { Icon } from "./Icon";

/// Type the remittance in a sentence; the assistant fills the form in.
///
/// It fills the form and stops there. Nothing is submitted, nothing is signed,
/// and every field it sets is one the sender can see and change on the next two
/// screens. Anything it could not read with certainty — an address that was not
/// a complete 0x..., an asset we do not support — is left blank and named in
/// `missing`, because a plausible guess in a payment form is worse than a gap.

/// Phrasings the parser reliably understands, offered as taps.
///
/// A sender should not have to discover that "every week" parses and "weekly-ish"
/// does not. These are appended to whatever they already wrote, so the sentence
/// stays theirs and only the part the parser could not read gets filled in.
const FREQUENCY_WORDS = [
  ...(TEST_INTERVALS_ENABLED ? [{ label: "Every 5 minutes", words: "every 5 minutes" }] : []),
  { label: "Every week", words: "every week" },
  { label: "Every month", words: "every month" },
];

const COUNT_WORDS = [
  { label: "Just once", words: "one transfer only" },
  { label: "6 times", words: "for 6 transfers" },
  { label: "Until I stop", words: "until I stop it" },
];

/// Shown before anything is typed, to teach the shape of a sentence that works.
/// The chip says it short; a tap puts the whole sentence in the box.
const STARTERS = [
  { icon: "view_week", label: "5 USDT · weekly · 8×", text: "Send 5 USDT to 0x… every week for 8 transfers" },
  { icon: "calendar_month", label: "20 USDC · monthly", text: "Send 20 USDC to 0x… every month" },
];

/// Inside MiniPay a recipient is a phone number — addresses are neither typed
/// nor shown there — so the examples teach that shape instead.
const PHONE_STARTERS = [
  { icon: "view_week", label: "5 USDT · weekly · 8×", text: "Send 5 USDT to +234 803 123 4567 every week for 8 transfers" },
  { icon: "calendar_month", label: "20 USDC · monthly", text: "Send 20 USDC to +234 803 123 4567 every month" },
];

export function DescribeSchedule({
  onDraft,
  phoneMode = false,
}: {
  /// `phone` is the number as written in the sentence, found by us rather
  /// than the model; the form resolves it to a MiniPay wallet.
  onDraft: (d: Draft, phone: string | null) => void;
  /// MiniPay: recipients are phone numbers, never addresses.
  phoneMode?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [unsure, setUnsure] = useState<string[]>([]);
  const [openEnded, setOpenEnded] = useState(false);
  const [filled, setFilled] = useState(false);

  /// Append a phrase the parser understands and read the sentence again, so the
  /// sender never has to learn the wording.
  function addWords(words: string) {
    const next = `${text.trim()} ${words}`.trim();
    setText(next);
    run(next);
  }

  async function run(override?: string) {
    const t = (override ?? text).trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setMissing([]);
    setUnsure([]);
    setOpenEnded(false);
    setFilled(false);
    try {
      // The number is cut out before the sentence leaves the browser: the
      // model needs to know a recipient was named, not who. It also keeps
      // eleven digits from being read as an amount.
      const phone = phoneMode ? findPhone(t) : null;
      const r = await parseSchedule(phone ? phone.redacted : t);
      onDraft(phoneMode ? { ...r.draft, destination: null } : r.draft, phone?.raw ?? null);
      setNote(r.note);
      setMissing(
        phoneMode
          ? r.missing.flatMap((m) => (m !== "recipient address" ? [m] : phone ? [] : ["phone number"]))
          : r.missing,
      );
      setUnsure(r.unsure ?? []);
      // Not "missing" — running until stopped is a real choice. But a sender who
      // simply did not say should be shown that the choice exists, rather than
      // discovering later that it renews indefinitely.
      setOpenEnded(r.missing.length === 0 && r.draft.maxRuns === null);
      setFilled(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const visibleUnsure = CNGN_RAILS_ENABLED
    ? unsure
    : unsure.filter((u) => u !== "payout to a bank account");

  return (
    <div className="mb-6 rounded-[20px] bg-sand/70 p-3">
      <div className="flex items-center gap-2.5 rounded-xl border border-line bg-surface py-1.5 pl-3 pr-1.5 transition focus-within:border-clay focus-within:ring-4 focus-within:ring-clay/15">
        <Icon name="auto_awesome" className="text-clay" />
        <label htmlFor="describe" className="sr-only">
          Or just say it
        </label>
        <input
          id="describe"
          className="min-w-0 flex-1 bg-transparent py-2 text-[14px] text-ink outline-none placeholder:text-ink-3"
          value={text}
          placeholder="Or just say it…"
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setFilled(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
        />
        <button
          type="button"
          aria-label="Fill in the form"
          disabled={busy || !text.trim()}
          onClick={() => run()}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-paper transition ${
            text.trim() ? "bg-ink hover:bg-ink/90" : "bg-line"
          }`}
        >
          {busy ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-paper/30 border-t-paper" aria-hidden />
          ) : (
            <Icon name="arrow_upward" />
          )}
        </button>
      </div>

      {!text.trim() && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(phoneMode ? PHONE_STARTERS : STARTERS).map((example) => (
            <button
              key={example.label}
              type="button"
              className="flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3 text-[12px] text-ink-2 transition hover:border-ink-3 hover:text-ink"
              onClick={() => setText(example.text)}
            >
              <Icon name={example.icon} size={14} />
              {example.label}
            </button>
          ))}
        </div>
      )}

      {busy && (
        <p className="mx-1 mt-2.5 animate-pulse2 text-[12px] text-clay-deep">Reading your sentence…</p>
      )}
      {filled && !busy && !error && (
        <p className="mx-1 mt-2.5 flex items-center gap-1.5 text-[12px] text-naira">
          <Icon name="check_circle" size={15} fill />
          Filled in below. Check it, then continue.
        </p>
      )}

      {note && <p className="mx-1 mt-2 text-[13px] leading-relaxed text-ink-2">{note}</p>}

      {/* Read one way by the parser, plausibly another way by a reader. Saying
          so is the point: the form below is already filled in, and a sender
          who skims it will sign whatever was guessed. */}
      {/* Asked for a bank payout while the naira rails are off. Saying "check
          this" would send them looking for an option that is not there. */}
      {!CNGN_RAILS_ENABLED && unsure.includes("payout to a bank account") && (
        <div className="notice-info mt-3 animate-rise">
          <p>
            Paying into a naira bank account isn&rsquo;t available yet. This will go to
            their wallet as a stablecoin instead.
          </p>
        </div>
      )}

      {visibleUnsure.length > 0 && (
        <div className="notice-warn mt-3 animate-rise">
          <p>
            Worth checking before you sign: {visibleUnsure.join(", ")}. The form below has what
            we read — change anything that isn&rsquo;t right.
          </p>
        </div>
      )}

      {openEnded && (
        <div className="notice-info mt-3 animate-rise">
          <p>This will keep going until you stop it.</p>
          <Chips label="Limit it?" options={COUNT_WORDS} onPick={addWords} disabled={busy} />
        </div>
      )}

      {missing.length > 0 && (
        <div className="notice-warn mt-3 animate-rise">
          <p>Still needed: {missing.join(", ")}.</p>

          {/* Only frequency and count can be added by tapping. An amount and an
              address are specific to this payment — there is nothing sensible to
              offer, and a tappable address is a way to send money to the wrong
              person by accident. */}
          {missing.includes("frequency") && (
            <Chips
              label="How often?"
              options={FREQUENCY_WORDS}
              onPick={addWords}
              disabled={busy}
            />
          )}

          {(missing.includes("amount") || missing.includes("recipient address") || missing.includes("phone number")) && (
            <p className="mt-2 text-ink-2">
              Add the {[
                missing.includes("amount") ? "amount" : null,
                missing.includes("recipient address") ? "address" : null,
                missing.includes("phone number") ? "phone number" : null,
              ].filter(Boolean).join(" and ")} to the sentence, or type it into the form below.
            </p>
          )}
        </div>
      )}

      {error && <p className="notice-danger mt-3">{error}</p>}

      <p className="mx-1 mt-2 flex items-center gap-1.5 text-[12px] text-ink-3">
        <Icon name="edit_note" size={14} />
        Only fills the form. You sign.
      </p>
    </div>
  );
}

function Chips({
  label,
  options,
  onPick,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<{ label: string; words: string }>;
  onPick: (words: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2">
      <span className="text-ink-2">{label}</span>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.words}
            type="button"
            disabled={disabled}
            className="chip bg-surface"
            onClick={() => onPick(o.words)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/// Map a draft's token symbol onto the real TokenInfo. The assistant returns a
/// symbol rather than an address on purpose: an address is the one field where
/// a confident-sounding mistake is irreversible, so the browser resolves it
/// from a list it already trusts.
export function tokenFromSymbol(symbol: Draft["token"]) {
  // The assistant answers in ASCII ("USAT"); the token is named "USA₮".
  return DIRECT_TOKENS.find((t) => t.symbol.replace("₮", "T") === symbol) ?? null;
}
