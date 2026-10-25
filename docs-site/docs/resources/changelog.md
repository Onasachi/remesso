---
title: Changelog
description: What changed in each release of remesso-sdk.
---

Releases of [`remesso-sdk`](https://www.npmjs.com/package/remesso-sdk) on npm.

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
