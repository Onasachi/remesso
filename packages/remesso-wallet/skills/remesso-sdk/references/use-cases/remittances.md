# Send money home every month

> Pay a family member in USDT every month from one signature, and tell them each time money arrives, with a link to cash it out.

Source: https://docs.remesso.xyz/docs/use-cases/remittances

Someone working in London supports family in Lagos, and sends money every month. Each transfer means another form, another fee and another wait. With Remesso the sender signs once. After that, the family receives USDT every 30 days, in a wallet they already use, such as MiniPay, and a short program tells them each time money arrives.

## What you'll build

- `send-home.ts` signs a monthly USDT schedule to a family member's wallet, so they receive an exact amount every month.
- `notify.ts` watches for each payment and sends the family a message with the amount and a link to cash it out.

## Choose the token

The family's wallet and their way to cash out decide the token:

- **In MiniPay, pay USDT, USDC, USDm or USA₮.** MiniPay shows only those four. It doesn't show cNGN or Ripio's local-currency tokens: a recipient paid in those needs another wallet.
- **For naira, pay USDT.** On Celo, USDT is the token Textile pairs with cNGN. The recipient opens Textile with their own wallet, swaps USDT to cNGN, and uses "Withdraw NGN" to a Nigerian bank account in their own name: `https://app.textilecredit.com/s/swap?sell=USDT&buy=cNGN&chainId=42220`.
- **For pesos, reais or soles, pay the country's Ripio token:** wARS, wBRL, wCOP, wMXN, wCLP or wPEN. The recipient cashes out on Ripio's ramp, for example `https://ramp.ripio.com/off-ramp?country=AR&chain=42220&token=WARS` for Argentina, or `country=BR` with `token=WBRL` for Brazil. Which countries Ripio ramps on Celo is Ripio's to decide.

Remesso never pays into a bank account on the sender's behalf. The family receives tokens in their own wallet, and cashes them out themselves, if and when they choose.

## Prerequisites

- The setup from [Installation](../installation.md), and the sender's key. It holds the USDT: each payment plus Remesso's 0.25% fee.
- A little CELO to sign the schedule once, about 0.05 CELO. With no CELO, the SDK pays the gas in USDT. Remesso's executor pays the gas of every monthly payment after that.
- The family member's wallet address. Receiving needs no gas, no balance and no software.

```bash
export SENDER_KEY=0x… FAMILY_WALLET=0x…
```

## Step 1: Sign the schedule

`receive` is what arrives each month. The SDK adds the fee to what leaves your wallet.

```ts title="send-home.ts"
import { createRemesso, formatAmount } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const payer = createRemesso({
  account: privateKeyToAccount(process.env.SENDER_KEY as `0x${string}`),
});

const s = await payer.schedules.create({
  to: process.env.FAMILY_WALLET!,
  receive: "50", // USDT that arrives each month
  token: "USDT",
  every: "month",
  runs: 12, // a year: the longest a schedule lasts
});

console.log(`schedule #${s.id}: ${formatAmount(s.amountIn, "USDT")} leaves your wallet each month`);
console.log(`${formatAmount(s.recipientGets, "USDT")} arrives, ${s.runs} times, until ${s.expiresAt.toDateString()}`);
for (const w of s.warnings) console.log("note:", w);
```

This sends two transactions. The first adds the year's total to your USDT approval for the contract: that approval is the most the schedule can ever take. The second creates the schedule. Remesso finds a schedule created from code within about five minutes, and sends the first payment then. After that, payments go out every 30 days.

To start on a particular day, pass `firstRunAt`. A schedule lasts at most a year from signing, so a later start fits fewer payments: the SDK refuses a schedule whose payments don't fit, before signing anything.

The wallet doesn't need the whole year up front. Each payment is taken when it's due, so keep one month's payment and the fee in it. If it's short when a payment is due, that payment waits. It goes out once the wallet is topped up, as long as the schedule hasn't expired.

## Step 2: Tell the family each time

Payment events are public, so the watcher needs no key, and the family needs no software. This one tells them once each payment is final, about half an hour after it lands, so a message never has to be taken back.

```ts title="notify.ts"
import { readFile, writeFile } from "node:fs/promises";
import { createRemesso, formatAmount } from "remesso-sdk";

const reader = createRemesso(); // payment events are public: no key needed
const family = process.env.FAMILY_WALLET!;
const scheduleId = process.env.SCHEDULE_ID!; // printed by send-home.ts
const CASH_OUT = "https://app.textilecredit.com/s/swap?sell=USDT&buy=cNGN&chainId=42220";

// Where the last run stopped, so a restart doesn't announce a payment again.
const after = Number(await readFile("notify-seq.txt", "utf8").catch(() => "0"));

for await (const e of reader.events.watch({ address: family, role: "to", kinds: ["run"], after })) {
  if (e.refId === scheduleId && e.final && !e.removed) {
    await tell(`${formatAmount(e.amount!, e.token!)} has arrived. To cash it out to your bank account: ${CASH_OUT}`);
  }
  await writeFile("notify-seq.txt", String(e.seq)); // after telling: a crash repeats a message, never skips one
}

async function tell(message: string) {
  // Your messaging: SMS, WhatsApp, email. Printed here.
  console.log(new Date().toISOString(), message);
}
```

Each event comes round again when it changes, so a payment appears once when it lands and again when it becomes final. Announcing only the final one sends exactly one message per payment. To tell the family sooner, announce events that aren't final yet too, and send a correction if one is later marked `removed`.

## Step 3: Change or stop

The schedule's recipient, amount and cadence are fixed once it's signed. Nobody can change them, Remesso included.

- **To send a different amount**, cancel and sign a new schedule.
- **If the family moves to a new wallet**, the schedule keeps paying the old one. Cancel it and sign a new one to the new address.
- **To stop**, cancel with the same client that signed. It stops every future payment:

```ts
await payer.schedules.cancel(scheduleId);
```

To skip a while without cancelling, pause with `schedules.setActive(scheduleId, false)`, and resume later with `true`.

## Test it safely

1. Use a second wallet you control as the family's wallet. A MiniPay wallet works, and shows the USDT arriving.
2. Sign with `receive: "1"` and `runs: 1`: about 1.0025 USDT leaves the sender's wallet.
3. Start `notify.ts` with the schedule id. The payment goes out within about five minutes, and the message follows once it's final, about half an hour later.

## Where to go next

- [Schedules](../guides/schedules.md): every option of `create`, and pausing and cancelling.
- [Payment events](../guides/payment-events.md): paging, finality and reorgs.
- [Tokens and limits](../reference/tokens-and-limits.md): which tokens a schedule can pay, and the per-payment bounds.
