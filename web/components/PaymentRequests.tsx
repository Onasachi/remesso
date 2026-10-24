"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { usePaymentRequests } from "@/lib/hooks";
import { ensureSession, supabase } from "@/lib/supabase";
import { buildPayLink } from "@/lib/payLink";
import { everyLabel } from "@/lib/format";
import type { PaymentRequest } from "@/lib/types";

/// Requests from agents (or people) asking to be paid.
///
/// Deliberately not styled as a notification, a badge or anything that nags. A
/// request is a stranger's suggestion, and the screen should read as one:
/// here is what someone asked for, open it or hide it. Nothing counts down,
/// nothing expires in front of the sender, and ignoring it entirely is a
/// complete answer.
///
/// Hiding is for this session only. The session's wallet is a claim, not a
/// proof (MiniPay can't sign), so it must not change anything anyone else
/// sees, and the person asking is not told. Only a signed decline, which an
/// agent can send to `request-payment`, answers a request for everyone.
///
/// The card never says the request is legitimate, because we have no way to
/// know: anybody can POST to `request-payment`. What it says is who claims to
/// be asking and for what, which is exactly as much as we actually know.
export function PaymentRequests() {
  const { data: requests } = usePaymentRequests();
  if (!requests?.length) return null;

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-[22px] text-ink">Asking to be paid</h2>
        <span className="text-[13px] text-ink-3">{requests.length}</span>
      </div>
      <ul className="space-y-3">
        {requests.map((r) => (
          <RequestCard key={r.id} request={r} />
        ))}
      </ul>
    </section>
  );
}

function RequestCard({ request: r }: { request: PaymentRequest }) {
  const queryClient = useQueryClient();
  const { address } = useAccount();

  const terms = [
    r.amount && r.token_symbol ? `${r.amount} ${r.token_symbol}` : r.amount,
    r.interval_seconds ? everyLabel(r.interval_seconds) : null,
    r.max_runs ? `${r.max_runs} times` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Rebuilt here rather than stored: the row holds the terms, and the link is
  // one rendering of them. A stored URL would be a second copy to keep in step
  // with a form whose parameters will change.
  const href = buildPayLink("", {
    to: r.to_address,
    name: r.from_name ?? undefined,
    amount: r.amount ?? undefined,
    token: r.token_symbol ?? undefined,
    every: r.interval_seconds ? String(r.interval_seconds) : undefined,
    runs: r.max_runs ? String(r.max_runs) : undefined,
    note: r.note ?? undefined,
  });

  async function hide() {
    // A hide belongs to a session, so make sure there is one.
    if (!(await ensureSession())) return;
    const { error } = await supabase().rpc("hide_payment_request", { p_id: r.id });
    if (error) {
      console.error("hide_payment_request failed:", error.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["payment-requests", address] });
  }

  return (
    <li className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium text-ink">
            {r.from_name || "An agent"}
          </p>
          <p className="mono mt-0.5 truncate text-[12px] text-ink-3">
            {r.to_address.slice(0, 10)}…{r.to_address.slice(-6)}
          </p>
        </div>
        {terms && <span className="shrink-0 text-[13px] text-ink-2">{terms}</span>}
      </div>

      {r.note && <p className="mt-2 text-[13px] leading-snug text-ink-2">&ldquo;{r.note}&rdquo;</p>}

      <div className="mt-3 flex items-center gap-2">
        <Link href={href} className="btn-soft btn-sm">
          Review
        </Link>
        <button
          type="button"
          onClick={hide}
          className="btn-ghost btn-sm"
          title="Hides it from this list. The person asking isn't told."
        >
          Hide
        </button>
        {/* Said on every card, not once at the top of the list: a sender
            scrolling a list reads one card, and the reassurance has to be
            where the decision is. */}
        <span className="ml-auto text-[12px] text-ink-3">Nothing is sent until you sign</span>
      </div>
    </li>
  );
}
