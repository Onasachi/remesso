export type PayoutKind = "direct" | "wallet" | "ngn_bank";

/// A numeric(78,0) column. PostgREST sends these as JSON numbers, not strings —
/// declaring them `string` is a lie TypeScript will happily propagate until
/// something does bigint arithmetic on one and throws at runtime.
export type Numeric = string | number;

export type Recipient = {
  id: string;
  sender_id: string;
  display_name: string;
  payout_type: PayoutKind;
  wallet_address: string | null;
  bank_code: string | null;
  account_number: string | null;
  account_name: string | null;
  bank_verified_at: string | null;
  /// Masked number the sender paid (MiniPay). Never the full number.
  phone_masked?: string | null;
  created_at: string;
};

export type ScheduleStatus =
  | "pending_authorization"
  | "active"
  | "paused"
  | "cancelled"
  | "completed";

export type Schedule = {
  id: string;
  sender_id: string;
  recipient_id: string;
  onchain_id: Numeric | null;
  /// Which executor deployment this schedule lives in. Ids are per-contract,
  /// so reading a V3 schedule's id against V4 returns a different sender's
  /// schedule — see the 20260915 migration.
  executor_address?: string | null;
  chain_id: number;
  authorized_tx_hash: string | null;
  amount_in: Numeric;
  interval_seconds: number;
  min_rate_e6: Numeric;
  token_address: string | null;
  max_runs: number;
  expires_at: string | null;
  next_run_at: string | null;
  status: ScheduleStatus;
  label: string | null;
  created_at: string;
  recipients?: Recipient | Recipient[] | null;
};

export type RunStatus =
  | "pending"
  | "swapping"
  | "delivered"
  | "redeeming"
  | "paid_out"
  | "failed"
  | "skipped";

export type Run = {
  id: string;
  schedule_id: string;
  attempt: number;
  status: RunStatus;
  amount_in: Numeric;
  amount_out: Numeric | null;
  quoted_rate_e6: Numeric | null;
  token_address?: string | null;
  min_out: string | null;
  tx_hash: string | null;
  block_number: number | null;
  cngn_trx_ref: string | null;
  cngn_deposit_address: string | null;
  redeemed_at: string | null;
  failure_reason: string | null;
  started_at: string;
  settled_at: string | null;
  reconcile_attempts?: number;
};

/// supabase-js types an embedded relation as an array regardless of the
/// relationship's actual cardinality.
export function one<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? rel[0] ?? null : rel;
}

/// An inbound request to be paid. Advisory: it prefills the create form and
/// can never create a schedule. Written by `request-payment`, read through the
/// `payment_requests_for` RPC.
export type PaymentRequest = {
  id: string;
  payer_address: string;
  to_address: string;
  amount: string | null;
  token_symbol: string | null;
  interval_seconds: number | null;
  max_runs: number | null;
  from_name: string | null;
  note: string | null;
  status: "pending" | "dismissed" | "used" | "declined";
  created_at: string;
};
