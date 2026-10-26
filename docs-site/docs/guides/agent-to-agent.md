---
title: Build an agent-to-agent app
description: "One agent asks another to pay, gets paid from a wallet or a spending policy, and checks the payment on the chain before it delivers."
---

One agent sells a service and another buys it. The seller asks to be paid, the buyer pays from its own wallet or from a spending policy a person gave it, and the seller checks the payment on the chain before it delivers. This guide builds both sides.

The APIs on this page need `remesso-sdk` 0.3.0 or later.

## Two ways to fund a payment

| Funding | Whose money moves | Setup | Remesso's fee |
|---|---|---|---|
| `wallet` | The buying agent's own wallet | The agent holds the token and a little CELO for gas | 0.25%, added to what the buyer pays, so the seller receives the exact amount |
| `policy` | A person's or a treasury's wallet | Its owner creates a [spending policy](./agent-payments.md) that names the agent | None |

In both, `amount` is what the seller receives: `amount: "1"` with `token: "USDT"` delivers exactly 1 USDT.

A wallet payment is a [schedule](./schedules.md) with a single payment. The SDK creates it, approves the token and runs it at once: three transactions, about 370,000 gas together. A policy payment is one transaction, about 90,000 gas. Remesso indexes both, so requests, events and webhooks treat them the same way.

## Create the clients

```ts
import { createRemesso } from "remesso-sdk";
import { fileRemittanceStore, fileStore, safeFetchText } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

// The buying agent. Its journals record each payment before it is sent, so a
// retry after a crash or a timeout never pays twice.
const buyer = createRemesso({
  account: privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`),
  store: fileStore("./state/policy-payments.json"),
  remittanceStore: fileRemittanceStore("./state/wallet-payments.json"),
  fetchText: safeFetchText,
});

