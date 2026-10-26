---
title: Quickstart
description: Send a 1 USDT payment on a schedule and receive its signed webhook, from an empty folder, in about 15 minutes.
---

This walkthrough takes you from an empty folder to a real payment and the signed webhook that reports it. It takes about 15 minutes, most of it waiting for the payment to be picked up.

You will run two programs: a **receiver**, which serves a webhook endpoint, and a **payer**, which creates a schedule that pays the receiver 1 USDT once.

## What you need

- Node 20 or later.
- About **1.05 USDT on Celo** in a wallet you control, for the payment and the fee. A little CELO for gas helps; without it, the SDK pays gas in USDT.
- `cloudflared`, to give your laptop a public HTTPS address for the webhook ([install it](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)). Any public HTTPS URL works instead.

## 1. Create the project

The SDK is ES modules only, and `tsx` runs TypeScript files without a build step.

```bash
mkdir remesso-quickstart && cd remesso-quickstart
npm init -y && npm pkg set type=module
npm install remesso-sdk viem
npm install -D tsx
```

## 2. Make two keys

One key pays and the other receives. Save this as `keys.ts` and run `npx tsx keys.ts` twice:

```ts title="keys.ts"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
console.log(key, privateKeyToAccount(key).address);
```

Send about 1.05 USDT to the payer's address on Celo. The receiver needs nothing: receiving costs no gas. Then export the keys in each terminal you use:

```bash
export PAYER_KEY=0x… RECEIVER_KEY=0x… RECEIVER=0x…
```

## 3. Run the receiver

In a first terminal, open a public address that forwards to port 8787. A Cloudflare quick tunnel needs no account and prints a `trycloudflare.com` URL:

```bash
cloudflared tunnel --url http://localhost:8787
```

In a second terminal, save this as `receiver.ts`. It serves the webhook endpoint and prints each payment it is told about:

```ts title="receiver.ts"
import { createServer } from "node:http";
import { createRemesso, formatAmount, webhookHandler } from "remesso-sdk";
import { toNodeListener } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const receiver = createRemesso({
  account: privateKeyToAccount(process.env.RECEIVER_KEY as `0x${string}`),
});

// Remesso returns the signing secret once your endpoint has answered its
// challenge, so the handler reads it when each delivery arrives.
let secret: string | undefined;

const handler = webhookHandler({
  recipient: receiver.address,
  secret: () => secret,
  onPayment: (m) =>
    console.log(m.type, formatAmount(m.data.amount, m.data.token), m.data.final ? "final" : "not final yet", m.data.txHash),
});

const server = createServer(toNodeListener(handler));
await new Promise<void>((done) => server.listen(8787, done));

const sub = await receiver.webhooks.subscribe({ url: process.env.PUBLIC_URL! });
secret = sub.secret; // returned once: store it if the receiver must survive a restart
console.log("subscribed", sub.subscription, "for", receiver.address);
```

Run it with the tunnel's URL:

```bash
PUBLIC_URL=https://….trycloudflare.com npx tsx receiver.ts
```

When you subscribe, Remesso first posts a challenge to your URL. The handler answers it only for the address you configured, and Remesso then returns the signing secret, once. You should see `subscribed`.

:::tip
A quick tunnel gets a new URL every time it starts, and an address can hold five subscriptions. Remove old ones with `receiver.webhooks.revoke({ url })`.
:::

## 4. Pay

In a third terminal, save this as `pay.ts` and run `npx tsx pay.ts`. It sends two transactions: an approval for the contract, then the schedule itself, one payment of 1 USDT.

```ts title="pay.ts"
import { createRemesso, formatAmount } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const payer = createRemesso({
  account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`),
});

const s = await payer.schedules.create({
  to: process.env.RECEIVER!,
  amount: "1",
  token: "USDT",
  every: "week",
  runs: 1,
});
console.log("schedule", s.id, "pays", formatAmount(s.recipientGets, "USDT"), s.hash);
```

The output shows the schedule's id and what the recipient gets: `0.9975 USDT`, which is 1 USDT less the 0.25% fee.

## 5. Watch the payment arrive

Go back to the receiver's terminal and wait.

1. Remesso finds a schedule created outside its own app within about **5 minutes**, and sends the payment within a minute of that.
2. A minute or two later the handler prints `payment.received` with `not final yet`: 0.9975 USDT.
3. About **25 to 30 minutes** later, `payment.finalized` follows, once Celo has finalized the block.

A delivery that fails is retried with the same `webhook-id` for 24 hours, so a real handler deduplicates on it.

## No public URL? Poll instead

The same information is available without a webhook. Payment events come from Remesso's indexer, and `watch` yields each new one:

```ts title="watch.ts"
import { createRemesso, formatAmount } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const receiver = createRemesso({
  account: privateKeyToAccount(process.env.RECEIVER_KEY as `0x${string}`),
});

for await (const e of receiver.events.watch({ role: "to", kinds: ["run", "policy_payment"] })) {
  console.log(e.kind, formatAmount(e.amount!, e.token!), e.final ? "final" : "not final yet", e.txHash);
}
```

## What just happened

- The payer **signed a mandate**: one payment of 1 USDT to the receiver. The contract holds it, and nothing can change its recipient or amount.
- Remesso's **executor** sent the payment when it was due. It paid the gas; the payer paid only for the approval and the schedule.
- Remesso's **indexer** read the payment from the chain and delivered a **signed webhook**, then a second one when the block became final.

## Next steps

- [Core concepts](./concepts.md) explains schedules, the executor and finality in more depth.
- [Pay on a schedule](./guides/schedules.md) covers cadences, triggers, pausing and cancelling.
- [Webhooks](./guides/webhooks.md) shows how to run the handler in Express, Next.js, Deno or Cloudflare Workers.
- [Use cases](./use-cases/index.md) builds complete products on these pieces.
