/// A link that says "pay me here", and the parser that reads one.
///
/// The gap this closes: an agent that wants to be paid has an address and no
/// way to hand it over. Reading a 42-character hex string to a person who then
/// types it into a phone is the worst possible transfer of the one value where
/// a single wrong character sends money to nobody. A link carries it exactly.
///
/// What a link can and cannot do, because this is the whole safety argument:
/// it fills in a form. It cannot create a schedule, cannot approve an
/// allowance, and cannot sign anything — the sender still reviews every field
/// and signs in their own wallet. So the worst a hostile link achieves is a
/// prefilled recipient the sender is shown and must accept, which is why
/// `NewSchedulePage` announces that a link filled the form rather than letting
/// the values appear as if the sender chose them.
///
/// Everything is validated here rather than trusted: an address that is not an
/// address, a token that is not on the Direct allowlist, or a cadence the
/// picker does not offer is dropped, not passed through. A link is input from
/// a stranger.
import { isAddress } from "viem";
import { DIRECT_TOKENS, type TokenInfo } from "@/lib/config";
import { SELECTABLE_INTERVALS } from "@/lib/format";

export type PayLink = {
  to?: `0x${string}`;
  name?: string;
  amount?: string;
  token?: TokenInfo;
  intervalSeconds?: number;
  maxRuns?: string;
  /// A short free-text note from whoever built the link — shown, never used.
  note?: string;
  /// The payment request this link answers (`req=`). The form reports the
  /// schedule it creates against it, and `confirm-schedule` decides from the
  /// chain whether it really answers it: a link can name a request, it can't
  /// make a schedule count as paying one.
  request?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// Cadence spellings a link may use. The seconds are the source of truth; these
/// are what an agent would plausibly write, and anything else is ignored.
const CADENCE: Record<string, number> = {
  week: 7 * 86400,
  weekly: 7 * 86400,
  fortnight: 14 * 86400,
  fortnightly: 14 * 86400,
  month: 30 * 86400,
  monthly: 30 * 86400,
  quarter: 90 * 86400,
  quarterly: 90 * 86400,
};

/// Parse `?to=0x…&amount=5&every=week` into a draft patch.
///
/// Returns only what it could resolve. A partially valid link is still useful —
/// a good address with a nonsense cadence should fill the address.
export function parsePayLink(search: string): PayLink {
  const q = new URLSearchParams(search);
  const out: PayLink = {};

  const to = (q.get("to") ?? "").trim();
  if (isAddress(to)) out.to = to as `0x${string}`;

  // Capped rather than sanitised: this is rendered as text by React, so the
  // risk is not injection but a link padding the screen with 10kB of junk.
  //
  // `from` is what the request-payment API calls this field, `name` is what
  // links built before it used. Both are read so neither spelling is a link
  // that half-works.
  const name = (q.get("from") ?? q.get("name") ?? "").trim();
  if (name) out.name = name.slice(0, 40);
  const note = (q.get("note") ?? "").trim();
  if (note) out.note = note.slice(0, 120);

  // A plain positive decimal, left as the string the form works in. Not
  // parsed to a number: `parseUnits` at the funding asset's own scale is what
  // turns it into units, and a float in between is how precision is lost.
  const amount = (q.get("amount") ?? "").trim();
  if (/^\d{1,12}(\.\d{1,18})?$/.test(amount) && Number(amount) > 0) out.amount = amount;

  const symbol = (q.get("token") ?? "").trim().toUpperCase();
  const token = DIRECT_TOKENS.find((t) => t.symbol.toUpperCase() === symbol);
  if (token) out.token = token;

  // `every` takes a word or a number of seconds, but a number is honoured only
  // when the picker actually offers it — otherwise the form would hold a
  // cadence no control can display or change.
  const every = (q.get("every") ?? "").trim().toLowerCase();
  const named = CADENCE[every];
  const asSeconds = /^\d+$/.test(every) ? Number(every) : NaN;
  const offered = SELECTABLE_INTERVALS.find((i) => i.seconds === (named ?? asSeconds));
  if (offered) out.intervalSeconds = offered.seconds;

  const runs = (q.get("runs") ?? "").trim();
  if (/^\d{1,4}$/.test(runs) && Number(runs) > 0) out.maxRuns = runs;

  const req = (q.get("req") ?? "").trim();
  if (UUID.test(req)) out.request = req.toLowerCase();

  return out;
}

export function isEmptyPayLink(p: PayLink): boolean {
  return !p.to && !p.amount && !p.token && !p.intervalSeconds && !p.maxRuns && !p.name;
}

/// Build the link an agent hands to its operator.
///
/// `origin` is passed in rather than read from `window` so this is callable
/// from a server component and from a test.
export function buildPayLink(
  origin: string,
  p: { to: string; name?: string; amount?: string; token?: string; every?: string; runs?: string; note?: string; req?: string },
): string {
  const q = new URLSearchParams();
  q.set("to", p.to);
  for (const [k, v] of Object.entries({
    from: p.name,
    amount: p.amount,
    token: p.token,
    every: p.every,
    runs: p.runs,
    note: p.note,
    req: p.req,
  })) {
    if (v) q.set(k, String(v));
  }
  return `${origin.replace(/\/+$/, "")}/schedules/new?${q.toString()}`;
}
