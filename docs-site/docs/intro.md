---
slug: /
title: Introduction
description: What remesso-sdk is, what you can build with it, and how a payment moves from a signature to a webhook.
---

`remesso-sdk` is a TypeScript library for recurring and agent payments in stablecoins on Celo. A payer signs once, Remesso's executor sends each payment when it is due, and your server hears about each one from a signed webhook.

```bash
npm install remesso-sdk viem
```

## What you can build

- **Payments on a schedule.** A payer authorises a fixed amount to a fixed address on a fixed cadence: a monthly retainer, a weekly allowance, payroll, a remittance home. Remesso sends each payment when it is due. Nobody can change the recipient, the amount or the cadence afterwards; cancelling is the only edit.
- **Payments by an agent, within limits.** A person grants their AI agent's key a policy: one token, a cap per payment and per day, an expiry, optionally a list of the only recipients allowed. The agent pays from the person's wallet, and the contract refuses anything outside the policy. A payment retried with the same idempotency key pays once.
- **Getting paid.** Ask a wallet to pay you with a payment request, share a link that opens the payer's form filled in, and see when the payment arrives.
- **Knowing you were paid.** Payment events and signed webhooks tell you about every payment to an address, without running a node or an indexer.
- **Credit for the volume you bring.** Your own ERC-8021 builder code rides on every payment of the schedules your app creates.

## How a payment moves

```mermaid
sequenceDiagram
    autonumber
    participant P as Payer's wallet
    participant C as Remesso contract
    participant E as Remesso executor
    participant R as Recipient
    participant W as Your webhook
    P->>C: approve and createSchedule (signed once)
    loop each time a payment is due
        E->>C: executeRun(schedule)
        C->>R: the amount, less the 0.25% fee
        E-->>W: payment.received (signed)
    end
    Note over W: payment.finalized follows once Celo finalizes the block
```

The payer's signature is the authority. The contract checks every payment against what was signed: the recipient, the amount, the cadence, the number of payments and the expiry. Remesso's executor can only ask the contract to send a payment that is due; it cannot redirect one, enlarge one or send one early unless the payer allowed it.

## The building blocks

| | What it is | Who signs | Who pays gas |
|---|---|---|---|
| [Schedules](./guides/schedules.md) | A payer's standing instruction, held by the `RemessoExecutorV5` contract | The payer, once | The payer to create it, Remesso's executor for each payment |
| [Agent payments](./guides/agent-payments.md) | Spending limits a person grants an agent, held by `RemessoAgentAllowance` | The person for the policy, the agent for each payment | The agent |
| [Payment requests](./guides/payment-requests.md) | "Please pay me", with states, stored by Remesso's backend | Nobody: a request moves no money | Nobody |
| [Payment events](./guides/payment-events.md) and [webhooks](./guides/webhooks.md) | Every payment to or from an address, read from the chain by Remesso's indexer | Nobody | Nobody |

## Before you start

:::warning Real money, unaudited contracts
Remesso runs on Celo mainnet only: there is no testnet, so every example moves real money. The contracts are live and have not been audited by a person. Start with small amounts, a dollar rather than a payroll, and keys that hold only what you are willing to lose.
:::

- You need Node 20 or later, and a little USDT on Celo for your first payment.
- The SDK runs on a server or in a script with a private key. In a browser it works with the user's own wallet.
- Every payment Remesso sends is between the equivalent of 1 and 1,000 dollars. See [fees, limits and gas](./guides/fees-and-gas.md).

## Where to go next

- **[Quickstart](./quickstart.md):** send a payment and receive its webhook in about 15 minutes.
- **[Core concepts](./concepts.md):** schedules, the executor, policies, requests, events and finality.
- **[Use cases](./use-cases/index.md):** subscriptions, payroll, remittances, an allowance and an AI agent's budget, built end to end.
- **[API reference](./reference/client.md):** every option, method and return value.