// The selling agent.
const seller = createRemesso({
  account: privateKeyToAccount(process.env.SELLER_KEY as `0x${string}`),
});
```

Keep the journal files. Without them the SDK keeps its records in memory, and a retry after a restart could pay a second time. Each file serves one process. For several workers, see [sharing journals across workers](./production-sdk.md#share-journals-across-workers).

## 1. The seller asks to be paid

The seller asks the wallet whose money will move: the buyer's own address for wallet funding, or the policy owner's address for policy funding.

```ts
const invoice = await seller.requests.create({
  payer: buyer.address,
  amount: "1",
  token: "USDT",
  runs: 1,
  from: "Translation agent",
  note: "Translate order 1042",
});
const requestId = invoice.id;
```

A request moves no money, and anyone can create one. When the buyer needs proof that the seller asked, use a [signed invoice](./production-sdk.md#sign-an-invoice) instead. Recurring requests are for [schedules](./schedules.md); `remittances.send` pays one-off requests only.

## 2. The buyer pays from its own wallet

```ts
const sent = await buyer.remittances.send({
  funding: "wallet",
  to: seller.address,
  amount: "1",
  token: "USDT",
  requestId,
  idempotencyKey: `request:${requestId}`,
});
console.log(sent.status, sent.stage, sent.hash);
```

The request must name this wallet as the payer and these exact terms. A `confirmed` result carries `hash`, the transaction that paid.

A `pending` result may still be paid. Call `send` again with the same key and terms, at any time: the SDK continues the same payment from its journal and never creates a second one. Don't retry a pending payment under a new key; that is a second payment. `stage` says where it stands: `creation`, `approval`, `execution` or `cancellation`.

If the payment can't be completed, for instance because the wallet's balance dropped, the SDK cancels its schedule, so that it can't be paid later either. Only once the cancellation has landed does it report that nothing was paid: a `refused` error whose `details.cancelled` is `true`. Until then the result is `pending`, with a `cancellationHash`.

## 3. Or the buyer pays from a spending policy

The person or treasury creates a policy once, as in [agent payments](./agent-payments.md), and the request names that owner as the payer:

```ts
const sent = await buyer.remittances.send({
  funding: "policy",
  policyId,
  to: seller.address,
  amount: "1",
  token: "USDT",
  requestId,
  idempotencyKey: `request:${requestId}`,
});
console.log(sent.status, sent.payer); // payer is the policy's owner
```

The payment carries the request's reference in its memo, which is how Remesso knows it answers this request. The contract enforces the policy's caps per payment and per day, its recipient list and its expiry.

## Pay a registered agent

When the seller has an ERC-8004 identity with a Remesso payee profile (see [finding agents](./find-agents.md)), `agents.pay` takes the wallet to pay from the registry:

```ts
declare const sellerAgentId: bigint; // the seller's ERC-8004 id
const paid = await buyer.agents.pay(sellerAgentId, {
  funding: "wallet",
  requestId,
  expectedWallet: seller.address,
});
console.log(paid.counterparty, paid.status, paid.hash);
```

The SDK checks the token the profile accepts, the request reference it requires and that the request pays the registered wallet, then reads the registry again just before it sends. With `expectedWallet`, it refuses if the registered wallet isn't the one your application approved. It never takes a wallet from the profile's JSON.

Without a request, pass `amount`, `token` and an `idempotencyKey` instead; the profile must accept payments without a reference. For a policy, set `funding: "policy"` and optionally `policyId`.

## 4. The seller checks the payment before it delivers

Checking a payment needs no key, no webhook and nothing from Remesso's indexer:

```ts
declare const txHash: `0x${string}`;
const proof = await reader.receipts.verify({
  txHash,
  from: buyer.address,
  to: seller.address,
  token: "USDT",
  amount: "1",
  scheduleId,
  finality: "finalized",
});
console.log(proof.eventId, proof.amount, proof.finality);
```

`verify` reads the transaction's receipt and checks that it holds a payment of exactly this token and amount, from this payer to this recipient, made by Remesso's contracts, in a block that is still on the chain. A schedule's amounts are what arrived, after the fee. For a policy payment, pass `policyId` and `memo` instead of `scheduleId`.

With `finality: "finalized"` it also refuses until Celo has finalized the block, about 25 minutes after the payment. `included` answers at once, but a payment that is only included can still be undone by a reorganization.

Before delivering, store `proof.eventId` under a unique constraint, in the same database transaction that marks the order fulfilled, so one payment can never fulfil two orders.

[Payment events](./payment-events.md) and [webhooks](./webhooks.md) tell you when to check: something arrived. `verify` tells you it is the payment you expect.

## Run the example

The repository's `examples/agent-to-agent.ts` runs both sides from the command line:

```bash
deno run --allow-all --config examples/sdk.deno.json --unstable-sloppy-imports examples/agent-to-agent.ts request
deno run --allow-all --config examples/sdk.deno.json --unstable-sloppy-imports examples/agent-to-agent.ts pay
deno run --allow-all --config examples/sdk.deno.json --unstable-sloppy-imports examples/agent-to-agent.ts verify
```

- `request`, as the seller: set `SELLER_KEY`, `PAYER_ADDRESS` and `AMOUNT`, and optionally `TOKEN`. It prints the `REQUEST_ID`.
- `pay`, as the buyer: set `BUYER_KEY`, `FUNDING` (`wallet` or `policy`), `REQUEST_ID`, `SELLER_ADDRESS` and `AMOUNT`, and optionally `TOKEN` and `SELLER_AGENT_ID`. Policy funding also needs `POLICY_ID`. It shows what it would do; add `--send` to pay. `POLICY_STORE` and `WALLET_STORE` set where the journals live.
- `verify`, as the seller: set `TX_HASH`, `PAYER_ADDRESS`, `SELLER_ADDRESS`, `AMOUNT`, `TOKEN`, and `SCHEDULE_ID` or `POLICY_ID` (with `REQUEST_ID` for the memo). It waits for finality unless you set `FINALITY=included`.

The example pays on Celo mainnet unless `RPC_URL` points at a local fork.
