---
name: remesso-sdk
description: Write and review code that uses remesso-sdk, the TypeScript SDK for Remesso's stablecoin payments on Celo mainnet. Use when building recurring payments (schedules), payments an agent makes within a person's spending policy, one-off agent-to-agent payments with remittances.send (funded by a wallet or a policy), payment requests and signed invoices, payment events, webhooks, on-chain receipt verification, or a production setup with journals, Postgres and recovery. Carries every page of the docs.remesso.xyz documentation as references.
license: MIT
---

# Building with remesso-sdk

`remesso-sdk` is a TypeScript library, built on viem, for stablecoin payments on Celo mainnet: schedules a payer signs once, payments an agent makes within a policy a person signed, one-off payments between agents, requests to be paid, and the events, webhooks and receipts that tell a recipient it was paid. The references below are its whole documentation, the same pages as docs.remesso.xyz.

## How to use this skill

1. Find the page for the task in the list below and read it before writing code. Guides and use cases have complete examples, checked against the SDK's types.
2. Take function names, options and return types from [the client reference](references/reference/client.md) and [utilities](references/reference/utilities.md). Don't guess them.
3. Take addresses, tokens, decimals and limits from [tokens and limits](references/reference/tokens-and-limits.md) and [contracts and endpoints](references/reference/contracts.md), which are generated from the live deployment. Never write one from memory.

## Rules for every program

- **Install** with `npm install remesso-sdk viem`. The package is ESM, needs Node 20 or later, and takes viem 2.21 or later as a peer dependency.
- **Celo mainnet only.** The SDK refuses any chain but 42220, and there is no testnet. Develop against a local fork with `npx remesso-sdk dev`, which needs Foundry's `anvil`.
- **Keys come from the environment** (`privateKeyToAccount(process.env.…)`) or a `managedSigner`. Never ask anyone to paste a private key into a conversation.
- **Amounts are decimal strings** in the token's units, such as `"1.5"`. Check which side an amount names: in `schedules.create`, `amount` is what leaves the payer and `receive` is what arrives after Remesso's fee; in `remittances.send`, `amount` is exactly what the recipient receives, with the fee added on top for a wallet-funded send and none for a policy payment.
- **Every payment takes an `idempotencyKey`.** A `pending` result may still be paid: call again with the same key and the same terms, and the SDK continues that payment. A new key is a second payment.
- **Keep the journals.** The default stores live in memory, so a retry after a restart could pay twice. Pass `store: fileStore(…)` and `remittanceStore: fileRemittanceStore(…)` from `remesso-sdk/node`, or share Postgres between workers, as [production](references/guides/production-sdk.md) describes.
- **Check a payment before delivering anything for it.** Call `receipts.verify(…)`, with `finality: "finalized"` for anything valuable, and store `proof.eventId` under a unique constraint. A webhook or an event says when to check; the receipt on the chain is the proof.
- **Errors** are `RemessoError`s with a `code`. [Errors](references/reference/errors.md) lists each code and what it means.

## The pages

<!-- references: written by scripts/build-ai-docs.ts -->

The pages of https://docs.remesso.xyz for remesso-sdk 0.3.0-rc.1.

### Get started

- [Introduction](references/intro.md): What remesso-sdk is, what you can build with it, and how a payment moves from a signature to a webhook.
- [Quickstart](references/quickstart.md): Send a 1 USDT payment on a schedule and receive its signed webhook, from an empty folder, in about 15 minutes.
- [Installation](references/installation.md): Install remesso-sdk, create a client for a server, a browser wallet or read-only use, and keep its keys safe.
- [Build with AI](references/build-with-ai.md): Give Claude Code, Codex, Cursor or any AI assistant the whole Remesso documentation, as a skill or as one text file.
- [Core concepts](references/concepts.md): Schedules, the executor, triggers, fees, agent policies, payment requests, payment events, finality and webhooks, and how they fit together.

### Guides

