---
title: Subscriptions for your app
sidebar_label: Subscriptions
description: Bill each customer monthly in stablecoins, grant access when a payment arrives, and notice when a customer pauses or cancels.
---

You run a SaaS or an API product and want customers to pay monthly in stablecoins. Card-style billing, where you charge the customer, doesn't exist here: Remesso can't take money from anyone. Instead, each customer signs a mandate once: a fixed amount, to your address, every month, for a set number of payments. Remesso's executor then sends each payment when it's due. Your app asks for the mandate, then reacts to the payments.

## What you'll build

- **Checkout:** a payment request per customer, and the link that opens their Remesso form filled in.
- **A webhook** that grants access when a payment arrives, records it once it's final, and takes it back if a reorg undoes it.
- **A daily check** that notices a cancelled, paused or underfunded subscription. Webhooks announce payments only, so this is how you learn about everything else.

## What Remesso does and doesn't do

Be clear with yourself, and with your customers, about the model:

- **The customer is in control.** They can pause or cancel the schedule at any time, from the Remesso app or their own code. You can't charge them, extend the schedule or change its amount.
- **Terms are fixed at signing.** A new price means a new schedule: send a new request, and the customer cancels the old schedule (only they can).
- **A schedule has an end.** It lasts at most a year, so 12 monthly payments. Renew with a new request before the last one.
- **A month is 30 days.** Payment dates drift against calendar months by a day or so each month.
- **There are no refunds in the protocol.** A refund is a transfer you send yourself.
- **A late payment still goes out.** If a payment is due while the customer's wallet is short, or their approval is too low, it waits. It goes out once it can, as long as the schedule hasn't expired.

## Prerequisites

- The setup from [Installation](../installation.md), and a key for your app's receiving address. Receiving needs no gas and no balance. The key signs your webhook subscription and nothing else.
- A public HTTPS URL for the webhook. For a test, `cloudflared tunnel --url http://localhost:8787` prints one.
- Each customer needs USDT on Celo for each payment plus the 0.25% fee, and a little CELO to sign the schedule once.

```bash
export APP_KEY=0x… PUBLIC_URL=https://….trycloudflare.com
```

## Step 1: Ask at checkout

Create one request per customer, and keep its id next to the customer. The amount is what you receive each month: the customer's form adds the fee on top.

```ts title="checkout.ts"
import { createRemesso } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const app = createRemesso({
  account: privateKeyToAccount(process.env.APP_KEY as `0x${string}`),
});

/// At checkout: ask the customer's wallet to pay for the plan every month.
/// Returns the link to show them. It opens their Remesso form, filled in.
export async function startSubscription(customerId: string, customerWallet: string): Promise<string> {
  const req = await app.requests.create({
    payer: customerWallet,
    amount: "10", // USDT a month: what you receive
    token: "USDT",
    every: "month",
    runs: 12,
    from: "Example API", // up to 40 characters
    note: "Pro plan, billed monthly", // up to 120 characters
  });
  await saveSubscription({ customerId, requestId: req.id });
  return req.link;
}

async function saveSubscription(row: { customerId: string; requestId: string }): Promise<void> {
  // Your database: remember which request belongs to which customer.
}
```

The request also appears in the customer's Remesso inbox. A request stays open for 30 days, and a wallet can have at most 10 open requests at a time.

When the customer signs, the request reads `accepted`. Don't grant access yet: accepted isn't paid. Access follows the first payment.

## Step 2: Grant access on each payment

Each payment produces up to three deliveries to your webhook:

| Delivery | What your app does |
|---|---|
| `payment.received` | Grant access until the next payment is due, plus a grace period. |
| `payment.finalized` | Record the payment as final, for your accounts. It follows 25 to 30 minutes later. |
| `payment.removed` | Take that period's access back: a reorg undid the payment. This is rare. |

A delivery names the schedule, not the customer. The first time a schedule appears, find the request it answers, and remember the pairing.

