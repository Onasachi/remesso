/// What a sender is told when a transfer does not go through.
///
/// Remesso owns every sentence here. The backend classifies a raw reason into
/// one of these categories — by exact match where it wrote the string itself,
/// and by a Jev choice question only for reasons it has never seen — and this
/// file turns the category into words. Nothing a model writes is shown to a
/// sender about their money.
///
/// The raw reason is still rendered underneath, always. It is what actually
/// happened and what someone will quote when asking for help.

export type FailureCategory =
  | "completed"
  | "not_due"
  | "wallet_short"
  | "allowance_short"
  | "over_cap"
  | "pool_thin"
  | "floor_not_met"
  | "below_min_naira"
  | "destination_mismatch"
  | "bank_unverified"
  | "cngn_failed"
  | "reverted"
  | "interrupted"
  | "network_error"
  | "other";

export type FailureCopy = {
  title: string;
  detail: string;
  action: string | null;
  /// A skip that is the system working as agreed, not something gone wrong.
  expected?: boolean;
};

const COPY: Record<FailureCategory, FailureCopy> = {
  completed: {
    title: "All transfers sent",
    detail: "This schedule finished the transfers it was set up for. Nothing went wrong.",
    action: null,
    expected: true,
  },
  not_due: {
    title: "Not due yet",
    detail: "The next transfer has not come round yet. It will go at its usual time.",
    action: null,
    expected: true,
  },
  wallet_short: {
    title: "Not enough money in your wallet",
    detail:
      "There wasn’t enough to send this one, so it was skipped rather than sent short. The next one goes at its usual time.",
    action: "Add money, then it continues",
    expected: true,
  },
  allowance_short: {
    title: "Remesso isn’t allowed to send any more",
    detail:
      "The amount you allowed has run out, so this transfer was skipped. Your money never moved.",
    action: "Allow payments again to continue",
    expected: true,
  },
  over_cap: {
    title: "Above the safety limit",
    detail:
      "This transfer is larger than the ceiling Remesso applies to any single payment, so it was not sent.",
    action: "Contact support",
  },
  pool_thin: {
    title: "The rate was too poor right now",
    detail:
      "Converting this amount would have cost too much at this moment, so it was skipped instead of accepting a bad rate. It will be tried again.",
    action: null,
    expected: true,
  },
  floor_not_met: {
    title: "Below the rate you set",
    detail:
      "The rate was worse than the floor you signed, so nothing was sent. That is the floor doing its job.",
    action: null,
    expected: true,
  },
  below_min_naira: {
    title: "Too small to pay out in naira",
    detail: "This would convert to less than ₦1, which the payout partner cannot send.",
    action: "Raise the amount per transfer",
  },
  destination_mismatch: {
    title: "The payout account didn’t match",
    detail:
      "The payout partner returned a different address than the one you authorised, so Remesso stopped before spending anything. This needs a person to look at it.",
    action: "Contact support",
  },
  bank_unverified: {
    title: "The bank account isn’t confirmed",
    detail: "The recipient’s account details were never verified, so no payout was attempted.",
    action: "Check the recipient’s details",
  },
  cngn_failed: {
    title: "The payout partner could not pay out",
    detail:
      "The conversion happened but the naira payout did not complete. This needs a person to look at it.",
    action: "Contact support",
  },
  reverted: {
    title: "The network turned it down",
    detail:
      "The transfer was sent, but the network rejected it, usually because something changed in the seconds before it landed. Nothing left your wallet, and it will be tried again.",
    action: null,
  },
  interrupted: {
    title: "Stopped before it went out",
    detail:
      "Remesso stopped before this transfer was completed. Nothing left your wallet, and it will be tried again.",
    action: null,
  },
  network_error: {
    title: "The network didn’t accept it",
    detail:
      "This transfer could not be completed on the network. Nothing was taken from your wallet, and it will be tried again.",
    action: null,
    expected: true,
  },
  other: {
    title: "This transfer didn’t go through",
    detail: "Nothing was taken from your wallet. The details below are what happened.",
    action: null,
  },
};

export function failureCopy(category: string | null | undefined): FailureCopy {
  return COPY[(category ?? "other") as FailureCategory] ?? COPY.other;
}
