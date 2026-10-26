---
title: Build an agent-to-agent app
description: Discover a receiving agent, settle a fixed invoice from a wallet or a policy, and verify the payment before delivering a service.
---

Remesso is payment infrastructure your agents can build on. Your application decides what to buy and when to fulfill it. The SDK handles recipient discovery, remittances, request tracking and payment evidence. It works with any agent framework that can call TypeScript.

The APIs on this page are **unreleased 0.3.0-rc.1 source changes**. The published npm package remains 0.2.0 until the next release. Use a local build to evaluate them. For Postgres coordination, signed invoices, lifecycle recovery, quotes, managed signers and local development, follow [the production SDK guide](./production-sdk.md).

## Choose the funding source

| Funding | Whose funds move | Setup | Remesso fee |
|---|---|---|---|
| `wallet` | The paying agent's own wallet | Fund the agent with a supported token and gas | The V5 schedule fee, currently 0.25%, included in the gross debit |
| `policy` | A treasury or person's wallet | The owner creates a policy naming the agent's separate key | No protocol fee on policy payments |

Both use an explicit recipient amount: `amount: "1"` asks for 1 token to arrive. Wallet funding uses a one-payment V5 mandate and the sender executes it immediately with `runNow`. The mandate's `maxRuns: 1` caps it even if Remesso's regular executor wins the race. It remains visible to the existing indexer, invoice binding and signed webhooks.

Wallet sends currently need three transactions: mandate creation, approval and execution. The SDK checks the pinned terms before approving. The default regular due time is an hour ahead while the sender's authorized early execution runs immediately. An explicit intent deadline shortens the mandate's lifetime and, when needed, its first regular slot. They follow the V5 token/run limits. Policy payments follow their policy's caps instead. Both payer agents need local signing accounts, including supported sign-only managed accounts. The recipient needs no gas to receive tokens.

## Create the clients

Keep the payment journals across process restarts. The file adapters below support one process per signer and file. Multiple workers should use the [Postgres journals and signer coordinator](./production-sdk.md#share-journals-and-signer-coordination).

```ts
import { createRemesso } from "remesso-sdk";
import { fileRemittanceStore, fileStore, safeFetchText } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const buyer = createRemesso({
  account: privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`),
  store: fileStore("./state/policy-payments.json"),
  remittanceStore: fileRemittanceStore("./state/wallet-remittances.json"),
  fetchText: safeFetchText,
});
const seller = createRemesso({
  account: privateKeyToAccount(process.env.SELLER_KEY as `0x${string}`),
});
```

The default stores are memory only. Deleting a journal removes its retry protection. Neither store is a business-order database.

## Request one exact payment

The seller asks the wallet that will fund the payment. For `wallet`, that is the buyer agent's address. For `policy`, it is the policy owner's address, which differs from the agent signing the transaction.

```ts
const invoice = await receiver.requests.create({
  payer: "0x1111111111111111111111111111111111111111",
  amount: "1",
  token: "USDT",
  runs: 1,
  from: "Translation agent",
  note: "Translate order 1042",
});
console.log(invoice.id, invoice.reference);
```

This backend request moves no money and does not authenticate the seller. Use [signed invoices](./production-sdk.md#sign-an-invoice-and-verify-settlement) when the payer needs proof of the recipient's signature. Your application must approve the order and recipient. This one-off API requires fixed amount/token terms and rejects recurring invoices. Use [schedules](./schedules.md) for subscriptions and recurring remittances.

## Pay from the agent's own wallet

```ts
const sent = await agent.remittances.send({
  funding: "wallet",
  to: "0x2222222222222222222222222222222222222222",
  amount: "1",
  token: "USDT",
  requestId,
  idempotencyKey: `request:${requestId}`,
});
console.log(sent.status, sent.hash);
```

The invoice must name this paying wallet and these exact recipient/amount/token terms. A pending result can include approval or creation hashes before a payment hash exists. A creation hash is never evidence that the recipient was paid. Retry with the same funding model, signer, key and terms; the wallet journal keeps the same one-payment mandate.

V5 pins its fee when the mandate is created. The SDK checks the pinned terms before approving or executing and attempts a durably recorded cancellation on a mismatch. Repeating the same key resumes that cancellation. Inspect `cancellationConfirmed` and the reported cancellation hash on a conflict: a pending cancellation is uncertain. The contract does not take an expected-fee parameter, so fee changes during creation cannot be atomically excluded by an SDK quote, especially if a payer already has sufficient allowance and cancellation cannot be confirmed. Check the returned evidence rather than assuming a quote settled an invoice.

## Pay from a delegated policy

The treasury or person creates a policy once using [agent payments](./agent-payments.md). Then the worker agent can settle the invoice:

```ts
const sent = await agent.remittances.send({
  funding: "policy",
  policyId,
  to: "0x2222222222222222222222222222222222222222",
  amount: "1",
  token: "USDT",
  requestId,
  idempotencyKey: `request:${requestId}`,
});
console.log(sent.status, sent.payer);
```

The SDK checks the invoice against the policy owner's address. It refuses a second policy payment when the invoice already has a schedule. The allowance contract enforces per-payment and fixed-window daily caps, recipients and expiry. Its token approval is shared across the owner's policies; there is no per-policy lifetime cap.

## Pay a registered agent

Use `agents.pay` when the seller publishes an ERC-8004 identity and a supported [Remesso payee profile](./find-agents.md). The wallet comes from the registry. The SDK checks the accepted Celo token, required invoice reference, invoice recipient and a fresh wallet read immediately before sending. It does not use addresses embedded in profile JSON.

```ts
const paid = await agent.agents.pay(9867n, {
  funding: "wallet",
  requestId,
  expectedWallet: "0x2222222222222222222222222222222222222222",
});
console.log(paid.counterparty, paid.status, paid.hash);
```

For delegated funding, choose `funding: "policy"` and optionally `policyId`. An invoice supplies the amount/token and defaults the key to `request:<id>`. Without an invoice, supply `amount`, `token` and `idempotencyKey`; the profile must permit payments without a request reference. `expectedWallet` pins the counterparty your application approved. Identity resolution is a point-in-time read, not an atomic registry lock.

## Verify before fulfilling

A seller can verify without a private key, webhook subscription or Remesso's indexer:

```ts
import { createRemesso } from "remesso-sdk";

