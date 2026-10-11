"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { parseEventLogs } from "viem";
import { wagmiConfig } from "@/lib/wagmi";
import { txOverrides } from "@/lib/tx";
import { DescribeSchedule, tokenFromSymbol } from "@/components/DescribeSchedule";
import type { Draft } from "@/lib/ai";
import { erc20Abi, executorAbi, PayoutType } from "@/lib/abi";

/// V4 takes a payout asset and a trigger grant at consent. Direct converts
/// nothing, and nobody may trigger a schedule unless its sender says so, so
/// both default to the zero address.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
import {
  CNGN,
  CNGN_REDEMPTION_ADDRESS,
  EXECUTOR_ADDRESS,
  USDT,
  isConfigured,
  type TokenInfo,
} from "@/lib/config";
import { supabase, ensureSender } from "@/lib/supabase";
import { useAllowance, useFeeBps, useMarketRate, useTriggerAddress, useUsdtBalance } from "@/lib/hooks";
import { everyLabel, formatUnits, rateToNairaPerUsd, spanLabel } from "@/lib/format";
import {
  RecipientStep,
  emptyRecipient,
  recipientIsComplete,
  type RecipientDraft,
} from "@/components/RecipientStep";
import {
  TermsStep,
  amountInUnits,
  defaultTerms,
  expiryProblem,
  triggerProblem,
  type TermsDraft,
} from "@/components/TermsStep";
import { ActionBar, Amount, MINIPAY_DEPOSIT_URL, Row } from "@/components/ui";
import { useIsMiniPay } from "@/lib/hooks";
import { runsToCover } from "@/lib/allowance";
import { isEmptyPayLink, parsePayLink, type PayLink } from "@/lib/payLink";
import { UnusualCheck } from "@/components/UnusualCheck";
import { isAddress } from "viem";

const STEPS = ["Who", "How much", "Review"] as const;

/// What the sender is waiting on while `authorise` runs. Each `busy` string
/// maps to one of these so the screen shows where they are in the sequence,
/// not just that something is happening.
const PHASES = [
  { key: "Preparing", label: "Saving the details" },
  { key: "Approve", label: "Allow it in your wallet" },
  { key: "Sign", label: "Sign the authorisation" },
  { key: "Confirming", label: "Confirming on the network" },
] as const;

