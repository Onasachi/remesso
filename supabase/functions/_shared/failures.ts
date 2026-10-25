/// What a failure reason means, as a category the frontend has a sentence for.
///
/// Split out of ai-assist so it can be tested against the exact strings the
/// executor writes: the rules below match text produced in execute-due-runs
/// and cngn-webhook, and nothing in either file knows this one exists.
/// `failures.test.ts` is what keeps them honest.
import { ask, decided, isConfigured as jevConfigured } from "./typesafe.ts";

/// Categories a failure can fall into. The frontend holds one curated sentence
/// per key (lib/failures.ts) — no model writes prose to a sender about their
/// money, which is the whole reason this replaced a free-text explanation.
///
/// Descriptions are written for Jev, and they are only consulted for reasons
/// the rules below do not already recognise.
export const CATEGORIES: Record<string, string> = {
  completed: "The schedule finished all the transfers it was set up for. Nothing went wrong.",
  not_due: "The transfer was not due to run yet.",
  wallet_short: "The sender's wallet did not hold enough of the funding token to cover the transfer.",
  allowance_short: "The spending allowance the sender granted is used up, revoked, or too low.",
  over_cap: "The amount is above a maximum limit the system applies to a single transfer.",
  pool_thin: "Converting the amount would move the market price too far; the trade was skipped as too expensive.",
  floor_not_met: "The exchange rate was worse than the minimum rate the sender agreed to.",
  below_min_naira: "The converted amount is below the payout partner's minimum of one naira.",
  destination_mismatch: "The payout address does not match the destination the sender authorised.",
  bank_unverified: "The recipient's bank account details were never verified.",
  cngn_failed: "The payout partner rejected or failed the naira payout, or its API returned an error.",
  reverted: "The transfer was sent to the blockchain and rejected there, after a check moments earlier said it would go through.",
  interrupted: "The payment system stopped before the transfer was sent, or the transaction it sent never landed.",
  network_error: "The blockchain transaction or network call failed, reverted, or timed out.",
  other: "None of the above describes this reason.",
};

/// Reasons this system writes itself, matched exactly. A model is not needed to
/// recognise a string we produced, and rules cost nothing, never drift and
/// cannot be unavailable — so Jev is asked only about the tail: contract
/// reverts, RPC errors and payout-partner messages we have never seen.
export const RULES: Array<[RegExp, string]> = [
  // From the receipt check (`receipt.ts`) and the stale-run recovery
  // (`recovery.ts`). First, because these carry a transaction hash, and a
  // reason should never be matched by accident on the letters of a hash.
  [/reverted on-chain/i, "reverted"],
  [/mined without a RunExecuted/i, "other"],
  [/was never mined|abandoned before sending|could not record the transaction first/i, "interrupted"],

  [/completed its final run|schedule completed/i, "completed"],
  [/not due/i, "not_due"],
  [/funding wallet is short|insufficient balance/i, "wallet_short"],
  [/allowance revoked or too low|allowance/i, "allowance_short"],
  [/exceeds backend cap/i, "over_cap"],
  [/not in the backend token list/i, "other"],
  [/pool impact|exceeds limit/i, "pool_thin"],
  [/floor|minRate|rate too low/i, "floor_not_met"],
  [/below cNGN's 1 naira minimum|naira minimum/i, "below_min_naira"],
  [/does not match the sender-authorised destination/i, "destination_mismatch"],
  [/bank account not verified/i, "bank_unverified"],
  [/^cNGN |redemption failed|stranded at the redemption address/i, "cngn_failed"],

  // Reverts from our own contract and the router, by name. These reach the
  // backend as a raw revert string, so before this they were the model's
  // guess — and measured against the live API on 2026-09-20 the guess was
  // wrong in exactly the way that matters: "transferFrom failed" (an
  // allowance or balance problem) came back as a network error, which would
  // have told a sender to wait for a retry that cannot help them.
  [/InsufficientOutput|SlippageBoundBelowFloor|DegenerateFloor|Too little received|InvalidRate/i, "floor_not_met"],
  [/transferFrom failed|\bSTF\b|transfer amount exceeds (balance|allowance)/i, "allowance_short"],
  [/ScheduleExpired|ScheduleInactive|ScheduleIsCancelled|RunCapReached/i, "completed"],
  [/NotDue/i, "not_due"],
  [/InvalidDestination|WrongTokenForPayoutType|TokenNotAllowed/i, "destination_mismatch"],
  [/NotExecutor|NotScheduleOwner|ZeroAddress|InvalidAmount|InvalidInterval/i, "other"],
];

/// Classify a failure reason. Rules first, Jev for the rest, `other` if neither
/// is sure — and `other` has its own honest sentence, so no answer is fine.
export async function classifyReason(reason: string) {
  for (const [re, category] of RULES) {
    if (re.test(reason)) return { category, source: "rules", confidence: 1 };
  }
  if (!jevConfigured()) return { category: "other", source: "none", confidence: 0 };

  const answers = await ask(
    { failure_reason: reason },
    {
      category: {
        type: "choice",
        instructions:
          "A scheduled stablecoin payment did not go through. `failure_reason` is the " +
          "message the payment system recorded. Which category does it describe?",
        criteria: CATEGORIES,
      },
    },
  );

  // Below 0.6 the sentence would be a guess about someone's money. The generic
  // copy plus the raw reason is the honest answer, and the raw reason shows
  // either way.
  const picked = decided(answers?.category, 0.6);
  return picked
    ? { category: picked.choice, source: "jev", confidence: picked.confidence }
    : { category: "other", source: "jev", confidence: answers?.category?.type === "choice" ? answers.category.confidence : 0 };
}
