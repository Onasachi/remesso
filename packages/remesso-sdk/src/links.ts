/// A link that says "pay me here", and the parser that reads one. Ported from
/// `web/lib/payLink.ts`, which the app reads links with.
///
/// A link fills in a form. It can't create a schedule, approve an allowance or
/// sign anything: the payer reviews every field and signs in their own wallet,
/// and the form says a link filled it. Everything is validated, not trusted:
/// a link is input from a stranger.
import { isAddress } from "viem";
import { deployment, findToken } from "./deployment.js";

export type PayLinkInput = {
  to: string;
  /** Who is asking, shown on the form. */
  from?: string;
  /** What the recipient should receive per payment, decimal. */
  amount?: string;
  token?: string;
  every?: "week" | "fortnight" | "month" | "quarter";
  runs?: number;
  note?: string;
  /** The payment request this link answers. */
  request?: string;
};

export type PayLink = {
  to?: `0x${string}`;
  from?: string;
  amount?: string;
  token?: string;
  intervalSeconds?: number;
  runs?: number;
  note?: string;
  request?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/// The cadences the form's picker offers. Anything else is dropped.
const CADENCE: Record<string, number> = {
  week: 604_800, weekly: 604_800,
  fortnight: 1_209_600, fortnightly: 1_209_600,
  month: 2_592_000, monthly: 2_592_000,
  quarter: 7_776_000, quarterly: 7_776_000,
};

/// The link that opens the payer's Remesso form prefilled.
export function payLink(p: PayLinkInput, origin: string = deployment.app.origin): string {
  const q = new URLSearchParams();
  q.set("to", p.to);
  const token = p.token ? findToken(p.token)?.symbol ?? p.token : undefined;
  for (const [k, v] of Object.entries({ from: p.from, amount: p.amount, token, every: p.every, runs: p.runs, note: p.note, req: p.request })) {
    if (v != null && v !== "") q.set(k, String(v));
  }
  return `${origin.replace(/\/+$/, "")}/schedules/new?${q.toString()}`;
}

/// What a link says, keeping only what validates.
export function parsePayLink(urlOrQuery: string): PayLink {
  const s = String(urlOrQuery);
  const q = new URLSearchParams(s.includes("?") ? s.slice(s.indexOf("?") + 1) : s);
  const out: PayLink = {};
  const to = (q.get("to") ?? "").trim();
  if (isAddress(to)) out.to = to as `0x${string}`;
  const from = (q.get("from") ?? q.get("name") ?? "").trim();
  if (from) out.from = from.slice(0, 40);
  const note = (q.get("note") ?? "").trim();
  if (note) out.note = note.slice(0, 120);
  const amount = (q.get("amount") ?? "").trim();
  if (/^\d{1,12}(\.\d{1,18})?$/.test(amount) && Number(amount) > 0) out.amount = amount;
  const token = findToken((q.get("token") ?? "").trim());
  if (token && token.directAllowed) out.token = token.symbol;
  const every = (q.get("every") ?? "").trim().toLowerCase();
  const seconds = CADENCE[every] ?? (/^\d+$/.test(every) ? Number(every) : NaN);
  if (Object.values(CADENCE).includes(seconds)) out.intervalSeconds = seconds;
  const runs = (q.get("runs") ?? "").trim();
  if (/^\d{1,4}$/.test(runs) && Number(runs) > 0) out.runs = Number(runs);
  const req = (q.get("req") ?? "").trim();
  if (UUID.test(req)) out.request = req.toLowerCase();
  return out;
}
