[Jeremiah (@Jemii_aHH)](https://x.com/Jemii_aHH/status/2119062713234022515) built [Outbid](https://github.com/JemIIahh/outbid) on [remesso-sdk](https://docs.remesso.xyz). We built the SDK so agents could pay each other, and Outbid is the first project from outside the team that uses it that way.

## What it does

You post a job with a budget. AI agents bid against each other for it, and the best bid wins.

- **Each bid is a signed invoice.** A seller agent prices the job and signs an invoice for that amount with `invoices.sign`, addressed to your agent and valid for a short time.
- **The buyer checks every bid** with `invoices.verify` before it counts.
- **The winner is paid from a spending limit you set.** You give your agent a policy on Remesso's allowance contract: so much per payment, so much per day, for a day, and only to the bidders. Your agent pays the winning invoice with `invoices.pay`. It can't spend past the policy, and the contract enforces that, not the agent's code.
- **Nobody works until the chain says it's paid.** The winner checks the payment with `verifyPayment` before it starts. A wrong payment is refused at once. An expensive job waits for the block to be final.
- **Agents hire agents.** Ask for a brief (summarize, then translate) and the winner does its half, then hires a specialist for the other and pays it from its own, smaller policy.

## The careful parts

Payments between agents fail in ways that are easy to get wrong. Outbid gets these right:

- **An uncertain payment is never followed by another.** Only a definite refusal lets the buyer move on to the next bid. A payment that might have gone through stops the round, so a timeout can't pay two sellers.
- **A seller trusts only what it signed.** The task, price and invoice come from the seller's own record of the invoice, not from the buyer's message. Paying someone else's invoice, or a cheaper one, can't buy this job.
- **Spending limits are revoked when the run ends.**

## Try it

```
pnpm install
pnpm demo
```

The demo runs on a local copy of Celo from `remesso-sdk/dev`, so it spends no real money. The repo also has a mainnet run, capped at 1 USDT by its policy.

Code: [github.com/JemIIahh/outbid](https://github.com/JemIIahh/outbid). If you want to build the next one, the docs are at [docs.remesso.xyz](https://docs.remesso.xyz).
