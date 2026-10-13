"use client";

import { useQuery } from "@tanstack/react-query";
import { riskCheck, type RiskState } from "@/lib/ai";
import { tokenFor } from "@/lib/config";
import { useSchedules } from "@/lib/hooks";
import { one } from "@/lib/types";

/// A line above the signature when a draft is unlike anything this sender has
/// done before.
///
/// It warns and nothing else: no blocking, no extra confirmation step, no
/// delay. A schedule the sender means to sign is one tap away exactly as it
/// was. The facts below are computed here — a new recipient, a bigger amount —
/// and Jev only decides whether the combination is worth a sentence, so when
/// it is unreachable the screen is simply the screen.
export function UnusualCheck({
  amountUsd,
  recipientAddress,
  accountNumber,
  howOften,
  transfers,
  startsNow,
}: {
  amountUsd: number | null;
  recipientAddress: string | null;
  accountNumber: string | null;
  howOften: string;
  transfers: number | null;
  startsNow: boolean;
}) {
  const { data: schedules } = useSchedules();

  // Dollar amounts across assets are comparable at 1:1 — USDT, USDC, USDm and USA₮
  // are all dollar stablecoins, which is the same assumption the balance strip
  // already makes. wFIAT schedules are left out: 50,000 wARS read as $50,000
  // would make every dollar amount after it look small.
  const previous = (schedules ?? []).flatMap((s) => {
    const t = tokenFor(s.token_address);
    if (t.currency !== "USD") return [];
    return [Number(BigInt(s.amount_in) / 10n ** BigInt(t.decimals - 2)) / 100];
  });

  const paidBefore = (schedules ?? []).some((s) => {
    const r = one(s.recipients);
    if (!r) return false;
    return recipientAddress
      ? r.wallet_address?.toLowerCase() === recipientAddress.toLowerCase()
      : Boolean(accountNumber) && r.account_number === accountNumber;
  });

  const state: RiskState | null = amountUsd && amountUsd > 0
    ? {
      amount_usd: amountUsd,
      previous_amounts_usd: previous,
      recipient_paid_before: paidBefore,
      first_transfer_immediate: startsNow,
      transfers,
      how_often: howOften,
      total_commitment_usd: amountUsd * (transfers ?? 12),
    }
    : null;

  const { data } = useQuery({
    queryKey: ["risk", state],
    enabled: Boolean(state),
    queryFn: () => riskCheck(state!),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (!data?.unusual || !state) return null;

  // Said as facts the sender can check, not as a verdict they cannot argue
  // with. The model chose to speak; the reasons are ours.
  const reasons = [
    !state.recipient_paid_before ? "you haven’t paid this person before" : null,
    previous.length && state.amount_usd > Math.max(...previous)
      ? "it’s more per transfer than any schedule you’ve set up"
      : null,
    state.first_transfer_immediate ? "the first transfer leaves straight away" : null,
  ].filter(Boolean);

  return (
    <div className="notice-warn mt-3">
      <p className="font-medium">This one is different from your usual</p>
      {reasons.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {reasons.map((r) => <li key={r as string}>{r}</li>)}
        </ul>
      )}
      <p className="mt-1.5">
        Nothing is wrong — check the person and the amount, then carry on.
      </p>
    </div>
  );
}
