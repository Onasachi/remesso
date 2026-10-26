---
title: Changelog
description: What changed in each release of remesso-sdk.
---

Releases of [`remesso-sdk`](https://www.npmjs.com/package/remesso-sdk) on npm.

## 0.3.0

Not yet released.

- **Agent-to-agent payments.** `remittances.send` pays one exact amount from this agent's own wallet or from a spending policy, optionally answering a one-off request. A retry with the same key continues the same payment. See [Build an agent-to-agent app](../guides/agent-to-agent.md).
- **`agents.pay`** pays an agent registered in ERC-8004, at the wallet the registry names.
- **`receipts.verify`** checks a payment on the chain, without a key: exact payer, recipient, token and amount, by Remesso's contracts, optionally finalized.
- **Signed invoices.** `invoices.create`, `sign`, `verify`, `pay` and `verifyPayment`: the recipient signs exact terms, the payer checks them, and only that invoice's payment settles it.
- **Quotes and deadlines.** `remittances.quote` and `prepare`; `startBy` bounds when a payment may start, and `validUntil` when it must land.
- **Recovery.** `remittances.get`, `listPending`, `reconcile`, `wait` and `recoverPending` follow a payment and continue it after a crash. They never start one.
- **Workers.** `remesso-sdk/postgres` shares journals, a signing lock, jobs and a fulfilment inbox between processes.
- **Local development.** `npx remesso-sdk dev` runs both funding models against a local fork of Celo.
- **Managed signers and agent tools.** `remesso-sdk/signers` and `remesso-sdk/tools`.
- **Safer journals.** Before signing anything, the SDK sends again any saved transaction the chain hasn't mined, or cancels one past its deadline at its nonce, so one lost broadcast can't hold up the transactions after it. A failed broadcast is retried at once.

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
