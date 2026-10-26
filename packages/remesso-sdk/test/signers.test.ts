import { assertEquals, assertRejects } from "@std/assert";
import { hashTypedData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { serializeTransaction } from "viem/celo";
import { EXECUTOR, token } from "../src/deployment.ts";
import { RemessoError } from "../src/errors.ts";
import { INVOICE_DOMAIN, INVOICE_TYPES } from "../src/invoices.ts";
import { managedSigner, type ManagedSignerOptions, type ManagedTransaction, type ManagedTransactionRequest } from "../src/signers.ts";
const remote = privateKeyToAccount(toHex(98501, { size: 32 })), other = privateKeyToAccount(toHex(98502, { size: 32 }));
const tx: ManagedTransaction = { chainId: 42220, type: "eip1559", nonce: 7, to: EXECUTOR, data: "0x1234", value: 0n,
  gas: 100_000n, maxFeePerGas: 50n, maxPriorityFeePerGas: 2n };
const typedData = { domain: INVOICE_DOMAIN, types: INVOICE_TYPES, primaryType: "Invoice" as const,
  message: { issuer: remote.address, payer: other.address, recipient: remote.address, token: token("USDT").address as Hex,
    amount: 1n, orderId: "order-17", nonce: toHex(17, { size: 32 }), issuedAt: 1n, expiresAt: 2n, requestId: "" } };
function provider(overrides: Partial<ManagedSignerOptions> = {}) {
  const requests: ManagedTransactionRequest[] = [];
  const account = managedSigner({ address: remote.address,
    signTransaction: async (request) => { requests.push(request); return await remote.signTransaction(request.transaction as never, { serializer: request.serializer } as never); },
    signTypedData: async ({ typedData }) => await remote.signTypedData(typedData),
    signMessage: async ({ message }) => await remote.signMessage({ message }), ...overrides,
  });
  return { account, requests };
}
Deno.test("managed signer adapts a sign-only viem-compatible provider with exact EIP-1559 bytes", async () => {
  const { account, requests } = provider();
  const signed = await account.signTransaction(tx);
  assertEquals(account.type, "local");
  assertEquals(signed, await remote.signTransaction(tx));
  assertEquals(requests[0].serialized, serializeTransaction(tx));
  assertEquals(requests[0].hash, keccak256(serializeTransaction(tx)));
  assertEquals(Object.isFrozen(requests[0].transaction), true);
});
Deno.test("managed signer preserves real Celo CIP-64 feeCurrency and recovers its signer", async () => {
  const { account, requests } = provider();
  const feeTx = { ...tx, type: "cip64" as const, feeCurrency: token("USDT").feeCurrency as Hex };
  const signed = await account.signTransaction(feeTx as never, { serializer: serializeTransaction } as never);
  assertEquals(signed.startsWith("0x7b"), true);
  assertEquals(signed, await remote.signTransaction(feeTx as never, { serializer: serializeTransaction } as never));
  assertEquals(requests[0].hash, keccak256(serializeTransaction(feeTx)));
});
Deno.test("managed signer supports tested EIP-155 legacy and EIP-2930 encodings", async () => {
  for (const transaction of [{ chainId: 42220, type: "legacy" as const, nonce: 0, to: EXECUTOR, gas: 21000n, gasPrice: 50n, value: 0n },
    { chainId: 42220, type: "eip2930" as const, nonce: 8, to: EXECUTOR, gas: 21000n, gasPrice: 50n, value: 1n, accessList: [] }]) {
    assertEquals(await provider().account.signTransaction(transaction), await remote.signTransaction(transaction));
  }
});
Deno.test("managed signer refuses provider changes to destination, data, nonce, chain, value and fee", async () => {
  for (const changed of [{ to: other.address }, { data: "0xabcd" as const }, { nonce: 9 }, { chainId: 1 }, { value: 1n }, { maxFeePerGas: 51n }]) {
    const { account } = provider({ signTransaction: async () => await remote.signTransaction({ ...tx, ...changed } as never) });
    assertEquals((await assertRejects(() => account.signTransaction(tx), RemessoError)).code, "refused");
  }
});
Deno.test("managed signer refuses CIP-64 fee currency substitution and other signer", async () => {
  const feeTx = { ...tx, type: "cip64" as const, feeCurrency: token("USDT").feeCurrency as Hex };
  for (const signTransaction of [async () => await remote.signTransaction({ ...feeTx, feeCurrency: token("USDC").feeCurrency } as never, { serializer: serializeTransaction } as never),
    async () => await other.signTransaction(feeTx as never, { serializer: serializeTransaction } as never)]) {
    await assertRejects(() => provider({ signTransaction }).account.signTransaction(feeTx as never, { serializer: serializeTransaction } as never), RemessoError);
  }
});
Deno.test("managed signer refuses unsigned bytes, malformed results and unsupported serializers", async () => {
  for (const raw of ["0x123", "0x", serializeTransaction(tx)]) {
    await assertRejects(() => provider({ signTransaction: async () => raw as Hex }).account.signTransaction(tx), RemessoError);
  }
  const { account, requests } = provider();
  await assertRejects(() => account.signTransaction(tx as never, { serializer: (() => "0x1234") as never }), RemessoError);
  assertEquals(requests.length, 0);
});
Deno.test("managed signer refuses wrong chains, absent nonces and unsupported transaction types before provider", async () => {
  const { account, requests } = provider();
  for (const changed of [{ chainId: 1 }, { nonce: undefined }, { nonce: -1 }, { type: "eip7702" }]) {
    await assertRejects(() => account.signTransaction({ ...tx, ...changed } as never), RemessoError);
  }
  assertEquals(requests.length, 0);
});
Deno.test("managed typed-data callback receives the exact hash and verifies returned terms and signer", async () => {
  let hash: Hex | undefined;
  const { account } = provider({ signTypedData: async (request) => { hash = request.hash; return await remote.signTypedData(request.typedData); } });
  assertEquals(await account.signTypedData(typedData), await remote.signTypedData(typedData));
  assertEquals(hash, hashTypedData(typedData));
  for (const callback of [async () => await other.signTypedData(typedData), async () => await remote.signTypedData({ ...typedData, message: { ...typedData.message, amount: 2n } })]) {
    await assertRejects(() => provider({ signTypedData: callback }).account.signTypedData(typedData), RemessoError);
  }
  await assertRejects(() => account.signTypedData({ ...typedData, domain: { ...typedData.domain, chainId: 1 } }), RemessoError);
});
Deno.test("managed personal messages are optional and verified before returning", async () => {
  const { account } = provider();
  assertEquals(await account.signMessage({ message: "hello" }), await remote.signMessage({ message: "hello" }));
  await assertRejects(() => provider({ signMessage: undefined }).account.signMessage({ message: "hello" }), RemessoError);
  await assertRejects(() => provider({ signMessage: async () => await remote.signMessage({ message: "other" }) }).account.signMessage({ message: "hello" }), RemessoError);
});
