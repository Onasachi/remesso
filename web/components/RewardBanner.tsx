"use client";

import Link from "next/link";
import { useIdentity, useMiniPayPhoneVerified, useMyReward, useRewardCampaign } from "@/lib/hooks";
import { tokenFor } from "@/lib/config";
import { formatUnits } from "@/lib/format";
import { Icon } from "./Icon";

/// The first-payment reward, as one quiet row. It shows how many places are
/// left (a number that moves is the reason to act now), or, once this wallet
/// has earned one, where it stands. Nothing at all when there is no live
/// campaign, so ending one needs no deploy.
///
/// Under the offer, one line on how this wallet qualifies, from the same facts
/// `pay-rewards` reads: a MiniPay phone number (enough on its own; Self is
/// optional), a live Self check, or neither (verify with Self, the card just
/// below this one).
export function RewardBanner() {
  const { data: c } = useRewardCampaign();
  const { data: mine } = useMyReward();
  const phone = useMiniPayPhoneVerified();
  const { data: identity } = useIdentity();
  if (!c) return null;

  const token = tokenFor(c.token);
  const amount = `${formatUnits(c.amount_units, token.decimals)} ${token.symbol}`;

  if (mine) {
    const paid = mine.status === "paid";
    if (mine.status === "failed") return null;
    return (
      <div className="mt-3 flex min-h-11 items-center gap-2 rounded-xl bg-sand/70 px-4 py-2 text-[13px] text-ink-2">
        <Icon name={paid ? "check_circle" : "arrow_forward"} size={18} className="shrink-0 text-ink-3" />
        <span>
          {paid
            ? `You got ${amount} for your first payment. Thank you for trying Remesso.`
            : `Your ${amount} for your first payment is on its way.`}
        </span>
      </div>
    );
  }

  const left = c.cap === null ? null : Math.max(0, c.cap - c.taken);
  if (!c.active || left === 0) return null;

  // A test-key ("mock passport") check never earns the reward.
  const selfVerified = identity?.verified?.environment === "live";
  const how =
    phone === undefined
      ? null
      : selfVerified
        ? "You're verified with Self."
        : phone
          ? "Your MiniPay number already counts. Verifying with Self below is optional."
          : "Using MetaMask or another browser wallet? Verify with Self below first to get it.";

  return (
    <Link
      href="/rewards"
      className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-xl bg-sand/70 px-4 py-2 text-[13px] text-ink-2"
    >
      <span className="flex items-center gap-2">
        <Icon name="paid" size={18} className="shrink-0 text-ink-3" />
        <span>
          Your first payment gets <strong className="text-ink">{amount}</strong> back.{" "}
          {left !== null && <span className="text-ink-3">{left} of {c.cap} left.</span>}
          {how && <span className="mt-0.5 block text-[12px] text-ink-3">{how}</span>}
        </span>
      </span>
      <Icon name="chevron_right" size={18} className="shrink-0 text-ink-3" />
    </Link>
  );
}
