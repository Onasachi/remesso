/// What the pre-flight agent tells a sender, in words written here — the agent
/// decides WHICH notice and how urgent (supabase/functions/_shared/preflight.ts);
/// no model writes a sentence a sender reads about their payment.

export type NoticeKind = "balance_short" | "allowance_short" | "allowance_ending" | "rate_moved";

export type ScheduleNotice = {
  id: string;
  schedule_id: string;
  kind: NoticeKind;
  severity: "info" | "warn" | "urgent";
  details: {
    symbol?: string;
    amount?: number;
    dueInSecs?: number;
    balance?: number;
    shortBy?: number;
    allowance?: number;
    paymentsCovered?: number;
    movePct?: number;
    usdNow?: number | null;
  };
  updated_at: string;
};

const n = (v: number | undefined) =>
  v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 6 : 2 });

/// "in 5 hours", "in 20 minutes", "now".
export function dueIn(secs: number | undefined): string {
  if (secs === undefined || secs <= 60) return "now";
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `in ${h} hour${h === 1 ? "" : "s"}`;
  const m = Math.max(1, Math.round(secs / 60));
  return `in ${m} minute${m === 1 ? "" : "s"}`;
}

export function noticeText(x: ScheduleNotice): { title: string; body: string } {
  const d = x.details;
  const sym = d.symbol ?? "";
  switch (x.kind) {
    case "balance_short":
      return {
        title: `Next payment ${dueIn(d.dueInSecs)} — not enough ${sym}`,
        body: `It needs ${n(d.amount)} ${sym} and your wallet has ${n(d.balance)}. Add at least ${n(d.shortBy)} ${sym} or it will be skipped.`,
      };
    case "allowance_short":
      return {
        title: `Next payment ${dueIn(d.dueInSecs)} will be skipped`,
        body: `Remesso may only move ${n(d.allowance)} ${sym} and the payment is ${n(d.amount)}. Allow it again to keep it going.`,
      };
    case "allowance_ending":
      return {
        title: "The payment after next will be skipped",
        body: `What you allowed covers ${d.paymentsCovered ?? 1} more payment of ${n(d.amount)} ${sym}. Allow more now and nothing is missed.`,
      };
    case "rate_moved": {
      const up = (d.movePct ?? 0) > 0;
      return {
        title: `${sym} ${up ? "strengthened" : "weakened"} ${Math.abs(d.movePct ?? 0)}% since yesterday`,
        body: `Your next payment of ${n(d.amount)} ${sym} is now worth about $${n(d.usdNow ?? undefined)}. They still receive exactly ${n(d.amount)} ${sym} — this is only what it is worth in dollars.`,
      };
    }
  }
}
