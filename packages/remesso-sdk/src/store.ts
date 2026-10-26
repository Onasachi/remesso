/// Where agent payments are recorded, so a retry never pays twice.
///
/// An agent's call can time out after its transaction went out, and the agent
/// tries again. `pay()` on the contract checks nothing about repeats, so that
/// is a second payment inside every cap. Each payment is signed first and
/// recorded here, hash and signed bytes, before it is broadcast. A retry with
/// the same idempotency key finds the record and reports what became of the
/// first payment instead of making another.
///
/// The default store is memory, which covers retries inside one process. For
/// retries across restarts, which is when they matter most, use `fileStore`
/// from `remesso-sdk/node`, or your own database behind this interface.
import type { Address, Hex } from "viem";

export type PaymentRecord = {
  /// The caller's idempotency key; null when none was given.
  key: string | null;
  /// `chainId:contract:agent`, so another agent never inherits this payment's key.
  deployment: string;
  /// Whose policy funded it. Optional only for records written by older SDKs.
  owner?: Address;
  /** Optional application deadline for initiating/rebroadcasting this signed intent. */
  validUntil?: number;
  policyId: string;
  to: Address;
  units: string;
  token: Address;
  memo: Hex;
  hash: Hex;
  nonce: number;
  /// The signed transaction, so a record that never left can still go out
  /// with the same nonce: at most once, still.
  raw: Hex;
  status: "sent" | "confirmed" | "reverted" | "unsent" | "dropped";
  at: string;
};

export interface PaymentStore {
  /// The latest record for `key` in `deployment`.
  byKey(key: string, deployment: string): Promise<PaymentRecord | undefined>;
  /// Records newer than `since` (ms since the epoch).
  since(since: number): Promise<PaymentRecord[]>;
  /// Saves `rec`, replacing any record with its hash, or with its key in its
  /// deployment: a key has one record, the latest attempt.
  save(rec: PaymentRecord): Promise<void>;
}

/// Retention applies only to completed payments without an idempotency key.
/// Keys and unresolved signed transactions must survive every later save:
/// forgetting either would let a retry become another payment.
export const KEEP_MS = 30 * 86_400_000;
export const KEEP_COUNT = 1000;

/// Applies `save`'s replacement rule and the retention to a list.
export function upsert(list: PaymentRecord[], rec: PaymentRecord, now = Date.now()): PaymentRecord[] {
  const cutoff = now - KEEP_MS;
  const rest = list.filter((p) =>
    p.hash !== rec.hash && !(rec.key && p.key === rec.key && p.deployment === rec.deployment)
  );
  const all = [...rest, rec];
  const protectedRecord = (p: PaymentRecord) => p.key != null || !["confirmed", "reverted"].includes(p.status);
  const recent = new Set(all.filter((p) => !protectedRecord(p) && Date.parse(p.at) > cutoff).slice(-KEEP_COUNT));
  return all.filter((p) => protectedRecord(p) || recent.has(p));
}

export function memoryStore(): PaymentStore {
  let list: PaymentRecord[] = [];
  return {
    byKey: async (key, deployment) => [...list].reverse().find((p) => p.key === key && p.deployment === deployment),
    since: async (since) => list.filter((p) => Date.parse(p.at) > since),
    save: async (rec) => {
      list = upsert(list, rec);
    },
  };
}
