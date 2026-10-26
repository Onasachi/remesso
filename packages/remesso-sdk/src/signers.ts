/// A managed signer supplies signatures while the SDK retains simulation,
/// nonce coordination, durable signed bytes and broadcast/recovery ownership.
import { fromRlp, hashMessage, hashTypedData, keccak256, padHex, recoverAddress, sliceHex, verifyMessage, verifyTypedData, type Hex, type SignableMessage, type Signature, type TransactionSerializable, type TypedDataDefinition } from "viem";
import { toAccount, type CustomSource, type LocalAccount } from "viem/accounts";
import { parseTransaction, serializeTransaction } from "viem/celo";
import { CHAIN_ID, checksum } from "./deployment.js";
import { RemessoError } from "./errors.js";

export type ManagedTransaction = Parameters<typeof serializeTransaction>[0];
export type ManagedTransactionRequest = {
  /** Immutable copy of the transaction viem prepared, including its nonce and fees. */
  transaction: ManagedTransaction;
  /** Exact unsigned Celo serialization whose keccak256 is signed. */
  serialized: Hex;
  hash: Hex;
  /** Pass this serializer to a viem-compatible provider to preserve CIP-64 feeCurrency. */
  serializer: typeof serializeTransaction;
};
export type ManagedTypedDataRequest = { typedData: TypedDataDefinition; hash: Hex };
export type ManagedMessageRequest = { message: SignableMessage; hash: Hex };
export type ManagedSignerOptions = {
  address: string;
  /** Return signed transaction bytes; this callback MUST NOT broadcast them. */
  signTransaction(request: ManagedTransactionRequest): Promise<Hex>;
  signTypedData(request: ManagedTypedDataRequest): Promise<Hex>;
  /** Optional. Missing personal-message signing fails clearly. */
  signMessage?(request: ManagedMessageRequest): Promise<Hex>;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) frozen(nested);
    Object.freeze(value);
  }
  return value;
}
function failed(reason: string): never { throw new RemessoError("refused", `managed signer ${reason}`); }

/**
 * Adapt a custody service, wallet service or other callback signer to viem.
 * Supports Celo legacy, EIP-2930, EIP-1559 and CIP-64 transactions. A provider
 * returning changed fields or another account's signature is refused before
 * the SDK can record or broadcast it. Provider callbacks must be sign-only.
 */
export function managedSigner(options: ManagedSignerOptions): LocalAccount {
  const address = checksum(options.address);
  if (typeof options.signTransaction !== "function" || typeof options.signTypedData !== "function") failed("requires transaction and typed-data callbacks");
  const source: CustomSource = {
    address,
    async signTransaction(transaction, opts) {
      const tx = structuredClone(transaction) as ManagedTransaction;
      if (tx.chainId !== CHAIN_ID) throw new RemessoError("wrong_chain", `managed signer only signs Celo mainnet (${CHAIN_ID}) transactions`);
      if (tx.type && !["legacy", "eip2930", "eip1559", "cip64"].includes(tx.type)) failed(`does not support transaction type ${tx.type}`);
      if (tx.nonce === undefined || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0) failed("requires an explicit nonnegative transaction nonce");
      const serialized = serializeTransaction(tx);
      if (opts?.serializer && !same(await opts.serializer(transaction), serialized)) failed("received a serializer that does not match Celo transaction encoding");
      const hash = keccak256(serialized);
      const raw = await options.signTransaction({ transaction: frozen(tx), serialized, hash, serializer: serializeTransaction });
      if (typeof raw !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(raw)) failed("returned malformed signed transaction bytes");
      let signature: Signature;
      try {
        const parsed = parseTransaction(raw as Parameters<typeof parseTransaction>[0]);
        const { r, s, v, yParity, ...unsigned } = parsed as ManagedTransaction & { r?: Hex; s?: Hex; v?: bigint; yParity?: number };
        if (!same(serializeTransaction(unsigned), serialized)) failed("changed the transaction's chain, destination, calldata, amount, nonce or fees");
        if (raw.startsWith("0x7b")) {
          // viem 2.57.7's official Celo parser validates the CIP-64 payload
          // but omits its signature. Decode only the final signature fields
          // with viem's RLP codec; use its Celo serializer for the actual hash.
          const fields = fromRlp(sliceHex(raw, 1), "hex");
          if (!Array.isArray(fields) || fields.length !== 13) failed("returned an unsigned CIP-64 transaction");
          const [parity, cipR, cipS] = fields.slice(10);
          if ((parity !== "0x" && parity !== "0x01") || typeof cipR !== "string" || typeof cipS !== "string" || cipR === "0x" || cipS === "0x") failed("returned an invalid CIP-64 signature");
          signature = { r: padHex(cipR as Hex, { size: 32 }), s: padHex(cipS as Hex, { size: 32 }), yParity: parity === "0x" ? 0 : 1 };
        } else {
          if (!r || !s || (yParity !== 0 && yParity !== 1 && v === undefined)) failed("returned an unsigned transaction");
          signature = { r, s, ...(v === undefined ? {} : { v }), ...(yParity === undefined ? {} : { yParity }) } as Signature;
        }
        if (!same(serializeTransaction(unsigned, signature), raw)) failed("returned noncanonical signed transaction bytes");
      } catch (error) {
        if (error instanceof RemessoError) throw error;
        failed("returned transaction bytes that cannot be verified");
      }
      if (!same(await recoverAddress({ hash, signature }), address)) failed("returned a transaction signed by a different account");
      return raw;
    },
    async signTypedData(typedData) {
      const copy = structuredClone(typedData) as TypedDataDefinition;
      if (copy.domain?.chainId !== undefined && Number(copy.domain.chainId) !== CHAIN_ID) throw new RemessoError("wrong_chain", "managed signer typed data names another chain");
      const signature = await options.signTypedData({ typedData: frozen(copy), hash: hashTypedData(copy) });
      let valid = false;
      try { valid = await verifyTypedData({ ...copy, address, signature }); } catch { /* fail below */ }
      if (!valid) failed("returned typed-data signed by a different account or for different terms");
      return signature;
    },
    async signMessage({ message }) {
      if (!options.signMessage) failed("does not support personal-message signing");
      const copy = structuredClone(message);
      const signature = await options.signMessage({ message: copy, hash: hashMessage(copy) });
      let valid = false;
      try { valid = await verifyMessage({ address, message, signature }); } catch { /* fail below */ }
      if (!valid) failed("returned a message signature for different terms or account");
      return signature;
    },
  };
  return toAccount(source);
}
