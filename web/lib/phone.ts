/// Phone numbers as MiniPay recipients — the parts both sides need.
///
/// ODIS takes E.164 only (`+2348031234567`) and refuses anything else, so a
/// number is normalised here before it is sent anywhere. A country is never
/// guessed: a leading 0 means a different person in every country, and a
/// wrong guess resolves to a stranger's wallet. It comes from the picker the
/// sender set, or from a `+` they typed — which wins over the picker.
///
/// libphonenumber-js knows every country's code and trunk prefix (Nigeria's
/// "0706…" is "+234 706…"; Ghana's "024…" is "+233 24…"), which is the part
/// a hand-written rule gets wrong one country at a time.
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

export type { CountryCode };

/// E.164, or null. `+…` and `00…` are read as international whatever the
/// picker says; anything else is read as a number in `country`.
/// `isPossible` (length per country) rather than `isValid` (known ranges):
/// operators open new ranges faster than the metadata is released, and a real
/// number refused here is a recipient who cannot be paid.
export function toE164(input: string, country?: CountryCode): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, "");
  // `00` is the international prefix written longhand.
  const s = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  const international = s.startsWith("+");
  if (!international && !country) return null;
  const p = parsePhoneNumberFromString(s, international ? undefined : country);
  return p && p.isPossible() ? p.number : null;
}

/// The country a typed `+…` number belongs to, so the picker can follow it.
export function countryOf(e164: string): CountryCode | undefined {
  return parsePhoneNumberFromString(e164)?.country;
}

export type CountryOption = { code: CountryCode; dial: string; name: string; flag: string };

/// Where most MiniPay users are, offered first so they are one tap away.
/// Every other country follows, alphabetically.
const FIRST: CountryCode[] = ["NG", "GH", "KE", "ZA", "UG", "TZ", "CM", "ET"];

/// Every country with a dialling code, named in the reader's own language by
/// the browser (Intl.DisplayNames) — no list of names to ship or translate.
export function countryOptions(locale?: string): CountryOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(locale ? [locale] : undefined, { type: "region" });
  } catch {
    /* very old WebView: codes alone still work */
  }
  const all = getCountries().map((code) => ({
    code,
    dial: `+${getCountryCallingCode(code)}`,
    name: names?.of(code) ?? code,
    // Regional-indicator letters: "NG" renders as 🇳🇬.
    flag: String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)),
  }));
  const first = FIRST.flatMap((c) => all.filter((o) => o.code === c));
  const rest = all.filter((o) => !FIRST.includes(o.code)).sort((a, b) => a.name.localeCompare(b.name));
  return [...first, ...rest];
}

/// What a sender sees and what we store: enough to recognise the number,
/// not enough to dial it. `+234 803 ••• 4567`, split at the real country code.
export function maskPhone(e164: string): string {
  const p = parsePhoneNumberFromString(e164);
  const cc = p ? `+${p.countryCallingCode}` : e164.slice(0, 4);
  const national = p ? String(p.nationalNumber) : e164.slice(4);
  return `${cc} ${national.slice(0, 3)} ••• ${national.slice(-4)}`;
}

/// A phone number inside a sentence ("send 20 USDT to +234 706 765 1245 every
/// month"), or null. Needs 9+ digits so an amount or a count never matches.
/// Returns the text as written, plus the sentence with it cut out — the
/// number is resolved by us, never sent to the language model: it is a
/// person's phone number, and a model has no business seeing it.
export function findPhone(text: string): { raw: string; redacted: string } | null {
  const re = /(?:\+|\b00|\b0)\d[\d\s\-().]{6,20}\d/g;
  for (const m of text.matchAll(re)) {
    // An unbroken run that is already a whole number stands alone: in
    // "07067651245 5000 USDT" the 5000 is the amount, not more digits.
    const firstRun = /^\+?\d+/.exec(m[0])![0];
    const span = firstRun.replace(/\D/g, "").length >= 9 ? firstRun : m[0].trim();
    const digits = span.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    return {
      raw: span,
      redacted: `${text.slice(0, m.index)}[recipient]${text.slice(m.index! + span.length)}`,
    };
  }
  return null;
}
