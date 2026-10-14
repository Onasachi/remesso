"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useIdentity, useIsMiniPay, useSenderId } from "@/lib/hooks";
import { startIdentityCheck, type IdentityStanding } from "@/lib/api";
import { Pill } from "./StatusPill";
import { Icon } from "./Icon";

/// Optional identity check through Self. Blocks nothing: a sender who never
/// verifies can do everything a verified one can. So it sits quietly on the
/// home screen as one row, and once done it shrinks to a badge.
export function IdentityCard() {
  const { data, isPending } = useIdentity();
  const { data: senderId } = useSenderId();
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: startIdentityCheck,
    // Do not navigate from here. Opening the link has to happen inside a tap
    // (see OpenSelf), and this callback runs after a network round trip, by
    // which time the tap no longer counts. Flip the card to its "open" state
    // instead, so the next tap is the one that leaves.
    onSuccess: ({ verificationUrl }) => {
      qc.setQueryData<IdentityStanding>(["identity", senderId], (old) => ({
        available: true,
        verified: old?.verified ?? null,
        latest: { status: "pending", reason: null, verificationUrl },
      }));
    },
  });

  if (isPending || !data) return null;
  const { available, verified, latest } = data;

  if (verified) {
    // A test key accepts the Self app's mock passports. Saying "verified"
    // plainly about one would be the badge lying.
    const test = verified.environment !== "live";
    return (
      <div className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-xl bg-sand/70 px-4 text-[13px] text-ink-2">
        <span>Identity</span>
        <Pill label={test ? "Verified (test document)" : "Verified with Self"} tone={test ? "warn" : "good"} />
      </div>
    );
  }

  if (!available) return null;

  if (latest?.status === "pending" && latest.verificationUrl) {
    return (
      <div className="notice-info mt-3">
        <p className="font-medium text-ink">Continue in the Self app</p>
        <OpenSelf url={latest.verificationUrl} />
      </div>
    );
  }

  const failed = latest && latest.status !== "pending";

  // Never tried: one quiet row. Anything with a story to tell (a failure, a
  // duplicate passport) keeps the full card below.
  if (!latest) {
    return (
      <div className="mt-3 flex items-center gap-3 rounded-xl bg-sand py-2.5 pl-3 pr-2.5">
        <span className="disc h-9 w-9 bg-surface">
          <Icon name="verified_user" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink">Verify identity</p>
          <p className="mt-px text-[12px] text-ink-2">Optional · passport stays on your phone</p>
          {start.error && <p className="mt-1 text-[12px] text-danger">{start.error.message}</p>}
        </div>
        <button
          type="button"
          className="min-h-9 rounded-xl bg-surface px-3.5 text-sm font-semibold text-ink transition hover:bg-line/60 disabled:opacity-40"
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? "…" : "Self"}
        </button>
      </div>
    );
  }

  return (
    <div className={`${latest?.status === "duplicate" ? "notice-warn" : "notice-info"} mt-3`}>
      <p className="font-medium text-ink">
        {latest?.status === "duplicate"
          ? "Already verified on another account"
          : failed
            ? "That check didn’t go through"
            : "Verify your identity — optional"}
      </p>
      <p className="mt-0.5">
        {latest?.status === "duplicate"
          ? "This passport already verified a different Remesso account. Your schedules here work the same either way."
          : "Your passport is checked on your phone by the Self app. Remesso gets the result, never a copy of the passport. Nothing here needs it."}
      </p>
      {start.error && <p className="mt-2 text-danger">{start.error.message}</p>}
      {latest?.status !== "duplicate" && (
        <button
          type="button"
          className="btn-soft btn-sm mt-3 bg-surface"
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? "Preparing…" : failed ? "Try again" : "Verify with Self"}
        </button>
      )}
    </div>
  );
}

/// Gets the sender from here into the Self app with the request attached.
///
/// Self opens its app by switching to a `proofofpassport://` link, falling back
/// to the App Store after one second. MiniPay's webview blocks that switch, so
/// inside MiniPay the fallback always wins, the request is lost, and the Self
/// app opens with nothing to approve. Neither navigating nor `window.open`
/// gets past it. Verified on device 2026-09-19.
///
/// What does work, also verified: copy the link, open it in Chrome or Safari,
/// approve in Self, come back. The result reaches MiniPay through the server,
/// so the sender only has to return — no redirect has to land in MiniPay.
///
/// Outside MiniPay, a plain browser opens the link directly (and shows a QR
/// on a desktop), so there the button is the primary action.
function OpenSelf({ url }: { url: string }) {
  const inMiniPay = useIsMiniPay();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(url).then(
      () => setCopied(true),
      () => setCopied(false),
    );

  if (!inMiniPay) {
    return (
      <>
        <p className="mt-0.5">
          Approve the request with your passport, then come back here. This updates by
          itself once Self is done.
        </p>
        <button
          type="button"
          className="btn-soft btn-sm mt-3 bg-surface"
          onClick={() => window.open(url, "_blank")}
        >
          Open the Self app
        </button>
      </>
    );
  }

  return (
    <>
      <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
        <li>Copy the link below.</li>
        <li>Paste it into Chrome or Safari on this phone.</li>
        <li>Approve the request in the Self app.</li>
        <li>Come back here. This updates by itself.</li>
      </ol>
      <button type="button" className="btn-soft btn-sm mt-3 bg-surface" onClick={copy}>
        {copied ? "Link copied" : "Copy link"}
      </button>
    </>
  );
}
