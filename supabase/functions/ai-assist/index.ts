/// The assistant layer. It drafts and classifies; it never pays.
///
/// Two operations, both advisory:
///   parse_schedule — a sentence becomes a DRAFT the sender edits and signs.
///   classify_run   — a machine failure reason becomes one of OUR categories,
///                    and the frontend owns the sentence shown for it.
///   risk_check     — how far a draft sits from what this sender usually does.
///                    Advisory to the point of being ignorable: it can add a
///                    line above the signature and nothing else. It cannot
///                    block, delay or alter a schedule.
///
/// The model's output is validated here, not trusted. Every field is clamped to
/// a value the rest of the system already accepts, and anything unrecognised is
/// dropped and reported as missing rather than guessed. The draft still has to
/// pass the form, the database constraints and the contract — this only saves
/// typing, so the worst a bad completion can do is produce a draft the sender
/// rejects.
import { complete, isConfigured, LlmError } from "../_shared/llm.ts";
import { ask, decided } from "../_shared/typesafe.ts";
import { classifyReason } from "../_shared/failures.ts";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("WEB_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/// Mirrors the frontend's Direct rail. Symbols only — the frontend owns the
/// address map, and duplicating addresses here is how the two drift apart.
const TOKENS = ["USDT", "USDC", "USDm"] as const;
type Token = typeof TOKENS[number];

/// Must stay a subset of what the picker offers, or the draft cannot be applied.
const INTERVALS: Record<string, number> = {
  "5m": 300,
  weekly: 604_800,
  fortnightly: 1_209_600,
  monthly: 2_592_000,
  quarterly: 7_776_000,
};

const PARSE_SYSTEM = `You convert a remittance request into JSON. Reply with a JSON object only.

Fields:
  amount        string decimal, per transfer, e.g. "50". null if unstated.
  token         one of USDT, USDC, USDm (Mento's dollar, formerly cUSD). null if unstated.
  interval      one of 5m, weekly, fortnightly, monthly, quarterly. null if unstated.
  maxRuns       integer number of transfers, or null for "until I stop".
  destination   a 0x... Ethereum address if one appears verbatim, else null.
  recipientName a short name for the recipient if one appears, else null.
  note          one short sentence, plain language, describing ONLY what the
                fields above actually say. Never describe timing or a number of
                transfers that you set to null — a note calling something a
                "one-time transfer" while maxRuns is null is a contradiction the
                reader will believe. If interval or maxRuns is null, say what is
                still needed instead.

Rules:
- Never invent an address. If no 0x address appears in the text, destination is null.
- Never guess an amount or a token that was not stated. Use null.
- "every month"=monthly, "every week"=weekly, "every two weeks"=fortnightly,
  "every quarter"=quarterly, "every 5 minutes"=5m.
- Do not add fields.`;

/// A second opinion on the sentence, asked of Jev at the same time as
/// DeepSeek's extraction — and used only to raise doubt, never to fill a field.
///
/// DeepSeek returns JSON that always looks confident. Jev returns a
/// distribution, so a sentence that genuinely does not say how often, or says
/// something two readings can be made of, can be shown to the sender as
/// "check this" instead of being quietly decided for them.
const DOUBT_QUESTIONS = {
  frequency: {
    type: "choice" as const,
    instructions:
      "How often does `request` ask for the money to be sent? Choose `unstated` if " +
      "the text does not say, or says something that does not fit one of the options.",
    criteria: {
      "5m": "Every five minutes.",
      weekly: "Once a week.",
      fortnightly: "Once every two weeks.",
      monthly: "Once a month.",
      quarterly: "Once every three months.",
      unstated: "The text does not state how often, or states something else entirely.",
    },
  },
  token: {
    type: "choice" as const,
    instructions: "Which currency does `request` say the money should be sent in?",
    criteria: {
      USDT: "US dollar stablecoin USDT, also written Tether or USD₮.",
      USDC: "US dollar stablecoin USDC.",
      USDm: "Celo dollar, written USDm or by its old name cUSD.",
      unstated: "The text names no currency, or names one not listed here.",
    },
  },
  payout: {
    type: "choice" as const,
    instructions:
      "How does `request` say the recipient should be paid? A payment to a wallet " +
      "address goes to a crypto wallet; a bank payout reaches a Nigerian bank account " +
      "in naira.",
    criteria: {
      wallet: "To a wallet address, or the text implies the recipient holds the money themselves.",
      bank: "Into a Nigerian bank account, in naira, or to an account number.",
      unstated: "The text does not say how the recipient is paid.",
    },
  },
  states_amount: {
    type: "noul" as const,
    instructions: "Does `request` state how much money to send in each single transfer?",
  },
};

/// How unusual a draft is for this sender.
///
/// The facts are computed by the frontend in code — is this recipient new, is
/// the amount larger than any before, does it start immediately — because
/// those are lookups, not judgments. What Jev adds is weighing the combination:
/// a new recipient alone is ordinary, and a new recipient receiving more than
/// the sender has ever sent, starting immediately, is not.
///
/// Levels describe situations rather than degrees, which is what the model
/// matches against.
const RISK_LEVELS = [
  "Ordinary for this sender: a recipient they have paid before, an amount in line with their existing schedules.",
  "Slightly out of pattern: a recipient they have not paid before, or an amount somewhat larger than their usual one.",
  "Clearly out of pattern: a first-time recipient receiving more than this sender has ever scheduled, or a total commitment far above anything they have signed before.",
  "Out of pattern in several ways at once: a first-time recipient, the largest amount this sender has ever scheduled, and the first transfer leaving immediately.",
];

type RiskState = {
  amount_usd: number;
  previous_amounts_usd: number[];
  recipient_paid_before: boolean;
  first_transfer_immediate: boolean;
  transfers: number | null;
  how_often: string;
  total_commitment_usd: number;
};

/// Everything here is a number or a flag the frontend computed, and it is
/// re-checked rather than trusted: this is a public endpoint behind a session,
/// and a state full of attacker-chosen text is the way a judgment becomes a
/// prompt.
function riskState(body: Record<string, unknown>): RiskState | null {
  const num = (v: unknown, max = 1e12) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
  const amount = num(body.amount_usd);
  if (amount === null) return null;

  const previous = Array.isArray(body.previous_amounts_usd)
    ? body.previous_amounts_usd.map((v) => num(v)).filter((v): v is number => v !== null).slice(0, 20)
    : [];
  const transfers = num(body.transfers, 10_000);
  const often = typeof body.how_often === "string" ? body.how_often.slice(0, 40) : "";
  if (!/^(5 minutes|weekly|fortnightly|monthly|quarterly)$/.test(often)) return null;

  return {
    amount_usd: amount,
    previous_amounts_usd: previous,
    recipient_paid_before: body.recipient_paid_before === true,
    first_transfer_immediate: body.first_transfer_immediate === true,
    transfers: transfers === null ? null : Math.round(transfers),
    how_often: often,
    total_commitment_usd: num(body.total_commitment_usd) ?? amount,
  };
}

async function riskCheck(state: RiskState) {
  const answers = await ask(state, {
    unusual: {
      type: "score",
      instructions:
        "A sender is about to authorise a recurring payment. `amount_usd` is each " +
        "transfer, `previous_amounts_usd` are the amounts of schedules they have " +
        "already set up, and `recipient_paid_before` says whether this recipient has " +
        "received one before. How far does this sit from what this sender usually does?",
      criteria: RISK_LEVELS,
    },
  });

  const a = answers?.unusual;
  if (!a || a.type !== "score") return { score: null, confidence: 0, unusual: false };
  // Two levels up the scale, and only when the distribution is not a shrug.
  // A false alarm above a signature teaches senders to sign through warnings.
  return { score: a.score, confidence: a.confidence, unusual: a.score >= 1.5 && a.confidence >= 0.5 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // Drafting needs DeepSeek; classifying does not, so a missing DeepSeek key
  // must not take the failure copy down with it.

  let body: { op?: string; text?: string; reason?: string; [k: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  try {
    if (body.op === "parse_schedule") {
      if (!isConfigured()) return json({ error: "assistant is not configured" }, 503);
      const text = (body.text ?? "").trim();
      if (!text) return json({ error: "text is required" }, 400);
      if (text.length > 500) return json({ error: "text is too long" }, 400);
      return json(await parseSchedule(text));
    }

    if (body.op === "risk_check") {
      const state = riskState(body as Record<string, unknown>);
      if (!state) return json({ error: "invalid state" }, 400);
      return json(await riskCheck(state));
    }

    if (body.op === "classify_run") {
      const reason = (body.reason ?? "").trim();
      if (!reason) return json({ error: "reason is required" }, 400);
      return json(await classifyReason(reason.slice(0, 500)));
    }

    return json({ error: "unknown op" }, 400);
  } catch (e) {
    const status = e instanceof LlmError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
});

async function parseSchedule(text: string) {
  // Both readings of the same sentence at once: the extraction that fills the
  // form, and the judgments that decide what to flag. Jev failing leaves the
  // draft exactly as it was before.
  const [out, doubts] = await Promise.all([
    complete(PARSE_SYSTEM, text) as Promise<Record<string, unknown>>,
    // The sender is watching a spinner here, and DeepSeek's own answer is what
    // fills the form: doubt that arrives late is worth less than a fast draft.
    ask({ request: text }, DOUBT_QUESTIONS, 5000),
  ]);

  // Clamp every field to something the form already accepts. Anything the model
  // returned that is not recognised becomes `missing`, which the UI asks for —
  // far better than a plausible-looking guess the sender might not check.
  // "cUSD" is the old name; a model trained on it will keep answering with it.
  const said = str(out.token)?.toLowerCase() === "cusd" ? "usdm" : str(out.token)?.toLowerCase();
  const token = TOKENS.find((t) => t.toLowerCase() === said) ?? null;
  const intervalKey = str(out.interval)?.toLowerCase() ?? "";
  const intervalSeconds = INTERVALS[intervalKey] ?? null;

  const amountRaw = str(out.amount) ?? (typeof out.amount === "number" ? String(out.amount) : null);
  const amount = amountRaw && /^\d+(\.\d{1,18})?$/.test(amountRaw) && Number(amountRaw) > 0
    ? amountRaw
    : null;

  // An address is either exactly right or absent. A model-repaired address is
  // an irreversible payment to a stranger.
  const destRaw = str(out.destination);
  const destination = destRaw && /^0x[a-fA-F0-9]{40}$/.test(destRaw) ? destRaw : null;

  const maxRunsNum = Number(out.maxRuns);
  const maxRuns = Number.isInteger(maxRunsNum) && maxRunsNum > 0 && maxRunsNum <= 1000
    ? maxRunsNum
    : null;

  const missing: string[] = [];
  if (!amount) missing.push("amount");
  if (!token) missing.push("token");
  if (!intervalSeconds) missing.push("frequency");
  if (!destination) missing.push("recipient address");

  // Fields worth a second look before signing. A field already in `missing` is
  // not repeated — the sender is being asked for it anyway.
  //
  // The bar is deliberately high (0.8): this only ever adds a line asking
  // someone to check their own payment, but crying wolf on every draft is how
  // that line stops being read.
  const unsure: string[] = [];
  const freq = decided(doubts?.frequency, 0.8, "unstated");
  if (intervalSeconds && freq && INTERVALS[freq.choice] !== intervalSeconds) {
    unsure.push("frequency");
  }
  const tok = decided(doubts?.token, 0.8, "unstated");
  if (token && tok && tok.choice !== token) unsure.push("token");

  // Nothing here can set up a bank payout — that needs an account number the
  // sender enters and cNGN verifies — so this only points at the choice.
  const rail = decided(doubts?.payout, 0.8, "unstated");
  if (rail?.choice === "bank") unsure.push("payout to a bank account");

  // DeepSeek returning an amount the sentence does not state is the failure
  // that matters most here, because the sender may sign it without re-reading.
  const statesAmount = doubts?.states_amount;
  if (amount && statesAmount?.type === "noul" && statesAmount.noul < 0.2) {
    unsure.push("amount");
  }

  return {
    unsure,
    draft: {
      amount,
      token,
      intervalSeconds,
      maxRuns,
      destination,
      recipientName: str(out.recipientName)?.slice(0, 60) ?? null,
      payoutType: "direct" as const,
    },
    note: str(out.note)?.slice(0, 200) ?? null,
    missing,
  };
}

/// Trim to a length without cutting a word in half. A label that reads
/// "send manu" is worse than one that reads slightly shorter.
function clip(v: string | null, max: number): string | null {
  if (!v) return null;
  if (v.length <= max) return v;
  const cut = v.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
