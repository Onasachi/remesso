/// Durable progress for one wallet-funded payment. Never expire a key: forgetting
/// a creation transaction could create a second one-payment schedule on retry.
import type { Address, Hex } from "viem";

export type RemittanceStep = {
  hash: Hex;
  raw: Hex;
  nonce: number;
};

export type RemittanceRecord = {
  key: string;
  /** chainId:executor:signing wallet */
  scope: string;
  payer: Address;
  to: Address;
  token: Address;
  /** Recipient amount, gross debit and fee, in base units. */
  amount: string;
  amountIn: string;
  fee: string;
  feeBps: number;
  /** Cadence execution stays an hour away while the sender prepares and runs early. */
  firstRunAt: number;
  expiresAt: number;
  /** Optional hard deadline: the mandate expires before it. A retry cannot change it. */
  validUntil?: number;
  /** The allowance the approval sets: what was approved when it was signed, plus this payment. */
  approvalAmount?: string;
  /** The executor's allowance was already unlimited, so no approval was signed. */
  approvalSkipped?: true;
  createdAt: string;
  requestId?: string;
  requestBound?: boolean;
  approval?: RemittanceStep;
  creation?: RemittanceStep;
  execution?: RemittanceStep;
  /** Signed when the payment can't be completed, so the mandate can never pay later. */
  cancellation?: RemittanceStep;
  cancelReason?: string;
  scheduleId?: string;
  creationBlock?: string;
  paymentHash?: Hex;
  /// When it was first seen paid, or not paid for good.
  settledAt?: string;
};

export interface RemittanceStore {
  get(key: string, scope: string): Promise<RemittanceRecord | undefined>;
  /** Every retained record for this signer/deployment, including pending steps. */
  list(scope: string): Promise<RemittanceRecord[]>;
  /** Must durably save the complete record before resolving. */
  save(record: RemittanceRecord): Promise<void>;
}

export function memoryRemittanceStore(): RemittanceStore {
  const records = new Map<string, RemittanceRecord>();
  const id = (key: string, scope: string) => JSON.stringify([scope, key]);
  return {
    get: async (key, scope) => {
      const record = records.get(id(key, scope));
      return record ? structuredClone(record) : undefined;
    },
    list: async (scope) => [...records.values()].filter((record) => record.scope === scope).map((record) => structuredClone(record)),
    save: async (record) => { records.set(id(record.key, record.scope), structuredClone(record)); },
  };
}
