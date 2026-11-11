"use client";

import Link from "next/link";
import { useRewardCampaign } from "@/lib/hooks";
import { tokenFor } from "@/lib/config";
import { formatUnits } from "@/lib/format";
import { Icon } from "@/components/Icon";

/// The rules of the first-payment reward, in the words `pay-rewards` and
/// `_shared/rewards.ts` enforce. Change this page when either changes.
export default function RewardsPage() {
  const { data: c, isPending } = useRewardCampaign();
  const token = c ? tokenFor(c.token) : null;
  const amount = c && token ? `${formatUnits(c.amount_units, token.decimals)} ${token.symbol}` : "a reward";
  const left = c && c.cap !== null ? Math.max(0, c.cap - c.taken) : null;
  const open = Boolean(c?.active && left !== 0);

  return (
    <div className="mt-2 pb-10">
      <Link href="/" className="inline-flex items-center gap-1 text-[13px] text-ink-3">
        <Icon name="arrow_back" size={16} /> Home
      </Link>

      <h1 className="mt-4 font-display text-[30px] leading-tight text-ink">
        Your first payment gets {amount} back
      </h1>

      {!isPending && (
        <p className="mt-2 text-[14px] text-ink-2">
          {!c
            ? "There's no reward running right now."
            : !open
              ? c.active
                ? `All ${c.cap} places have been taken. Thank you to everyone who tried Remesso.`
                : "This reward has ended. Thank you to everyone who tried Remesso."
              : left === null
                ? "For everyone who makes their first payment, while the offer runs."
                : `For the first ${c.cap} people. ${left} places left.`}
        </p>
      )}

      <section className="mt-6">
        <h2 className="eyebrow">How to get it</h2>
        <ol className="mt-2 grid gap-2 text-[14px] text-ink-2">
          <li>1. Send any amount to someone else with Remesso, once or on a schedule.</li>
          <li>2. Once the payment has gone through on Celo, the reward is sent to the wallet you paid from, usually within half an hour.</li>
        </ol>
      </section>

      <section className="mt-6">
        <h2 className="eyebrow">The rules</h2>
        <ul className="mt-2 grid gap-2 text-[14px] text-ink-2">
          <li>One reward per person, not per wallet.</li>
          <li>
            You need to be verified as a person. In MiniPay your phone number already counts, so there&apos;s nothing
            more to do, though you can also verify with Self if you like. With MetaMask, Trust Wallet or another
            browser wallet, verify with the free Self passport check on the home screen, while connected with the
            wallet you pay from.
          </li>
          <li>The payment must actually go through, and to someone other than you.</li>
          <li>Money sent back and forth between the same two wallets doesn&apos;t count.</li>
          <li>Only payments made after the reward started count, while places are left.</li>
          <li>We can end the reward at any time. Places already taken are still paid.</li>
        </ul>
      </section>

      <Link href="/schedules/new" className="btn-primary mt-8 w-full">
        Send a payment
      </Link>
    </div>
  );
}
