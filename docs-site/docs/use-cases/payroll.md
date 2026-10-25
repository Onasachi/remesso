---
title: Pay a team on a schedule
sidebar_label: Payroll
description: Sign one schedule per contractor so each receives an exact monthly amount, budget the total, check funding before payday, and stop a schedule when a contract ends.
---

A small company pays its contractors every month in USDT. The work is repetitive: send each payment, get the amount right after fees, and check the money is there before payday. With Remesso the employer signs one schedule per contractor, once. Each person then receives the exact amount you name every month, and you only watch that the wallet stays funded.

The same steps work for an employer's agent, running on the employer's key.

## What you'll build

- `payroll.ts` budgets the team's pay, checks the wallet can cover the first payday, and signs one schedule per contractor.
- `before-payday.ts` checks every schedule's next payment is funded and approved.
- A one-line cancel for when a contract ends.

## Prerequisites

- The setup from [Installation](../installation.md), and the employer's key. It holds the USDT and signs each schedule.
- A little CELO for gas: about 0.05 CELO per contractor, for an approval and a schedule. With no CELO, the SDK pays gas in USDT.
- Each contractor's wallet address. Receiving needs no gas and no balance. MiniPay shows USDT, so a contractor can use it.

```bash
export EMPLOYER_KEY=0x…
```

## Limits that shape a payroll

- **Each payment is 1 to 1,000 USDT before the fee.** After the 0.25% fee, a contractor can receive at most 997.50 USDT per payment. The SDK refuses anything outside that before signing. Other tokens have their own bounds: see [Tokens and limits](../reference/tokens-and-limits.md).
- **A schedule lasts at most a year from signing.** With the first payday up to a month away, six monthly payments fit comfortably. Sign again for the next six. The SDK refuses a schedule whose payments don't fit.
- **A month is 30 days.** Paydays drift against calendar dates, by a day or so each month.
- **Each schedule is its own approval.** For every contractor the SDK sends two transactions: it adds that schedule's total to your USDT approval for the contract, then creates the schedule. The approval is the most that schedule can ever take.

## Step 1: Budget and sign

Use `receive` so each contractor gets exactly the amount you name. The SDK adds the fee on top. `grossFor` does the same sum, so you can budget before signing anything.

```ts title="payroll.ts"
import { writeFile } from "node:fs/promises";
import { createRemesso, erc20Abi, FEE_BPS, formatAmount, grossFor, token, toUnits } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const employer = createRemesso({
  account: privateKeyToAccount(process.env.EMPLOYER_KEY as `0x${string}`),
});
const usdt = token("USDT");

/// Who gets paid, and what arrives each month after the fee.
const team = [
  { name: "Designer", wallet: "0xDesignerWallet", receive: "400" },
  { name: "Developer", wallet: "0xDeveloperWallet", receive: "650" },
];
const runs = 6; // six months: sign again for the next six

// What leaves your wallet each payday, and in all.
const perPayday = team.reduce((sum, p) => sum + grossFor(toUnits(p.receive, usdt), FEE_BPS), 0n);
const balance = await employer.publicClient.readContract({
  address: usdt.address,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [employer.address],
});
console.log(`each payday: ${formatAmount(perPayday, usdt)}; over ${runs} months: ${formatAmount(perPayday * BigInt(runs), usdt)}`);
if (balance < perPayday) throw new Error(`the wallet holds ${formatAmount(balance, usdt)}: not enough for the first payday`);

// The first payday: 09:00 UTC on the 1st of next month.
const now = new Date();
const payday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 9));

const ids: Record<string, string> = {};
for (const p of team) {
  const s = await employer.schedules.create({
    to: p.wallet,
    receive: p.receive,
    token: "USDT",
    every: "month",
    runs,
    firstRunAt: payday,
  });
  ids[p.name] = s.id.toString();
  console.log(`${p.name}: schedule #${s.id}, ${formatAmount(s.recipientGets, usdt)} a month from ${s.firstRunAt.toDateString()}`);
  for (const w of s.warnings) console.log(`  note: ${w}`);
}
await writeFile("payroll.json", JSON.stringify(ids, null, 2));
```

The wallet doesn't need the whole six months up front. Each payment is taken when it's due, so the balance only has to cover each payday as it comes.

## Step 2: Check before each payday

One balance pays every schedule. `schedules.status` tells you whether the next payment of each schedule is covered on its own. The total check makes sure the balance covers everyone paid the same day.

```ts title="before-payday.ts"
import { readFile } from "node:fs/promises";
import { createRemesso, erc20Abi, formatAmount, token } from "remesso-sdk";

const reader = createRemesso(); // reading needs no key
const usdt = token("USDT");
const employer = process.env.EMPLOYER as `0x${string}`; // the employer's address
const ids = JSON.parse(await readFile("payroll.json", "utf8")) as Record<string, string>;

const soon = Date.now() + 2 * 86_400_000;
let dueSoon = 0n;
for (const [name, id] of Object.entries(ids)) {
  const [s, run] = await Promise.all([reader.schedules.get(id), reader.schedules.status(id)]);
  if (s.cancelled || s.runsExecuted >= s.maxRuns) continue; // stopped, or done
  if (run.nextRunAt.getTime() < soon) dueSoon += s.amountIn;
  const problems = [
    !s.active && "paused",
    !run.funded && "the balance is below one payment",
    !run.approved && "the approval is below one payment",
  ].filter(Boolean);
  console.log(`${name} #${id}: next payment ${run.nextRunAt.toDateString()}${problems.length ? `, PROBLEM: ${problems.join(", ")}` : ""}`);
}

const balance = await reader.publicClient.readContract({
  address: usdt.address,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [employer],
});
if (balance < dueSoon) console.log(`top up: ${formatAmount(dueSoon, usdt)} is due in the next two days, and the wallet holds ${formatAmount(balance, usdt)}`);
```

A payment that's due when the wallet is short doesn't fail for good. It waits, and goes out once the wallet is topped up, as long as the schedule hasn't expired.

## Step 3: When a contract changes or ends

Terms are fixed at signing. To pay someone a different amount, cancel their schedule and sign a new one. To stop paying, cancel:

```ts
await payer.schedules.cancel(scheduleId); // stops every future payment
```

Only the wallet that signed a schedule can cancel it. Cancelling leaves your token approval as it is: if nothing else needs it, lower it with an ordinary ERC-20 `approve` from your wallet.

For a break, such as unpaid leave, pause instead and resume later:

```ts
await payer.schedules.setActive(scheduleId, false); // pause
await payer.schedules.setActive(scheduleId, true); // resume
```

## Test it safely

:::warning Real money
There is no testnet. Payroll moves real USDT on Celo mainnet. Test with keys that hold only what you're willing to lose.
:::

1. Put one contractor in `team`: a second wallet you control, with `receive: "1"`.
2. Set `runs = 1` and leave out `firstRunAt`, so the payment is due at once.
3. Give the employer wallet about 1.01 USDT and a little CELO, then run `payroll.ts`.
4. A schedule created from code is found by Remesso within about five minutes, and paid within a minute of that. Run `before-payday.ts` before and after.

## Where to go next

- [Schedules](../guides/schedules.md): every option of `create`, and reading, pausing and cancelling.
- [Fees and gas](../guides/fees-and-gas.md): `grossFor`, `netOf` and who pays gas when.
- [Payment events](../guides/payment-events.md): a record of every payment for your accounts.
