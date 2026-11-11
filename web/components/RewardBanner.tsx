"use client";

import Link from "next/link";
import { useState } from "react";
import { useIdentity, useMiniPayPhoneVerified, useMyReward, useRewardCampaign } from "@/lib/hooks";
import { tokenFor } from "@/lib/config";
import { formatUnits } from "@/lib/format";
import { Icon } from "./Icon";
import { Sheet } from "./ui";

/// The first-payment reward: one short line on the home screen, and the
/// details in a sheet when it is tapped. Once this wallet has earned one, the
/// line says where it stands instead. Nothing at all when there is no live
/// campaign, so ending one needs no deploy.
///
/// The sheet says how this wallet qualifies, from the same facts `pay-rewards`
/// reads: a MiniPay phone number (enough on its own; Self is optional), a live
/// Self check, or neither (verify with Self, the card just below this one).
export function RewardBanner() {
  const { data: c } = useRewardCampaign();
  const { data: mine } = useMyReward();
  const phone = useMiniPayPhoneVerified();
  const { data: identity } = useIdentity();
  const [open, setOpen] = useState(false);
  if (!c) return null;

  const token = tokenFor(c.token);
  const amount = `${formatUnits(c.amount_units, token.decimals)} ${token.symbol}`;

  if (mine) {
    const paid = mine.status === "paid";
    if (mine.status === "failed") return null;
    return (
      <div className="mt-3 flex min-h-11 items-center gap-2 rounded-xl bg-sand/70 px-4 py-2 text-[13px] text-ink-2">
        <Icon name={paid ? "check_circle" : "arrow_forward"} size={18} className="shrink-0 text-ink-3" />
        <span>{paid ? `You got ${amount} back for your first payment.` : `Your ${amount} is on its way.`}</span>
      </div>
    );
  }

  const left = c.cap === null ? null : Math.max(0, c.cap - c.taken);
  if (!c.active || left === 0) return null;

  // A test-key ("mock passport") check never earns the reward.
  const selfVerified = identity?.verified?.environment === "live";
  const qualifies = selfVerified || phone === true;
  const status =
    phone === undefined
      ? null
      : selfVerified
        ? "You're verified with Self, so you qualify."
        : phone
          ? "Your MiniPay number already counts, so you qualify. Verifying with Self is optional."
          : "First verify you're a person with Self. It's free and takes a minute with your passport.";

  const toVerify = () => {
    setOpen(false);
    document.getElementById("verify")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 flex min-h-11 w-full items-center gap-2 rounded-xl bg-sand/70 px-4 py-2 text-left text-[13px] text-ink-2"
      >
        <Icon name="paid" size={18} className="shrink-0 text-ink-3" />
        <span className="flex-1">
          Get <strong className="text-ink">{amount}</strong> back on your first payment
        </span>
        <Icon name="arrow_forward" size={16} className="shrink-0 text-ink-3" />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={`Get ${amount} back`}>
        <p className="text-[14px] text-ink-2">
          Send your first payment with Remesso and we send {amount} back to the wallet you paid from.
          {left !== null && ` ${left} of ${c.cap} places left.`}
        </p>

        {status && (
          <div className="mt-4 flex items-start gap-2 rounded-xl bg-sand/70 px-3 py-2.5 text-[13px] text-ink-2">
            <Icon
              name={qualifies ? "check_circle" : "verified_user"}
              size={18}
              className="mt-px shrink-0 text-ink-3"
            />
            <span>{status}</span>
          </div>
        )}

        <ol className="mt-4 grid gap-2 text-[14px] text-ink-2">
          <li>1. Send any amount to someone else, once or on a schedule.</li>
          <li>2. About half an hour after it goes through, {amount} lands in your wallet.</li>
        </ol>

        <p className="mt-3 text-[12px] text-ink-3">
          One per person.{" "}
          <Link href="/rewards" className="underline" onClick={() => setOpen(false)}>
            All the rules
          </Link>
        </p>

        <div className="mt-5 grid gap-2">
          {status && !qualifies ? (
            <button type="button" className="btn-primary w-full" onClick={toVerify}>
              Verify with Self
            </button>
          ) : (
            <Link href="/schedules/new" className="btn-primary w-full" onClick={() => setOpen(false)}>
              Send a payment
            </Link>
          )}
          <button type="button" className="btn-ghost w-full" onClick={() => setOpen(false)}>
            Not now
          </button>
        </div>
      </Sheet>
    </>
  );
}
