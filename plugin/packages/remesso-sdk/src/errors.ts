/// Every refusal the SDK makes is a `RemessoError` with a code, so a caller can
/// tell "you asked for something that would never run" from "the network is
/// down" without reading the message.
export type RemessoErrorCode =
  /** The input is wrong: an address that isn't one, an unknown token, an amount out of range. */
  | "invalid"
  /** The RPC isn't Celo mainnet, so nothing is signed. */
  | "wrong_chain"
  /** A write needs an account and none was given. */
  | "no_account"
  /** The contract or Remesso's backend would refuse it: caught before anything was sent. */
  | "refused"
  /** Already done or taken: a subscription that exists, a request already answered, a nonce already spent. */
  | "conflict"
  /** Mined, and reverted: nothing moved. */
  | "reverted"
  /** No gas: neither CELO nor a token that can pay for it. */
  | "no_gas"
  /** An idempotency key already used for a different payment. */
  | "key_reused"
  /** An identical payment went out minutes ago and no idempotency key was given. */
  | "repeat"
  /** A Remesso endpoint answered with an error. */
  | "http"
  /** Not found: a request, a schedule, a subscription. */
  | "not_found"
  /** Waited, and it didn't happen in time. */
  | "timeout";

export class RemessoError extends Error {
  readonly code: RemessoErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: RemessoErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RemessoError";
    this.code = code;
    this.details = details;
  }
}
