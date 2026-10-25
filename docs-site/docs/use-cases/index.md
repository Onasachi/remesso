---
title: Use cases
description: Six worked examples of building on remesso-sdk, from a freelancer's monthly invoice to an AI agent with a spending budget.
---

Each use case is a small, complete program you can run on Celo mainnet with a few dollars. They all use the same building blocks: schedules, payment requests, agent policies, payment events and webhooks. Each one puts them together for a single job. Pick the one closest to what you're building, then read the guides it links to for the details.

| Use case | Who it's for | What it does | SDK features |
|---|---|---|---|
| [Bill a client every month](./freelancer-retainer.md) | Freelancers and agencies | Asks a client for a monthly retainer in pesos or dollars, then writes a receipt for each payment as it lands | Payment requests, webhooks |
| [Subscriptions for your app](./subscriptions.md) | SaaS and API products | Bills each customer monthly, grants access when a payment arrives, and notices a cancelled or paused subscription | Payment requests, webhooks, schedule status |
| [Pay a team on a schedule](./payroll.md) | Small companies, an employer's agent | Signs one schedule per contractor so each receives an exact amount, budgets the total, and checks funding before payday | Schedules, fees, schedule status |
| [Send money home every month](./remittances.md) | People supporting family abroad | Pays a family member in USDT every month and tells them each time, with a link to cash out | Schedules, payment events |
| [A weekly allowance, approved by an agent](./family-allowance.md) | Families, two agents | The child's agent asks for cNGN every week, and the parent's agent signs a schedule after the parent says yes | Payment requests, schedules, webhooks |
| [Give an AI agent a budget](./ai-agent-budget.md) | People whose agent pays for things | Caps what an agent's key can spend, pays with idempotency keys so a retry never pays twice, and lets the person review and revoke | Agent policies, agent payments, payment requests |

## Before you start

Every use case assumes the setup from [Installation](../installation.md): Node 20 or later, `remesso-sdk` and `viem` installed, and `tsx` to run TypeScript files directly. If you haven't sent a payment yet, the [Quickstart](../quickstart.md) does it end to end in about 15 minutes.

A few facts hold across all of them:

- **The payer always signs.** Remesso can't pull money from anyone. A request or a link only fills in a form. Money moves when the payer signs a schedule in their own wallet, or when an agent pays within a policy its person signed.
- **Receiving costs nothing.** A recipient needs an address, and no gas, balance or account.
- **Scheduled payments carry a 0.25% fee**, taken from each payment. Agent policy payments carry none. See [Fees and gas](../guides/fees-and-gas.md).
- **Each scheduled payment is the equivalent of 1 to 1,000 dollars**, in whichever token it pays. Outside that range a schedule is valid on-chain but never runs, so the SDK refuses it before signing. [Tokens and limits](../reference/tokens-and-limits.md) lists the bounds per token.
- **There is no testnet.** Every example moves real money on Celo mainnet. Test with keys that hold only what you're willing to lose, and with the smallest amounts the executor sends.
