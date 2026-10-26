/** A lock covers the whole read/sign/journal/broadcast sequence for one signer.
 * Every worker using that signer must use the same coordinator and journals. */
export interface SignerLease {
  assertActive(): Promise<void>;
  readonly signal?: AbortSignal;
}
export interface SignerCoordinator {
  runExclusive<T>(scope: string, run: (lease: SignerLease) => Promise<T>): Promise<T>;
  /** Read the durable floor while holding this scope. Do not consume an unsigned nonce. */
  nextNonce?(scope: string, minimum: number): Promise<number>;
  /** Raise the durable nonce floor after signed bytes are saved. */
  noteNonce?(scope: string, used: number): Promise<void>;
  /** Persist generic write bytes and their nonce floor atomically before broadcast.
   * This reserves nonce evidence, not an application payment idempotency key. */
  recordSigned?(scope: string, transaction: { nonce: number; hash: `0x${string}`; raw: `0x${string}` }): Promise<void>;
}
