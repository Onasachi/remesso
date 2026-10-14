"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAddress } from "viem";
import { fetchBanks, verifyAccount, type AccountDetails } from "@/lib/api";
import { BANK_PAYOUTS_ENABLED, CNGN_RAILS_ENABLED, DIRECT_TOKENS, type TokenInfo } from "@/lib/config";
import { isMiniPay } from "@/lib/wagmi";
import { useAllowedDirectTokens, useIsMiniPay } from "@/lib/hooks";
import { lookupPhone } from "@/lib/phoneLookup";
import { countryOf, countryOptions, toE164, type CountryCode } from "@/lib/phone";
import { TEXTILE_NAIRA_WITHDRAW, TEXTILE_SWAP_TO_CNGN, textileNairaCashOut } from "@/lib/textile";
import { ripioRampUrl } from "@/lib/ripio";
import { countryOf as tokenCountry, flagOf, REGIONS, regionOf } from "@/lib/regions";
import { Icon } from "./Icon";
import { useAccount } from "wagmi";
import type { PayoutKind } from "@/lib/types";

export type RecipientDraft = {
  displayName: string;
  payoutType: PayoutKind;
  walletAddress: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  /// Direct rail only: which stablecoin the recipient actually receives.
  token: TokenInfo;
  /// Set when the wallet came from a phone number (MiniPay): the masked
  /// number the sender recognises, shown and saved in place of the address.
  phoneMasked: string;
  /// What is in the phone box — typed, or taken from the "say it" sentence.
  phoneTyped: string;
  /// Bumped when a number arrives from the sentence, so the field looks it
  /// up once. Never on keystrokes: a number is valid E.164 several digits
  /// before it is finished, and each lookup spends paid quota.
  phoneAutoFind: number;
  /// The recipient's country, for numbers typed the local way ("0706…").
  phoneCountry: CountryCode;
  /// Picked from MiniPay's own contact list: MiniPay resolved the wallet, so
  /// there is no number to show — only the contact's name.
  fromContact: boolean;
};

export const emptyRecipient: RecipientDraft = {
  displayName: "",
  payoutType: "direct",
  walletAddress: "",
  bankCode: "",
  accountNumber: "",
  accountName: "",
  token: DIRECT_TOKENS[0], // USDT — the one every MiniPay user already holds
  phoneMasked: "",
  phoneTyped: "",
  phoneAutoFind: 0,
  phoneCountry: "NG",
  fromContact: false,
};

export function recipientIsComplete(r: RecipientDraft): boolean {
  if (!r.displayName.trim()) return false;
  if (r.payoutType === "ngn_bank") {
    return Boolean(r.bankCode && /^[0-9]{10}$/.test(r.accountNumber) && r.accountName);
  }
  return isAddress(r.walletAddress);
}

