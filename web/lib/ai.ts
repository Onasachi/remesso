"use client";

import { ensureSession } from "./supabase";

/// The assistant, from the browser's side.
///
/// Everything here is advisory. `parseSchedule` returns a draft the sender
/// still edits and signs, and `classifyRun` only picks which of OUR sentences
/// describes a failure the backend already decided. Neither can cause a
/// payment, and neither puts model-written prose in front of a sender.

export type Draft = {
  amount: string | null;
  token: "USDT" | "USDC" | "USDm" | "USAT" | null;
  intervalSeconds: number | null;
  maxRuns: number | null;
  destination: `0x${string}` | null;
  recipientName: string | null;
  payoutType: "direct";
};

/// `missing` is what the sentence never said; `unsure` is what it said in a way
/// two readings fit, so the sender is asked to check rather than told.
export type ParseResult = {
  draft: Draft;
  note: string | null;
  missing: string[];
  unsure?: string[];
};
/// Which failure category the backend put a reason in, and how it decided:
/// `rules` for a string Remesso itself wrote, `jev` for a typed judgment,
/// `none` when no classifier was available. The wording lives in lib/failures.
export type Classification = {
  category: string;
  source: "rules" | "jev" | "none";
  confidence: number;
};

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const token = await ensureSession();
  if (!token) throw new Error("couldn't reach the assistant — try again");

  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `assistant error ${res.status}`);
  return json as T;
}

export const parseSchedule = (text: string) =>
  call<ParseResult>({ op: "parse_schedule", text });

export const classifyRun = (reason: string) =>
  call<Classification>({ op: "classify_run", reason });

/// How far a draft sits from what this sender already does.
///
/// The facts are computed here in code; Jev only weighs the combination, and
/// its answer can do exactly one thing — add a line above the signature. When
/// it is unavailable the line simply does not appear.
export type RiskState = {
  amount_usd: number;
  previous_amounts_usd: number[];
  recipient_paid_before: boolean;
  first_transfer_immediate: boolean;
  transfers: number | null;
  how_often: string;
  total_commitment_usd: number;
};

export type RiskResult = { score: number | null; confidence: number; unusual: boolean };

export const riskCheck = (state: RiskState) =>
  call<RiskResult>({ op: "risk_check", ...state });
