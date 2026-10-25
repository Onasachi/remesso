---
title: FAQ and troubleshooting
sidebar_label: FAQ
description: Answers to the questions developers ask most, and what to check when a payment doesn't arrive.
---

Short answers to common questions, then what to check when something doesn't happen.

## General

### Is there a testnet?

No. Remesso runs on Celo mainnet only. Test with small amounts: the smallest scheduled payment is 1 USDT, the fee comes out of it, and gas costs a fraction of a cent. Paying a second address of your own gets 0.9975 USDT back.

### Have the contracts been audited?

Not by a person. Both contracts are live, verified on Celoscan and covered by tests, but no independent audit has been done. Start small. See [security](./security.md).

### Does the recipient need gas, an account or any software?

No. Receiving needs only an address. The payer pays to create a schedule, and Remesso's executor pays the gas for each payment. You need the recipient's key only to sign as that address: to subscribe to webhooks, or to answer or decline a request.

### Does Remesso hold my funds?

No. The money stays in the payer's wallet until each payment, and each payment goes straight to the recipient. The payer's token approval and the schedule's terms bound what the contract can move.

### What does it cost?

0.25% of each scheduled payment, taken from the payment. Agent payments and receiving are free. Gas for creating a schedule is a fraction of a cent. See [fees, limits and gas](../guides/fees-and-gas.md).

### Can a payer pay in one currency and the recipient receive another?

No. A schedule pays out in the token it is funded in. For a recipient who wants local currency in a bank, they cash out the tokens they receive through a ramp such as Ripio's or Textile's, with their own wallet.

### Can I use the SDK in a browser?

Yes, with the user's wallet: pass a viem wallet client as `walletClient`. The user approves each transaction. Agent payments need a local account, so they belong on a server.

## Schedules

### Can I change a schedule's amount or recipient?

No. What the payer signed is fixed. Cancel the schedule and create a new one with the new terms.

### My schedule hasn't paid yet. Why?

Check these in order:

1. **Time.** A schedule created with the SDK is picked up within about 5 minutes, and the payment goes out within a minute of that. A trigger of `"remesso"` lets a payment be brought forward instead.
2. **Funding and approval.** `schedules.status(id)` tells you whether a payment is `due`, `funded` and `approved`. If the payer's balance or approval is below one payment, the executor waits until it isn't.
3. **The schedule itself.** `schedules.get(id)` shows whether it is `active`, `cancelled` or expired, and how many payments have run.
4. **The limits.** A payment outside the executor's per-payment limits never runs. The SDK refuses such a schedule, but one created without the SDK can still exist on-chain.

### What happens if the payer runs out of funds?

The payment waits. The executor tries again every minute while the payment is due, and sends it once the balance and approval cover it. Missed payments aren't sent in a burst afterwards: the next one is due one interval after the payment actually went out.

### Why did `schedules.create` refuse my schedule?

Its error message says which rule. The usual ones: an amount outside the [per-payment limits](../reference/tokens-and-limits.md), more payments than fit in a year at that cadence, a token not taken for new schedules, a first payment in the past, or a recipient that is your own wallet. See [errors](../reference/errors.md#refused).

## Payments and events

### When is a payment final?

When its block is at or below Celo's finalized block, about 25 to 30 minutes after it lands. Payment events carry a `final` flag, and webhooks send `payment.finalized`. For large amounts, act on finality.

### I got "hasn't been seen on-chain yet". What does it mean?

Remesso's backend couldn't see a schedule you had just created. Celo's public RPC is several nodes, and a read straight after a transaction can come from one that is a block behind. The SDK retries for up to 90 seconds. If you call the HTTP API yourself, retry after a few seconds.

### A balance or status read straight after a transaction looks stale.

The same cause: a lagging node. Read again a few seconds later, or read at the block of the transaction's receipt.

### An agent payment returned `pending`. What now?

Call `pay` again with the same idempotency key. It reports the first attempt's outcome and never pays twice. Never retry with a new key.

## Webhooks

### I receive the same delivery twice.

That is expected: delivery is at least once. Deduplicate on the `webhook-id` header, the same on every retry.

### My endpoint returns 503.

The handler has no signing secret yet. `subscribe` returns it once; pass it to `webhookHandler`, and store it if the server restarts.

### How do I stop deliveries?

`webhooks.revoke({ url })`. An address can hold five subscriptions.

## Still stuck?

The [errors reference](../reference/errors.md) lists every error code with what to do. The [source code](https://bitbucket.org/crackedstudios/remesso) and its example agents show complete programs.