export function RecipientStep({
  value,
  onChange,
}: {
  value: RecipientDraft;
  onChange: (r: RecipientDraft) => void;
}) {
  const inMiniPay = useIsMiniPay();
  // MiniPay lists only USDT, USDC, USDm and USA₮, and its rules forbid offering
  // anything else inside it. USA₮ and the wFIAT stay on offer everywhere else.
  const allowed = useAllowedDirectTokens().filter((t) => !inMiniPay || t.miniPayVisible);
  const { address: sender } = useAccount();
  const set = (patch: Partial<RecipientDraft>) => onChange({ ...value, ...patch });
  const addressInvalid = Boolean(value.walletAddress) && !isAddress(value.walletAddress);

  return (
    <div className="space-y-6">
      <div>
        <label className="label" htmlFor="recipient-name">
          Who is this for?
        </label>
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-4 transition focus-within:border-clay focus-within:ring-4 focus-within:ring-clay/15">
          <Icon name="person" className="text-ink-3" />
          <input
            id="recipient-name"
            className="min-w-0 flex-1 bg-transparent py-3 text-[15px] text-ink outline-none placeholder:text-ink-3"
            placeholder="Mum"
            autoComplete="off"
            value={value.displayName}
            onChange={(e) => set({ displayName: e.target.value })}
          />
        </div>
      </div>

      <div>
        {/* With the naira rails off there is one way to be paid, and a picker
            with a single option is a question that answers itself. The token
            tiles below are the only choice left, so they carry the heading. */}
        {CNGN_RAILS_ENABLED && (
          <>
            <p className="label">How should they receive it?</p>
            <div className="grid grid-cols-3 gap-2">
              <Choice
                active={value.payoutType === "direct"}
                onClick={() => set({ payoutType: "direct" })}
                title="Stablecoin"
                subtitle="Shows in MiniPay"
              />
              <Choice
                active={value.payoutType === "wallet"}
                onClick={() => set({ payoutType: "wallet" })}
                title="cNGN"
                subtitle="Other wallets"
              />
              <Choice
                active={value.payoutType === "ngn_bank"}
                onClick={() => BANK_PAYOUTS_ENABLED && set({ payoutType: "ngn_bank" })}
                disabled={!BANK_PAYOUTS_ENABLED}
                title="Bank"
                subtitle={BANK_PAYOUTS_ENABLED ? "Naira account" : "Coming soon"}
              />
            </div>
          </>
        )}

        {value.payoutType === "direct" && (
          <div className={CNGN_RAILS_ENABLED ? "mt-4" : ""}>
            <p className="mb-3 text-sm font-medium text-ink">What should they receive?</p>
            {/* Grouped the way people think about it — dollars, then local
                money by country — and each group says whether MiniPay shows
                it, which is the question that decides whether the recipient
                sees the payment at all. Only what the contract allows. */}
            {REGIONS.map((r) => {
              const tokens = allowed.filter((t) => regionOf(t) === r.key);
              if (!tokens.length) return null;
              const usd = r.key === "usd";
              return (
                <div key={r.key} className={usd ? "" : "mt-4"}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="eyebrow flex items-center gap-1.5">
                      <Icon name={usd ? "paid" : "public"} size={15} />
                      {r.long}
                    </span>
                    {usd ? (
                      <span className="flex items-center gap-1 text-[12px] font-medium text-naira">
                        <Icon name="smartphone" size={15} fill />
                        In MiniPay
                      </span>
                    ) : (
                      r.key === "latam" && (
                        <span className="flex items-center gap-1 text-[12px] text-ink-3">
                          <Icon name="visibility_off" size={15} />
                          Not in MiniPay
                        </span>
                      )
                    )}
                  </div>
                  <div className={`grid gap-2 ${usd ? "grid-cols-4" : "grid-cols-3"}`}>
                    {tokens.map((t) => {
                      const on = value.token.symbol === t.symbol;
                      return usd ? (
                        <button
                          key={t.symbol}
                          type="button"
                          onClick={() => set({ token: t })}
                          className={`tile min-h-11 px-1 text-center text-[15px] font-medium ${on ? "tile-on" : ""}`}
                          aria-pressed={on}
                        >
                          {t.symbol}
                        </button>
                      ) : (
                        <button
                          key={t.symbol}
                          type="button"
                          onClick={() => set({ token: t })}
                          className={`tile flex min-w-0 items-center gap-2 px-2.5 py-2 ${on ? "tile-on" : ""}`}
                          aria-pressed={on}
                        >
                          <span className="text-[18px] leading-none">{flagOf(t)}</span>
                          <span className="flex min-w-0 flex-col">
                            <span className="text-[15px] font-medium text-ink">{t.symbol}</span>
                            <span className={`truncate text-[11px] ${on ? "text-clay-deep" : "text-ink-3"}`}>
                              {tokenCountry(t)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {value.token.miniPayVisible ? (
              <>
                <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
                  <Icon name="check_circle" size={18} fill className="text-naira" />
                  Arrives in their MiniPay as {value.token.symbol}
                </p>
                {/* Naira in a bank, for a Nigerian recipient of USDT: theirs
                    to do on Textile (lib/textile.ts). Not inside MiniPay,
                    which has its own cash-out. */}
                {!inMiniPay && textileNairaCashOut(value.token) && (
                  <a
                    href={textileNairaCashOut(value.token)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12px] text-ink-2 transition hover:border-ink-3 hover:text-ink"
                  >
                    <span>🇳🇬</span>
                    Naira to a bank? They cash out on Textile
                    <Icon name="open_in_new" size={14} />
                  </a>
                )}
              </>
            ) : (
              // MiniPay shows none of the local-currency tokens and cannot add
              // one, so a recipient there would see nothing arrive.
              <>
                <p className="mt-3 flex items-center gap-2 rounded-xl bg-amber-soft px-3 py-2.5 text-[13px] text-ink">
                  <Icon name="visibility_off" size={18} className="shrink-0 text-amber" />
                  MiniPay won&rsquo;t show {value.token.symbol}. They need another wallet.
                </p>
                <VenueLinks token={value.token} sender={sender} />
              </>
            )}
          </div>
        )}

        {/* The honest reason the cNGN option is second, not first. */}
        {value.payoutType === "wallet" && (
          <p className="notice-warn mt-3">
            MiniPay only shows USDT, USDC, USDm and USA₮. Someone paid in cNGN will see nothing
            in MiniPay, and it has no way to add a token. Choose Stablecoin unless they use
            a different wallet.
          </p>
        )}
      </div>

      {value.payoutType !== "ngn_bank" && inMiniPay ? (
        <PhoneField value={value} set={set} sender={sender} />
      ) : value.payoutType !== "ngn_bank" ? (
        <div>
          <label className="label" htmlFor="recipient-address">
            Their wallet address
          </label>
          <div className="relative">
            <input
              id="recipient-address"
              className={`field mono pr-20 ${addressInvalid ? "field-invalid" : ""}`}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              inputMode="text"
              value={value.walletAddress}
              onChange={(e) => set({ walletAddress: e.target.value.trim() })}
              aria-invalid={addressInvalid}
            />
            <PasteButton onPaste={(t) => set({ walletAddress: t })} />
          </div>
          {addressInvalid ? (
            <p className="hint text-danger">That doesn&rsquo;t look like a complete address.</p>
          ) : isAddress(value.walletAddress) ? (
            <p className="hint flex items-center gap-1.5 text-naira">
              <Icon name="check_circle" size={16} fill />
              Looks right. Fixed once you sign.
            </p>
          ) : (
            <p className="hint flex items-center gap-1.5">
              <Icon name="lock" size={16} className="text-ink-3" />
              Fixed once you sign
            </p>
          )}
        </div>
      ) : (
        <BankFields value={value} set={set} />
      )}
    </div>
  );
}

/// The recipient as a phone number — the only way to name one inside MiniPay.
///
/// MiniPay forbids typing or pasting an address and forbids showing one, so
/// the number is resolved on our server (ODIS + MiniPay's attestations) and
/// the wallet it maps to goes into the draft without ever being rendered.
/// The schedule still pins that wallet at signing: if they later move their
/// number to a new MiniPay account, this schedule keeps paying the old one.
function PhoneField({
  value,
  set,
  sender,
}: {
  value: RecipientDraft;
  set: (p: Partial<RecipientDraft>) => void;
  sender?: string;
}) {
  const phone = value.phoneTyped;
  const setPhone = (t: string) => set({ phoneTyped: t });
  const countries = useMemo(() => countryOptions(), []);
  const country = countries.find((c) => c.code === value.phoneCountry) ?? countries[0];

  // The last country picked, so a sender paying home every month does not
  // pick it every time. Per device and best-effort: a blocked storage just
  // means Nigeria first, as before.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("remesso.phoneCountry") as CountryCode | null;
      if (saved && saved !== value.phoneCountry && countries.some((c) => c.code === saved)) {
        set({ phoneCountry: saved });
      }
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function pickCountry(code: CountryCode) {
    set({ phoneCountry: code });
    setError(null);
    setNotFound(false);
    try {
      localStorage.setItem("remesso.phoneCountry", code);
    } catch {
      /* private mode */
    }
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // A wallet set by a payment link or a drafted request rather than a
  // number. Not shown (it is an address), only acknowledged, with a way back
  // to a number.
  const fromLink = isAddress(value.walletAddress) && !value.phoneMasked && !value.fromContact;

  async function find() {
    setError(null);
    setNotFound(false);
    const e164 = toE164(phone, value.phoneCountry);
    if (!e164) {
      setError(`That doesn't look like a ${country.name} number. Check it, or pick their country.`);
      return;
    }
    // Typed with a + for another country: the picker follows what they typed.
    const typedCountry = countryOf(e164);
    if (typedCountry && typedCountry !== value.phoneCountry) set({ phoneCountry: typedCountry });
    setBusy(true);
    try {
      const json = await lookupPhone(e164);
      if (!json.found) {
        setNotFound(true);
        return;
      }
      if (sender && json.address.toLowerCase() === sender.toLowerCase()) {
        setError("That is your own number. Enter the number of the person you are paying.");
        return;
      }
      set({ walletAddress: json.address, phoneMasked: json.masked });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A number handed over by the "say it" box is looked up once, as if the
  // sender had tapped Find — a local "0706…" read in the picked country.
  useEffect(() => {
    if (value.phoneAutoFind) find();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.phoneAutoFind]);

  /// MiniPay's own contact picker. MiniPay matches the contact to their
  /// MiniPay wallet itself, so no number leaves the phone and no lookup quota
  /// is spent. Its docs say nothing about cancelling or older versions, so
  /// any failure is quiet and the typed number is still there.
  async function pickContact() {
    setError(null);
    setNotFound(false);
    try {
      const eth = (window as unknown as {
        ethereum?: { request: (a: { method: string; params: unknown[] }) => Promise<unknown> };
      }).ethereum;
      const c = (await eth?.request({ method: "minipay_requestContact", params: [] })) as
        | { name?: string; address?: string }
        | null
        | undefined;
      if (!c?.address || !isAddress(c.address)) return; // cancelled, or no MiniPay account
      if (sender && c.address.toLowerCase() === sender.toLowerCase()) {
        setError("That is you. Choose the person you are paying.");
        return;
      }
      set({
        walletAddress: c.address,
        phoneMasked: "",
        fromContact: true,
        // Their name from the contact, unless the sender already wrote one.
        ...(c.name?.trim() && !value.displayName.trim() ? { displayName: c.name.trim().slice(0, 60) } : {}),
      });
    } catch {
      setError("Couldn't open your contacts here. Type their number instead.");
    }
  }

  if ((value.phoneMasked || value.fromContact) && isAddress(value.walletAddress)) {
    return (
      <div className="animate-rise rounded-xl bg-naira-soft px-4 py-3.5">
        <p className="eyebrow text-naira">MiniPay account found</p>
        <p className="mt-1 font-display text-[22px] leading-tight text-ink">
          {value.phoneMasked || value.displayName || "From your contacts"}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          Payments go to {value.phoneMasked ? "the MiniPay account on this number" : "this contact's MiniPay account"}.
          Once you sign, that is fixed — if they change numbers, start a new schedule.
        </p>
        <button
          type="button"
          className="mt-2 text-[13px] font-medium text-ink-2 underline"
          onClick={() => set({ walletAddress: "", phoneMasked: "", phoneTyped: "", fromContact: false })}
        >
          Choose someone else
        </button>
      </div>
    );
  }

  if (fromLink) {
    return (
      <div className="rounded-xl bg-sand/70 px-4 py-3.5 text-[13px] text-ink-2">
        <p className="font-medium text-ink">Their wallet is already filled in</p>
        <button
          type="button"
          className="mt-1.5 font-medium underline"
          onClick={() => set({ walletAddress: "" })}
        >
          Pay a phone number instead
        </button>
      </div>
    );
  }

  const inviteText = encodeURIComponent(
    "I want to send you money every month with Remesso. Get MiniPay so it arrives straight to your phone: https://minipay.opera.com",
  );

  return (
    <div>
      <button type="button" className="btn-soft mb-4 w-full" onClick={pickContact}>
        Choose from contacts
      </button>
      <label className="label" htmlFor="recipient-phone">
        Or type their phone number
      </label>
      <div className="flex gap-2">
        {/* Shows "🇳🇬 +234" so the row fits a 360px screen; the native list
            underneath carries full names, which Android lets you type to
            jump through. Transparent select over a styled face, so the tap
            target is the whole chip and the picker is the phone's own. */}
        <div className="field relative flex w-auto shrink-0 items-center gap-1 px-3">
          <span aria-hidden className="text-[18px] leading-none">{country.flag}</span>
          <span aria-hidden className="text-[15px] tabular-nums text-ink">{country.dial}</span>
          <span aria-hidden className="text-ink-3">▾</span>
          <select
            aria-label="Their country"
            className="absolute inset-0 cursor-pointer opacity-0"
            value={country.code}
            onChange={(e) => pickCountry(e.target.value as CountryCode)}
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.name} {c.dial}
              </option>
            ))}
          </select>
        </div>
        <input
          id="recipient-phone"
          className="field min-w-0 flex-1"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder={country.code === "NG" ? "0803…" : "Number"}
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setError(null);
            setNotFound(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && find()}
        />
        <button type="button" className="btn-ink w-[5.75rem] shrink-0 px-0" disabled={busy || !phone.trim()} onClick={find}>
          {busy ? "Finding…" : "Find"}
        </button>
      </div>
      {error ? (
        <p className="hint text-danger">{error}</p>
      ) : notFound ? (
        <p className="notice-warn mt-3">
          No MiniPay account uses this number.{" "}
          <a href={`https://api.whatsapp.com/send?text=${inviteText}`} className="font-medium underline">
            Invite them on WhatsApp
          </a>
          , then try again once they have joined.
        </p>
      ) : (
        <p className="hint">The number they use for MiniPay. Pick their country first.</p>
      )}
    </div>
  );
}

/// Typing 42 hex characters on a phone is the worst moment in this flow, so
/// the clipboard is offered first. Clipboard read needs a user gesture and
/// permission; if either is missing the button just does nothing visible and
/// the field is still there to type into.
function PasteButton({ onPaste }: { onPaste: (text: string) => void }) {
  const [done, setDone] = useState(false);
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return null;
  return (
    <button
      type="button"
      className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-lg bg-sand px-2.5 py-1.5 text-[13px] font-medium text-ink-2 transition hover:bg-line/70 active:scale-95"
      onClick={async () => {
        try {
          const t = (await navigator.clipboard.readText()).trim();
          if (t) {
            onPaste(t);
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          }
        } catch {
          /* permission denied — the field still accepts typing */
        }
      }}
    >
      <Icon name={done ? "check" : "content_paste"} size={16} />
      {done ? "Pasted" : "Paste"}
    </button>
  );
}

function BankFields({
  value,
  set,
}: {
  value: RecipientDraft;
  set: (p: Partial<RecipientDraft>) => void;
}) {
  const banks = useQuery({
    queryKey: ["banks"],
    queryFn: fetchBanks,
    // The list changes a few times a year and the API allows 20 calls a minute.
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any edit invalidates a previous verification: the name on file belongs to
  // the exact bank-and-number pair that was checked, not to the form.
  useEffect(() => {
    if (value.accountName) set({ accountName: "" });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.bankCode, value.accountNumber]);

  const canCheck = Boolean(value.bankCode) && /^[0-9]{10}$/.test(value.accountNumber);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      const details: AccountDetails = await verifyAccount(value.bankCode, value.accountNumber);
      set({ accountName: details.accountName });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="label" htmlFor="bank">Bank</label>
        <select
          id="bank"
          className="field appearance-none"
          value={value.bankCode}
          disabled={banks.isLoading || banks.isError}
          onChange={(e) => set({ bankCode: e.target.value })}
        >
          <option value="">
            {banks.isLoading ? "Loading banks…" : banks.isError ? "Could not load banks" : "Choose a bank"}
          </option>
          {banks.data?.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
        {banks.isError && <p className="hint text-danger">{(banks.error as Error).message}</p>}
      </div>

      <div>
        <label className="label" htmlFor="account-number">Account number</label>
        <input
          id="account-number"
          className="field mono text-lg"
          inputMode="numeric"
          maxLength={10}
          placeholder="0123456789"
          value={value.accountNumber}
          onChange={(e) => set({ accountNumber: e.target.value.replace(/\D/g, "").slice(0, 10) })}
        />
      </div>

      {/* The verified-name card is the moment Opay and Moniepoint users look
          for before sending anything. It gets the naira green. */}
      {value.accountName ? (
        <div className="animate-rise rounded-xl bg-naira-soft px-4 py-3.5">
          <p className="eyebrow text-naira">Account name</p>
          <p className="mt-1 font-display text-[22px] leading-tight text-ink">{value.accountName}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            Make sure this is the right person. Naira sent to a bank account cannot be
            recalled.
          </p>
        </div>
      ) : (
        <button className="btn-ink w-full" disabled={!canCheck || checking} onClick={check}>
          {checking ? "Checking with the bank…" : "Verify account"}
        </button>
      )}

      {error && <p className="notice-danger">{error}</p>}
    </div>
  );
}

function Choice({
  active,
  disabled,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`tile h-full ${active ? "tile-on" : ""}`}
    >
      <span className="block text-[15px] font-medium text-ink">{title}</span>
      <span className={`mt-0.5 block text-[12px] leading-snug ${active ? "text-clay-deep" : "text-ink-3"}`}>
        {subtitle}
      </span>
    </button>
  );
}

/// Where a local currency comes from and where it goes: pesos and reais
/// through Ripio's hosted ramp, cNGN through Textile. Links only — the person
/// does it there, and Remesso never sees the bank side of either leg.
function VenueLinks({ token, sender }: { token: TokenInfo; sender?: string }) {
  const ng = token.currency === "NGN";
  const venue = ng ? "Textile" : "Ripio";
  const buy = ng ? TEXTILE_SWAP_TO_CNGN : ripioRampUrl("on", token, { address: sender });
  const out = ng ? TEXTILE_NAIRA_WITHDRAW : ripioRampUrl("off", token);
  if (!buy || !out) return null;
  const chip =
    "flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] text-ink-2 transition hover:border-ink-3 hover:text-ink";
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <a href={buy} target="_blank" rel="noopener noreferrer" className={chip}>
        <Icon name="add" size={16} />
        Buy {token.symbol} · {venue}
      </a>
      <a href={out} target="_blank" rel="noopener noreferrer" className={chip}>
        <Icon name="account_balance" size={16} />
        They cash out · {venue}
      </a>
    </div>
  );
}