export default function NewSchedulePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const inMiniPay = useIsMiniPay();

  const [step, setStep] = useState(0);
  const [recipient, setRecipient] = useState<RecipientDraft>(emptyRecipient);
  const [terms, setTerms] = useState<TermsDraft>(defaultTerms);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /// What a `?to=…` link filled in, kept so the form can say so. Silently
  /// prefilled money fields are how a link becomes a trick.
  const [fromLink, setFromLink] = useState<PayLink | null>(null);

  // Direct schedules move the recipient's chosen asset; the swap rails always
  // move USDT, whatever the recipient ends up holding.
  const fundingToken: TokenInfo = recipient.payoutType === "direct" ? recipient.token : USDT;
  const converts = recipient.payoutType !== "direct";
  const amountIn = amountInUnits(terms, fundingToken.decimals);
  const { data: allowance } = useAllowance(fundingToken.address);
  const { data: feeBps } = useFeeBps();
  const { data: balance } = useUsdtBalance(fundingToken.address);
  const market = useMarketRate(amountIn ?? 0n);

  // Sized to this schedule's own life — its transfer count, its expiry, or a
  // year of its rhythm, whichever comes first. One approval then lasts the
  // schedule out instead of running dry every few runs, which is the only way
  // to spare this audience a second one: MiniPay cannot sign messages, so
  // permit-style approvals are unavailable and each one costs a transaction.
  const runs = runsToCover({
    intervalSeconds: terms.intervalSeconds,
    maxRuns: terms.maxRuns ? Number(terms.maxRuns) : 0,
    expiresAtMs: terms.expiresAt ? Date.parse(`${terms.expiresAt}T23:59:59Z`) : null,
  });
  const requiredAllowance = amountIn ? amountIn * BigInt(runs) : 0n;
  // Always approve, and approve what is already there PLUS this schedule's
  // share. `approve` replaces the allowance rather than adding to it, and the
  // old `allowance < required` test let a new schedule quietly borrow the
  // headroom an existing one was counting on — or, when it did approve, set
  // the total to this schedule's need alone and strand every other schedule
  // on the same asset. Both ended with active schedules skipping every run.
  const needsApproval = allowance !== undefined && requiredAllowance > 0n;

  // Why Continue is disabled, said out loud. A greyed button with no reason
  // is the most common way a form loses someone.
  const blocker =
    step === 0
      ? !recipient.displayName.trim()
        ? "Give them a name to continue"
        : recipient.payoutType !== "ngn_bank" && !isAddress(recipient.walletAddress)
          ? inMiniPay
            ? "Find their MiniPay number to continue"
            : "Enter their wallet address to continue"
          : recipient.payoutType === "ngn_bank" && !recipientIsComplete(recipient)
            ? "Verify the bank account to continue"
            : null
      : step === 1
        ? !amountIn
          ? "Enter an amount to continue"
          : expiryProblem(terms) ?? triggerProblem(terms)
        : null;
  const canContinue = blocker === null;

  // A "pay me here" link, applied once on arrival.
  //
  // Read from `window.location` rather than `useSearchParams` because that
  // hook opts the route into a Suspense boundary at build time, and this is
  // one read of a value that never changes while the page is open.
  //
  // It only ever fills EMPTY fields. A sender who has started typing is
  // answering the question themselves, and a link that overwrites them is a
  // link editing a payment while they look at it.
  useEffect(() => {
    const link = parsePayLink(window.location.search);
    if (isEmptyPayLink(link)) return;
    setFromLink(link);
    setRecipient((r) => ({
      ...r,
      payoutType: "direct",
      displayName: r.displayName || link.name || "",
      walletAddress: isAddress(r.walletAddress) ? r.walletAddress : link.to ?? r.walletAddress,
      token: link.token ?? r.token,
    }));
    setTerms((t) => ({
      ...t,
      amount: t.amount || link.amount || "",
      intervalSeconds: link.intervalSeconds ?? t.intervalSeconds,
      maxRuns: link.maxRuns ?? t.maxRuns,
    }));
  }, []);

  // The phase list and any error render at the foot of the page, under the
  // action bar on a short screen. Bring them into view so a wallet prompt or
  // a rejection is never something the sender has to scroll to discover.
  useEffect(() => {
    if (busy || error) window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }, [busy, error]);

  if (!isConfigured()) {
    return <div className="notice-warn mt-2">The executor contract address is not configured.</div>;
  }
  if (!isConnected) {
    return <div className="notice-warn mt-2">Connect your wallet to create a schedule.</div>;
  }

  /// Apply an assistant draft over both steps.
  ///
  /// Only fields the assistant resolved are written; a null means it declined
  /// to guess, and overwriting a value the sender already typed with a blank
  /// would be worse than leaving it. The token is resolved from its symbol
  /// against DIRECT_TOKENS rather than trusting an address from the model.
  function applyDraft(d: Draft, phone: string | null) {
    const token = tokenFromSymbol(d.token);
    setRecipient((r) => ({
      ...r,
      payoutType: "direct",
      displayName: d.recipientName ?? r.displayName,
      ...(phone
        ? // A number in the sentence: clear whatever was found before and let
          // the phone field look this one up.
          { walletAddress: "", phoneMasked: "", fromContact: false, phoneTyped: phone, phoneAutoFind: r.phoneAutoFind + 1 }
        : {
            walletAddress: d.destination ?? r.walletAddress,
            // A drafted address replaces whatever number was found for it.
            phoneMasked: d.destination ? "" : r.phoneMasked,
            fromContact: d.destination ? false : r.fromContact,
          }),
      // MiniPay offers only its own three; a drafted USA₮ or wARS is dropped.
      token: token && (!inMiniPay || token.miniPayVisible) ? token : r.token,
    }));
    setTerms((t) => ({
      ...t,
      amount: d.amount ?? t.amount,
      intervalSeconds: d.intervalSeconds ?? t.intervalSeconds,
      maxRuns: d.maxRuns != null ? String(d.maxRuns) : t.maxRuns,
    }));
  }

  async function authorise() {
    setError(null);
    if (!amountIn || !address) return;

    // A Direct schedule converts nothing, so it carries no floor.
    const floorE6 = converts
      ? (market.rateE6 ? (market.rateE6 * BigInt(100 - terms.floorPercent)) / 100n : null)
      : 0n;
    if (floorE6 === null) {
      setError("Could not read a live rate from the pool. Try again in a moment.");
      return;
    }

    const destination =
      recipient.payoutType === "ngn_bank"
        ? (CNGN_REDEMPTION_ADDRESS as `0x${string}`)
        : (recipient.walletAddress as `0x${string}`);

    if (!destination) {
      setError("No destination address. Bank payouts are not configured.");
      return;
    }

    try {
      setBusy("Preparing");
      const senderId = await ensureSender(address);
      const sb = supabase();

      // Written before the transaction, deliberately. If the sender signs and
      // then closes the tab, the bank details and the policy still exist and
      // the schedule can be reconciled from `schedulesOf(address)`. The row is
      // inert until `onchain_id` is set, and `due_schedules` skips it.
      const { data: recipientRow, error: rErr } = await sb
        .from("recipients")
        .insert({
          sender_id: senderId,
          display_name: recipient.displayName.trim(),
          payout_type: recipient.payoutType,
          wallet_address:
            recipient.payoutType === "ngn_bank" ? null : recipient.walletAddress.toLowerCase(),
          bank_code: recipient.payoutType === "ngn_bank" ? recipient.bankCode : null,
          account_number: recipient.payoutType === "ngn_bank" ? recipient.accountNumber : null,
          account_name: recipient.payoutType === "ngn_bank" ? recipient.accountName : null,
          phone_masked: recipient.payoutType === "ngn_bank" ? null : recipient.phoneMasked || null,
          bank_verified_at:
            recipient.payoutType === "ngn_bank" ? new Date().toISOString() : null,
        })
        .select("id")
        .single();
      if (rErr) throw new Error(rErr.message);

      const expiresAt = terms.expiresAt
        ? BigInt(Math.floor(new Date(`${terms.expiresAt}T23:59:59Z`).getTime() / 1000))
        : 0n;

      const { data: scheduleRow, error: sErr } = await sb
        .from("schedules")
        .insert({
          sender_id: senderId,
          recipient_id: recipientRow.id,
          // Schedule ids are per-contract, so a row is only identified by the
          // pair. Without this a redeploy collides with the old contract's ids.
          executor_address: EXECUTOR_ADDRESS,
          token_address: fundingToken.address,
          amount_in: amountIn.toString(),
          interval_seconds: terms.intervalSeconds,
          min_rate_e6: floorE6.toString(),
          max_runs: terms.maxRuns ? Number(terms.maxRuns) : 0,
          expires_at: terms.expiresAt ? new Date(`${terms.expiresAt}T23:59:59Z`).toISOString() : null,
          status: "pending_authorization",
          label: recipient.displayName.trim(),
        })
        .select("id")
        .single();
      if (sErr) throw new Error(sErr.message);

      if (needsApproval) {
        setBusy("Approve");
        const approveHash = await writeContractAsync({
          address: fundingToken.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [EXECUTOR_ADDRESS, (allowance ?? 0n) + requiredAllowance],
          ...txOverrides(),
        });
        setBusy("Approve");
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash });
      }

      setBusy("Sign");
      const hash = await writeContractAsync({
        address: EXECUTOR_ADDRESS,
        abi: executorAbi,
        functionName: "createSchedule",
        args: [
          destination,
          amountIn,
          BigInt(terms.intervalSeconds),
          floorE6,
          terms.maxRuns ? Number(terms.maxRuns) : 0,
          expiresAt,
          terms.startNow ? 0n : BigInt(Math.floor(Date.now() / 1000) + terms.intervalSeconds),
          recipient.payoutType === "direct"
            ? PayoutType.Direct
            : recipient.payoutType === "wallet"
              ? PayoutType.Wallet
              : PayoutType.BankRedemption,
          fundingToken.address,
          // V4 consent values. The swap rails pay out in cNGN; Direct converts
          // nothing and the contract zeroes this itself.
          recipient.payoutType === "direct" ? ZERO_ADDRESS : CNGN.address,
          // The sender's grant, if they made one. Empty is the default and
          // means only the cadence ever runs this schedule.
          (terms.trigger.trim() || ZERO_ADDRESS) as `0x${string}`,
          terms.trigger.trim() ? Number(terms.triggersLeft) : 0,
        ],
        ...txOverrides(),
      });

      setBusy("Confirming");
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, confirmations: 1 });

      // The id comes from the event, not from a return value: a transaction's
      // return data is not available to a wallet, only its logs are.
      const [created] = parseEventLogs({
        abi: executorAbi,
        eventName: "ScheduleCreated",
        logs: receipt.logs,
      });
      if (!created) throw new Error("Transaction confirmed but no ScheduleCreated event was found");

      const onchainId = created.args.id.toString();

      setBusy("Confirming");
      const { error: uErr } = await sb
        .from("schedules")
        .update({
          onchain_id: onchainId,
          authorized_tx_hash: hash,
          status: "active",
          next_run_at: terms.startNow
            ? new Date().toISOString()
            : new Date(Date.now() + terms.intervalSeconds * 1000).toISOString(),
        })
        .eq("id", scheduleRow.id);
      if (uErr) throw new Error(uErr.message);

      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      router.push(`/schedules/${scheduleRow.id}?created=1`);
    } catch (e) {
      setError(friendly((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  const phase = busy ? PHASES.findIndex((p) => p.key === busy) : -1;

  return (
    <div className="pb-bar">
      <Progress step={step} />

      <div key={step} className="animate-rise mt-6">
        {step === 0 && (
          <>
            {/* Said before the fields, not after: the sender should know the
                recipient was handed to them before they read it, so they check
                it against who they think they are paying rather than skimming
                a value that looks like their own work. */}
            {fromLink && (
              <div className="notice-info mb-4">
                <p className="font-medium">A payment link filled this in.</p>
                <p className="mt-1 text-sm">
                  {fromLink.note
                    ? `"${fromLink.note}" — check the address below is who you mean to pay.`
                    : "Check the address below is who you mean to pay. Nothing is sent until you sign."}
                </p>
              </div>
            )}
            <DescribeSchedule onDraft={applyDraft} phoneMode={inMiniPay} />
            <RecipientStep value={recipient} onChange={setRecipient} />
          </>
        )}
        {step === 1 && (
          <TermsStep value={terms} onChange={setTerms} token={fundingToken} converts={converts} />
        )}
        {step === 2 && (
          <Review
            recipient={recipient}
            terms={terms}
            amountIn={amountIn}
            token={fundingToken}
            converts={converts}
            marketRateE6={market.rateE6}
            requiredAllowance={requiredAllowance}
            allowanceRuns={runs}
            feeBps={feeBps}
            balance={balance}
            inMiniPay={inMiniPay}
          />
        )}
      </div>

      {busy && (
        <ol className="notice-info mt-4 space-y-2" aria-live="polite">
          {PHASES.map((p, i) => {
            // The approval phase only exists when one is needed; hide it
            // rather than show a step that will be skipped.
            if (p.key === "Approve" && !needsApproval) return null;
            const state = i < phase ? "done" : i === phase ? "now" : "later";
            return (
              <li key={p.key} className={`flex items-center gap-2.5 ${state === "later" ? "text-ink-3" : "text-ink"}`}>
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                    state === "done"
                      ? "bg-naira text-surface"
                      : state === "now"
                        ? "bg-clay text-surface animate-pulse2"
                        : "border border-line"
                  }`}
                  aria-hidden
                >
                  {state === "done" ? "✓" : ""}
                </span>
                {p.label}
              </li>
            );
          })}
        </ol>
      )}

      {error && (
        <div className="notice-danger mt-4 animate-rise" role="alert">
          {error}
        </div>
      )}

      <ActionBar note={!busy && blocker ? blocker : undefined}>
        {step > 0 && (
          <button className="btn-ghost px-4" disabled={Boolean(busy)} onClick={() => setStep(step - 1)} aria-label="Back">
            Back
          </button>
        )}
        {step < 2 ? (
          <button
            className="btn-primary flex-1"
            disabled={!canContinue}
            onClick={() => {
              setStep(step + 1);
              window.scrollTo({ top: 0 });
            }}
          >
            Continue
          </button>
        ) : (
          <button className="btn-primary flex-1" disabled={Boolean(busy)} onClick={authorise}>
            {busy ? "Working…" : needsApproval ? "Allow & authorise" : "Authorise"}
          </button>
        )}
      </ActionBar>
    </div>
  );
}

/// Three thin segments and a sentence. It reads at a glance on a 360px screen,
/// where a row of labelled pills wraps.
function Progress({ step }: { step: number }) {
  return (
    <div className="mt-1">
      <div className="flex gap-1.5" aria-hidden>
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors duration-500 ${
              i <= step ? "bg-clay" : "bg-line"
            }`}
          />
        ))}
      </div>
      <p className="mt-2.5 text-[13px] text-ink-2">
        Step {step + 1} of {STEPS.length}
        <span className="text-ink-3"> · </span>
        <span className="font-medium text-ink">{STEPS[step]}</span>
      </p>
    </div>
  );
}

function Review({
  recipient,
  terms,
  amountIn,
  token,
  converts,
  marketRateE6,
  requiredAllowance,
  allowanceRuns,
  feeBps,
  balance,
  inMiniPay,
}: {
  recipient: RecipientDraft;
  terms: TermsDraft;
  amountIn: bigint | null;
  token: TokenInfo;
  converts: boolean;
  marketRateE6?: bigint;
  requiredAllowance: bigint;
  allowanceRuns: number;
  /// Undefined while the contract has not answered. Shown only when it has:
  /// a fee line that guesses is worse than no fee line.
  feeBps?: number;
  balance?: bigint;
  inMiniPay: boolean;
}) {
  const floorE6 = converts && marketRateE6
    ? (marketRateE6 * BigInt(100 - terms.floorPercent)) / 100n
    : undefined;
  const short = balance !== undefined && amountIn !== null && balance < amountIn;
  const isBank = recipient.payoutType === "ngn_bank";
  const { data: triggerAddress } = useTriggerAddress();

  return (
    <div>
      {/* The headline: the number and the person. Everything below is detail. */}
      <div className="rounded-2xl bg-clay-soft/70 px-5 py-6">
        <p className="eyebrow text-clay-deep">{everyLabel(terms.intervalSeconds)}</p>
        <Amount
          value={amountIn ? formatUnits(amountIn, token.decimals) : "—"}
          unit={token.symbol}
          size="hero"
          className="mt-2"
        />
        <p className="mt-3 text-[16px] text-ink">
          to <span className="font-medium">{recipient.displayName}</span>
        </p>
        <p className="text-[13px] text-ink-2">
          {isBank
            ? `${recipient.accountName} · ${recipient.accountNumber}`
            : converts
              ? "Converted to cNGN in their wallet"
              : recipient.phoneMasked
                ? `As ${token.symbol}, to the MiniPay account on ${recipient.phoneMasked}`
                : `As ${token.symbol}, straight to their wallet`}
        </p>
      </div>

      <dl className="mt-2 divide-y divide-line/70 px-1">
        {converts && (
          <Row
            label="Rate floor"
            sub={`${terms.floorPercent}% below today. A run below this is skipped, never forced.`}
          >
            {floorE6 ? `₦${rateToNairaPerUsd(floorE6).toFixed(0)} per USDT` : "—"}
          </Row>
        )}
        {feeBps !== undefined && feeBps > 0 && amountIn !== null && (
          <Row
            label="Remesso fee"
            sub={`${(feeBps / 100).toFixed(2)}% per transfer, fixed for this schedule. They receive ${
              formatUnits(amountIn - (amountIn * BigInt(feeBps)) / 10_000n, token.decimals)
            } ${token.symbol}.`}
          >
            {formatUnits((amountIn * BigInt(feeBps)) / 10_000n, token.decimals)} {token.symbol}
          </Row>
        )}
        {terms.trigger.trim() && (
          <Row
            label="Can send early"
            sub={`Up to ${terms.triggersLeft} ${
              terms.triggersLeft === "1" ? "transfer" : "transfers"
            }, brought forward. Same amount, same person, and you can withdraw it any time.`}
          >
            {/* A name when we are the one being allowed, the address when it is
                somebody else. Showing hex to a sender who never typed any is
                asking them to verify a string they have no way to check. */}
            {triggerAddress && terms.trigger.toLowerCase() === triggerAddress.toLowerCase()
              ? "Remesso"
              : (
                <span className="mono text-[13px]">
                  {terms.trigger.slice(0, 6)}…{terms.trigger.slice(-4)}
                </span>
              )}
          </Row>
        )}
        <Row label="Transfers">{terms.maxRuns || "Until you stop it"}</Row>
        <Row label="First one">{terms.startNow ? "Right away" : `In ${spanLabel(terms.intervalSeconds)}`}</Row>
        <Row label="Expires">{new Date(`${terms.expiresAt}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</Row>
        <Row
          label="You allow"
          sub={`Enough for ${allowanceRuns === 1 ? "this transfer" : `${allowanceRuns} transfers`} — the rest of this schedule. Added to what you have already allowed, so your other schedules keep theirs.`}
        >
          {formatUnits(requiredAllowance, token.decimals)} {token.symbol}
        </Row>
      </dl>

      <UnusualCheck
        // Only a dollar token's amount is a dollar amount. For wFIAT the
        // check stays silent rather than judge pesos on a dollar scale.
        amountUsd={amountIn && token.currency === "USD" ? Number(formatUnits(amountIn, token.decimals)) : null}
        recipientAddress={recipient.payoutType === "ngn_bank" ? null : recipient.walletAddress}
        accountNumber={recipient.payoutType === "ngn_bank" ? recipient.accountNumber : null}
        howOften={intervalName(terms.intervalSeconds)}
        transfers={terms.maxRuns ? Number(terms.maxRuns) : null}
        startsNow={terms.startNow}
      />

      {short && (
        <div className="notice-warn mt-3 flex items-center justify-between gap-3">
          <span>
            You hold {formatUnits(balance!, token.decimals)} {token.symbol} — less than one
            transfer. Runs will be skipped until you top up.
          </span>
          {inMiniPay && (
            <a href={MINIPAY_DEPOSIT_URL} className="btn-ink btn-sm shrink-0">
              Add money
            </a>
          )}
        </div>
      )}

      <p className="mt-4 px-1 text-[13px] leading-relaxed text-ink-2">
        Signing fixes the person, the amount, the rhythm{converts ? " and the floor rate" : ""} on
        Celo. Remesso can only trigger a run inside those limits — it cannot change any of
        them, and it cannot send anywhere else.
      </p>
    </div>
  );
}

/// Wallet errors are long and mostly internal. Surface the part a sender can
/// act on and keep the rest in the console.
/// The contract's own complaint, in words a sender can act on.
///
/// Keyed off the custom error NAME, which viem only produces because the error
/// entries are in `executorAbi`. Anything unmapped falls through with the raw
/// name still attached, so a new error is never silently swallowed.
const CONTRACT_ERRORS: Record<string, string> = {
  TokenNotAllowed:
    "That asset is not enabled for direct transfers. Choose one of the assets offered.",
  WrongTokenForPayoutType:
    "Converted payouts are funded in USDT only. Either fund this schedule with USDT, or switch the recipient to a direct transfer to send USDC or USDm as-is.",
  ScheduleExpired: "Pick an expiry date in the future.",
  ScheduleLifetimeTooLong: "A schedule can run for at most one year. Pick an earlier expiry date.",
  InvalidDestination: "That recipient address cannot receive payments.",
  InvalidAmount: "Enter an amount greater than zero.",
  InvalidInterval: "Pick a frequency between one second and one year.",
  InvalidRate: "Could not read a live rate from the pool. Try again in a moment.",
  DegenerateFloor:
    "This amount is too small to protect with a floor rate. Increase the amount.",
  ScheduleInactive: "That schedule has already finished.",
  ScheduleIsCancelled: "That schedule was cancelled.",
  NotScheduleOwner: "This schedule belongs to a different wallet.",
};

function friendly(msg: string): string {
  if (/User rejected|User denied/i.test(msg)) return "You cancelled the signature.";
  // MiniPay's copy rules: "network fee", never "gas", and never name CELO —
  // fee abstraction means a user has no reason to know CELO exists.
  if (/insufficient funds/i.test(msg)) return "Not enough funds to cover the network fee.";
  if (/duplicate key|unique/i.test(msg)) return "That wallet is already registered in another session.";

  for (const [name, text] of Object.entries(CONTRACT_ERRORS)) {
    if (msg.includes(name)) return text;
  }
  // An unmapped custom error still names itself rather than vanishing into a
  // generic "reverted" with nothing after it.
  const custom = msg.match(/reverted with the following reason:\s*\n?\s*(\w+)/);
  if (custom) return `The contract rejected this: ${custom[1]}.`;

  return msg.split("\n")[0].slice(0, 300);
}

/// The names `risk_check` validates against on the server. Kept here rather
/// than derived from a label, so a wording change in the picker cannot quietly
/// start failing validation.
function intervalName(seconds: number): string {
  return {
    300: "5 minutes",
    604800: "weekly",
    1209600: "fortnightly",
    2592000: "monthly",
    7776000: "quarterly",
  }[seconds] ?? "monthly";
}
