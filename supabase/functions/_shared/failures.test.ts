/// Pins the failure classifier to the strings the executor actually writes.
///
/// The rules in `failures.ts` match text produced in `execute-due-runs` and
/// `cngn-webhook`, and neither of those files knows the classifier exists. So
/// a reworded failure reason would silently fall through to the generic
/// sentence — or, with a key present, start costing a Jev call per run. Every
/// reason below is copied verbatim from the code that emits it.
///
/// Runs with no TYPESAFE_API_KEY, which is also the point: the rules path is
/// what senders see when Jev is unavailable, unaffordable, or not yet granted.
///
///   deno test --allow-env supabase/functions/_shared/failures.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { classifyReason } from "./failures.ts";

/// [reason as emitted, expected category, where it comes from]
const EMITTED: Array<[string, string, string]> = [
  ["schedule completed its final run", "completed", "execute-due-runs prepare()"],
  ["not due on-chain", "not_due", "execute-due-runs prepare()"],
  ["sender funding wallet is short", "wallet_short", "execute-due-runs prepare()"],
  ["sender allowance revoked or too low", "allowance_short", "execute-due-runs prepare()"],
  ["amount exceeds backend cap of 1000 USDT", "over_cap", "execute-due-runs prepare()"],
  ["amount exceeds backend cap of 1500000 wARS", "over_cap", "execute-due-runs prepare()"],
  [
    "funding asset 0xabc is not in the backend token list",
    "other",
    "execute-due-runs prepare()",
  ],
  ["pool impact 172bps exceeds limit", "pool_thin", "execute-due-runs prepare()"],
  [
    "swap output 400000 is below cNGN's 1 naira minimum",
    "below_min_naira",
    "execute-due-runs settle()",
  ],
  [
    "cNGN redemption address 0xabc does not match the sender-authorised destination 0xdef; " +
    "the sender must re-authorise",
    "destination_mismatch",
    "execute-due-runs settle()",
  ],
  ["recipient bank account not verified", "bank_unverified", "execute-due-runs bankDetails()"],
  ["cNGN 429: rate limited (retryable)", "cngn_failed", "execute-due-runs describe()"],
  [
    "cNGN redemption failed (insufficient liquidity) — cNGN may be stranded at the redemption address",
    "cngn_failed",
    "cngn-webhook transaction.failed",
  ],
  [
    "run reverted on-chain in 0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72",
    "reverted",
    "receipt.ts runOutcome()",
  ],
  [
    "run 0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72 mined without a RunExecuted for schedule 2",
    "other",
    "receipt.ts runOutcome()",
  ],
  [
    "run transaction 0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72 was never mined",
    "interrupted",
    "recovery.ts decide()",
  ],
  ["abandoned before sending", "interrupted", "recovery.ts decide()"],
  [
    "not sent: could not record the transaction first (connection reset)",
    "interrupted",
    "execute-due-runs settle()",
  ],
];

for (const [reason, expected, source] of EMITTED) {
  Deno.test(`${expected} ← ${source}`, async () => {
    const out = await classifyReason(reason);
    assertEquals(out.category, expected, `"${reason}" should classify as ${expected}`);
    assertEquals(out.source, "rules", "a reason we write ourselves must not need a model");
  });
}

Deno.test("an unknown reason falls through to other, not to a wrong category", async () => {
  // A contract revert we have never seen. With no key this is where Jev would
  // have been asked; the sender gets the generic sentence and the raw reason.
  const out = await classifyReason("execution reverted: FloorNotMetForThisRun(uint256,uint256)");
  assertEquals(out.category, "floor_not_met");

  const nonsense = await classifyReason("upstream returned 502 from an unrelated service");
  assertEquals(nonsense.category, "other");
  assertEquals(nonsense.source, "none", "without a key there is nothing to ask");
});