```ts title="webhook.ts"
import { createServer } from "node:http";
import { createRemesso, webhookHandler, type WebhookMessage } from "remesso-sdk";
import { toNodeListener } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const app = createRemesso({
  account: privateKeyToAccount(process.env.APP_KEY as `0x${string}`),
});
const PERIOD_MS = 30 * 86_400_000; // a Remesso month is 30 days
const GRACE_MS = 3 * 86_400_000;

async function onPayment(m: WebhookMessage) {
  if (!m.data.schedule || (await alreadyHandled(m.id))) return; // retries reuse the webhook-id
  const customerId = await customerFor(m.data.schedule);
  if (!customerId) return; // a payment that isn't a subscription
  if (m.type === "payment.received") {
    await grantAccess(customerId, new Date(Date.parse(m.data.blockTime) + PERIOD_MS + GRACE_MS));
  } else if (m.type === "payment.finalized") {
    await recordFinal(customerId, m.data.txHash);
  } else {
    await revokePayment(customerId, m.data.txHash);
  }
  await markHandled(m.id);
}

/// Which customer a schedule pays for, found once through the request it answers.
async function customerFor(scheduleId: string): Promise<string | null> {
  for (const sub of await openSubscriptions()) {
    if (sub.scheduleId === scheduleId) return sub.customerId;
    if (sub.scheduleId) continue;
    const r = await app.requests.get(sub.requestId);
    if (r.payment?.schedule?.id === scheduleId) {
      await saveScheduleId(sub.customerId, scheduleId);
      return sub.customerId;
    }
  }
  return null;
}

// Your database and your app. These stand in for them.
async function openSubscriptions(): Promise<{ customerId: string; requestId: string; scheduleId?: string }[]> {
  return [];
}
async function saveScheduleId(customerId: string, scheduleId: string): Promise<void> {}
async function grantAccess(customerId: string, until: Date): Promise<void> {}
async function recordFinal(customerId: string, txHash: string): Promise<void> {}
async function revokePayment(customerId: string, txHash: string): Promise<void> {}
async function alreadyHandled(webhookId: string): Promise<boolean> {
  return false;
}
async function markHandled(webhookId: string): Promise<void> {}

let secret = process.env.WEBHOOK_SECRET; // saved from the first subscribe
const handler = webhookHandler({ recipient: app.address, secret: () => secret, onPayment });
createServer(toNodeListener(handler)).listen(8787);

if (!secret) {
  secret = (await app.webhooks.subscribe({ url: process.env.PUBLIC_URL! })).secret;
  console.log("Store this signing secret as WEBHOOK_SECRET:", secret);
}
```

If `onPayment` throws, the handler answers 500 and Remesso retries with the same `webhook-id` for 24 hours. That makes an outage of your database safe: nothing is lost, it just arrives later.

## Step 3: Check each subscription daily

Webhooks tell you about payments, not about a customer pausing or cancelling. Read each schedule from the contract once a day. Reading needs no key.

```ts title="check.ts"
import { createRemesso } from "remesso-sdk";

const reader = createRemesso(); // reading schedules needs no key

type State = "active" | "payment waiting" | "paused" | "cancelled" | "completed";

/// What a customer's schedule says now, read from the contract.
async function stateOf(scheduleId: string): Promise<State> {
  const [s, run] = await Promise.all([reader.schedules.get(scheduleId), reader.schedules.status(scheduleId)]);
  if (s.cancelled) return "cancelled";
  // The contract turns `active` off on the last payment too, so count first.
  if (s.runsExecuted >= s.maxRuns || s.expiresAt < new Date()) return "completed";
  if (!s.active) return "paused";
  if (run.due && !(run.funded && run.approved)) return "payment waiting";
  return "active";
}

for (const sub of await subscriptionsWithSchedules()) {
  const state = await stateOf(sub.scheduleId);
  if (state !== "active") await tellCustomer(sub.customerId, state);
}

// Your database and your app. These stand in for them.
async function subscriptionsWithSchedules(): Promise<{ customerId: string; scheduleId: string }[]> {
  return [];
}
async function tellCustomer(customerId: string, state: State): Promise<void> {
  // "payment waiting": ask them to top up their wallet, or raise their approval.
  // "completed": send a new request to renew.
}
```

`schedules.status` reads the contract's own view of the next payment: whether it's due, and whether the customer's balance (`funded`) and approval (`approved`) cover it.

## Test it safely

1. Use a second wallet you control as the customer, holding about 1.01 USDT and a little CELO.
2. In `checkout.ts`, ask for `amount: "1"` with `runs: 1`. One USDT is the smallest payment the executor sends.
3. Start `webhook.ts`, then sign from the customer wallet using the link.
4. Watch `payment.received` arrive within a few minutes, then `payment.finalized`. Run `check.ts` afterwards: the schedule reads `completed`.

## Where to go next

- [Payment requests](../guides/payment-requests.md): request states, and what a payer sees.
- [Webhooks](../guides/webhooks.md): the challenge, rotating the secret, and replaying failed deliveries.
- [Schedules](../guides/schedules.md): reading, pausing and cancelling schedules.
- [Webhook payloads](../reference/webhook-payloads.md): every field of a delivery.