const reader = createRemesso();
const proof = await reader.receipts.verify({
  txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  token: "USDT",
  amount: "1",
  scheduleId,
  finality: "finalized",
});
console.log(proof.eventId, proof.amount, proof.finality);
```

For a policy payment, use `policyId` and `memo: invoice.reference` instead of `scheduleId`. The verifier checks the original successful receipt, canonical block, matching event, immutable payer/recipient/token terms and requested finality. Schedule amounts are net after fees. Historical checks need an RPC that serves state at the receipt block. Finalized verification fails closed when the RPC cannot report finality.

Persist `proof.eventId` as a unique value in the same database transaction that records fulfillment. Invoice authentication and one-time fulfillment remain your application's responsibility. A valid payment event must not fulfill two orders. `included` evidence can be reorganized; `finalized` waits for stronger chain evidence by refusing until the block is finalized.

Use [events](./payment-events.md) or [webhooks](./webhooks.md) to wake the receiver, then verify the exact expected terms. `requests.waitUntilPaid` reports indexed payment evidence; it is not a substitute for checking the exact amount and identity yourself.

## Run the buyer/seller example

The repository includes `examples/agent-to-agent.ts`, using the same public SDK APIs. Run it from the repository root:

```bash
deno run --allow-all --config examples/sdk.deno.json --unstable-sloppy-imports examples/agent-to-agent.ts request
deno run --allow-all --config examples/sdk.deno.json --unstable-sloppy-imports examples/agent-to-agent.ts pay
deno run --allow-all --config examples/sdk.deno.json --unstable-sloppy-imports examples/agent-to-agent.ts verify
```

- `request`: set `SELLER_KEY`, `PAYER_ADDRESS`, `AMOUNT`, optionally `TOKEN`. It creates an invoice and prints `REQUEST_ID`.
- `pay`: set `BUYER_KEY`, `FUNDING=wallet|policy`, `REQUEST_ID`, `SELLER_ADDRESS`, `AMOUNT`, optionally `TOKEN` and `SELLER_AGENT_ID`. Policy funding also needs `POLICY_ID`. It previews by default; add `--send` to sign and broadcast. Optional `POLICY_STORE`/`WALLET_STORE` paths locate persistent journals.
- `verify`: set `TX_HASH`, `PAYER_ADDRESS`, `SELLER_ADDRESS`, `AMOUNT`, `TOKEN`, and `SCHEDULE_ID` or `POLICY_ID`. Policy verification also uses `REQUEST_ID` for its memo. It requires finality unless `FINALITY=included` is explicit.

These commands use Celo mainnet unless `RPC_URL` points to a local fork. Keep keys out of source control.