- [Build an agent-to-agent app](references/guides/agent-to-agent.md): One agent asks another to pay, gets paid from a wallet or a spending policy, and checks the payment on the chain before it delivers.
- [Run an agent service in production](references/guides/production-sdk.md): Workers that share one key, quotes, deadlines, signed invoices, recovery after a crash, local development, managed signers and agent tools.
- [Pay on a schedule](references/guides/schedules.md): Create a schedule the payer signs once, read it back, and pause, resume or cancel it.
- [Agent payments](references/guides/agent-payments.md): Let an agent pay from a person's wallet within limits the person sets on-chain, and pay exactly once per idempotency key.
- [Payment requests](references/guides/payment-requests.md): Ask a wallet to pay you, follow the request until it is paid, and answer or decline requests sent to you.
- [Payment events](references/guides/payment-events.md): Read every payment to or from an address, as Remesso's indexer records it from the chain, and follow new ones as they arrive.
- [Webhooks](references/guides/webhooks.md): Have Remesso announce every payment to your address at your own server, signed, retried, and verified by the SDK.
- [Builder codes](references/guides/builder-codes.md): Put your own ERC-8021 code on the schedules you create, so Celo credits their volume to you on every payment.
- [Find agents](references/guides/find-agents.md): Look up an agent in the ERC-8004 registry on Celo, get the only address it can safely be paid at, and read what it accepts.
- [Fees, limits and gas](references/guides/fees-and-gas.md): What each payment costs, the amounts Remesso's executor sends, and who pays gas for what.

### Use cases

- [Use cases](references/use-cases/index.md): Six worked examples of building on remesso-sdk, from a freelancer's monthly invoice to an AI agent with a spending budget.
- [Bill a client monthly](references/use-cases/freelancer-retainer.md): A freelancer's agent asks a client for a monthly retainer, then writes a receipt for every payment as it arrives and becomes final.
- [Subscriptions](references/use-cases/subscriptions.md): Bill each customer monthly in stablecoins, grant access when a payment arrives, and notice when a customer pauses or cancels.
- [Payroll](references/use-cases/payroll.md): Sign one schedule per contractor so each receives an exact monthly amount, budget the total, check funding before payday, and stop a schedule when a contract ends.
- [Remittances](references/use-cases/remittances.md): Pay a family member in USDT every month from one signature, and tell them each time money arrives, with a link to cash it out.
- [Family allowance](references/use-cases/family-allowance.md): A child's agent asks a parent for cNGN every week; the parent's agent shows the request and signs a weekly schedule after a yes.
- [AI agent budget](references/use-cases/ai-agent-budget.md): Cap what an agent's key can spend from a person's wallet, pay with idempotency keys so a retry never pays twice, and let the person review and revoke.

### API reference

- [Client API](references/reference/client.md): createRemesso and every method on the client it returns, with parameters, return values and the errors each can raise.
- [Utilities](references/reference/utilities.md): The functions and constants remesso-sdk exports besides the client - tokens, amounts, fees, limits, memos, pay links, webhook verification, stores, ABIs and the deployment.
- [Webhook payloads](references/reference/webhook-payloads.md): The exact format of Remesso's webhook deliveries, how each one is signed, and the rules for retries and duplicates.
- [Errors](references/reference/errors.md): Every RemessoError code the SDK throws, what causes it, and what to do about it.
- [Tokens and limits](references/reference/tokens-and-limits.md): The tokens a schedule can pay in, their decimals and addresses, the executor's per-payment limits, and which tokens can pay gas.
- [Contracts and endpoints](references/reference/contracts.md): The chain, contracts and HTTP endpoints remesso-sdk talks to, and how to check each one yourself.
- [HTTP API](references/reference/http-api.md): Remesso's public endpoints over plain HTTP, for any language: payment requests, payment events, webhooks and the capability document.

### Resources

- [FAQ](references/resources/faq.md): Answers to the questions developers ask most, and what to check when a payment doesn't arrive.
- [Security](references/resources/security.md): What the contracts guarantee, what Remesso operates and can't do, and how to handle keys, approvals and webhooks safely.
- [Changelog](references/resources/changelog.md): What changed in each release of remesso-sdk.

<!-- /references -->
