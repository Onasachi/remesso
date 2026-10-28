---
title: Changelog
description: What changed in each release of remesso-sdk.
---

Releases of [`remesso-sdk`](https://www.npmjs.com/package/remesso-sdk) on npm.

## 0.3.1

Released 28 October 2026.

- **Three more currencies.** Ripio's wMXN, wCLP and wPEN (Mexican peso, Chilean peso, Peruvian sol) can be scheduled and paid like the other local-currency tokens: 18 to 18,000 wMXN, 950 to 950,000 wCLP and 3 to 3,000 wPEN per payment.
- **wCOP's per-payment limits are 3,100 to 3.1 million**, from 3,200 to 3.2 million. The Colombian peso gained on the dollar, and the limits stay at or under $1,000.

## 0.3.0

Released 26 October 2026, after 0.3.0-rc.1 the same day.

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
- **Since 0.3.0-rc.1:** a read pinned to a block is tried again while the RPC's node catches up to that block, instead of failing with "block is out of range". An RPC that spreads calls across nodes, as `forno.celo.org` does, can answer the latest block from one node and the next call from another a block behind.

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
