---
title: Changelog
description: What changed in each release of remesso-sdk.
---

Releases of [`remesso-sdk`](https://www.npmjs.com/package/remesso-sdk) on npm.

## 0.3.0-rc.1 — unpublished source

This checkout is a release candidate. These APIs are not available in the
published 0.2.0 package yet. See [production agent services](../guides/production-sdk.md).

- Agent-to-agent `remittances.send` with explicit self-funded wallet or delegated policy funding, exact one-off invoice terms and durable retry journals.
- `agents.pay` binds payment to a fresh ERC-8004 registry wallet and its published asset/reference requirements.
- Account-free `receipts.verify` checks expected payment terms, immutable contract state, canonical inclusion and optional chain finality.
- `fileRemittanceStore` persists wallet approval/creation/execution progress; `examples/agent-to-agent.ts` demonstrates request, preview/send and independent verification.
- Safety fixes for scoped idempotency, corrupt stores, nonce coordination, original receipt/event evidence, policy selection/pagination and webhook validation.
- Optional Postgres journals, signer session locks, durable nonce evidence, invoice reservations, fenced worker jobs and transactional fulfillment deduplication.
- Payment lifecycle reads, reconciliation, finality waits and one-pass recovery of existing pending keys. External executor payments are verified independently after sender restarts.
- EIP-712 invoices binding payer, recipient, token, amount, order and expiry, with exact backend requests and final payment verification.
- Read-only quote/simulation details and prepared sends bounded by debit and intent expiry. Gas estimates distinguish RPC estimates from conservative planning hints.
- `remesso-sdk dev` and repository `npm run dev:smoke`: an owned Celo fork, funded test agents, sample requests and an in-memory signed-webhook receiving emulator.
- Managed signer callback validation for Celo transaction encoding and typed data, plus framework-neutral agent tools with schemas, structured results and writes denied by default. The existing MCP server delegates SDK operations to the same payment logic.

## 0.2.0

Released 25 October 2026.

- **Builder codes.** `createRemesso({ builderCodes })` adds your own ERC-8021 codes after Remesso's on every transaction the client sends. Remesso's executor then carries them on every payment of the schedules the client creates. See [builder codes](../guides/builder-codes.md).
- **`attributionFor(builderCodes)`** returns the suffix for a transaction you send yourself.
- Builder codes are checked by the same rules the executor applies: up to three, Celo's charset, none of Remesso's own. A code the executor wouldn't carry is refused before signing.
- Without `builderCodes`, every transaction carries exactly what 0.1.0 wrote.

## 0.1.0

Released 25 October 2026. The first release.

- **Schedules:** create (with `amount` or `receive`), read, list, pause, resume, cancel and set a trigger. Amounts outside the executor's per-payment limits are refused before signing.
- **Agent payments:** `pay` through a policy, once per idempotency key, with the payment recorded before it is broadcast. Policies can be created, read, found, revoked and given a recipient list.
- **Payment requests:** create, read, list, answer, decline with a signature, pay as an agent and wait until paid.
- **Payment events:** list, watch and wait for events from Remesso's indexer.
- **Webhooks:** subscribe, rotate, revoke and replay, with `webhookHandler`, `verifyWebhook` and `parseWebhook`.
- **Agents:** `agents.find` reads an ERC-8004 agent's wallet and payee profile.
- **Node helpers:** `fileStore`, `safeFetchText` and `toNodeListener` from `remesso-sdk/node`.
- When the account holds too little CELO, gas is paid in the transaction's own token (USDT, USDC, USDm or USA₮) through Celo's fee abstraction.
- The deployment, ABIs and shared rules are generated from what is live and from the code Remesso's backend runs.
