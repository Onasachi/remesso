---
title: Client API
description: createRemesso and every method on the client it returns, with parameters, return values and the errors each can raise.
---

Everything in the SDK hangs off one client. This page lists its options and every method, with what each takes, returns and refuses. Ids (schedule, policy, agent) are accepted as a `bigint`, a number or a decimal string.

## `createRemesso(options)`

```ts
import { createRemesso } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const remesso = createRemesso({
  account: privateKeyToAccount(process.env.REMESSO_KEY as `0x${string}`),
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `account` | viem `Account` | none | The key that pays, signs and receives. Agent payments need a sign-only local account, such as `privateKeyToAccount(...)` or `managedSigner(...)`. Leave it out to read only. |
| `walletClient` | viem `WalletClient` | none | A wallet client instead of an account, for example the user's browser wallet on Celo. |
| `rpcUrl` | `string` | `https://forno.celo.org` | A Celo mainnet RPC. Checked to answer chain `42220` before anything is signed. |
| `publicClient` | viem `PublicClient` | created from `rpcUrl` | Your own public client. Agent payments require `chain: celo` so Celo transactions use the right serializer. |
| `store` | `PaymentStore` | `memoryStore()` | Where agent payments are recorded so a retry pays once. Use `fileStore()` from `remesso-sdk/node` to keep records across restarts. |
| `remittanceStore` | `RemittanceStore` | `memoryRemittanceStore()` | Where wallet payments are recorded, each transaction before it is sent, so a retry continues the same payment. Use `fileRemittanceStore()` from `remesso-sdk/node` to keep records across restarts. |
| `invoiceStore` | `InvoiceStore` | `memoryInvoiceStore()` | Which payment route, signer and key each signed invoice is reserved for, so it is paid only one way. Share it between workers. |
| `coordinator` | `SignerCoordinator` | one queue per process | A lock and nonce record shared by every worker that signs with this key. Requires `store`, `remittanceStore` and `invoiceStore` shared the same way; `createPostgresStorage` gives all four. |
| `fetchText` | `(url) => Promise<string>` | none | Reads an https or ipfs agent registration file for `agents.find`. Pass `safeFetchText` from `remesso-sdk/node`. |
| `attribution` | `boolean` | `true` | Tag transactions with Remesso's ERC-8021 codes. |
| `builderCodes` | `string[]` | none | Your own ERC-8021 codes, up to three, on every transaction this client sends and on every payment of the schedules it creates. Throws on a code outside Celo's charset (1 to 32 of `a-z`, `0-9` and `_`), one of Remesso's own, a repeat, or more than three. |

With an `account`, or a `walletClient` that has one, the returned client's `address` is typed as an `Address`. Without either, the client reads only, and `address` is `null`.

### Client properties

| Property | Type | Description |
|---|---|---|
| `address` | `Address \| null` | This client's address, or `null` when it only reads. |
| `publicClient` | viem `PublicClient` | The client used for reads, for anything the SDK doesn't wrap. |
| `deployment` | object | Celo mainnet as Remesso runs it: chain, contracts, tokens, endpoints. See [contracts and endpoints](./contracts.md). |

## Agent-to-agent payments

One-off payments funded from this client's wallet or from a spending policy. These need `remesso-sdk` 0.3.0 or later; the guides are [agent-to-agent](../guides/agent-to-agent.md) and [production](../guides/production-sdk.md).

### `remittances.send(input)`

| Field | Type | Description |
|---|---|---|
| `funding` | `"wallet" \| "policy"` | Required. `wallet` spends this account's own tokens; `policy` spends a policy owner's, within the policy. |
| `to`, `amount`, `token` | `string` | The recipient, the exact decimal amount it receives, and the token by symbol or address. |
| `idempotencyKey` | `string` | Required. One per payment you intend. A retry with the same key and terms continues that payment and never pays twice. |
| `requestId` | `string` | Optional one-off request this pays. Its payer, recipient, amount and token must match; a recurring request is refused. |
| `policyId`, `payer` | id, `string` | Policy funding only: the policy to use, or the owner whose policy to use. |
| `memo` | `string` | Policy funding only: up to 32 bytes recorded with the payment. A request's reference fills it when `requestId` is set. |
| `waitMs` | `number` | How long to wait for receipts before answering `pending`: 1 to 120,000 ms, default 45 seconds. |
| `maxDebit` | `string` | The most the payer's balance may lose, fee included. Network gas is separate. |
| `startBy` | `number` | Unix seconds. Don't start the payment at or after this time; `prepare` sets it to the quote's expiry. A started payment continues regardless. |
| `validUntil` | `number` | Unix seconds. The payment must land before this. A wallet payment's schedule expires a second earlier; a policy payment still unsent near it is cancelled at its nonce. A retry can't change it. |

Returns `Promise<RemittanceResult>`. Both kinds have `funding`, `status` (`confirmed` or `pending`), `payer` (whose money moved), `to`, `token`, `amount` in base units and `fee`. A policy payment also has the [`pay`](#payinput) result's fields, including `cancellation` when its deadline passed before it was sent. A wallet payment also has `stage`, `amountIn`, `feeBps`, `scheduleId`, the hash of each transaction it sent (`createHash`, `approvalHash`, `executionHash`, `cancellationHash`), `repeat`, and `request` for the request's binding. Its `hash` is the transaction that paid, once there is one.

`pending` may still be paid: retry the same key, never a new one. A wallet payment is one schedule with a single payment, created, approved and run by the SDK; Remesso's executor may run it first, and either way it pays once. If it can't be completed, its schedule is cancelled, and only after that lands is it reported as not paid: a `refused` error with `details.cancelled`. One that expired unpaid has `details.expired`.

### `remittances.quote(input, options?)`

Signs nothing. Takes `funding`, `to`, `amount`, `token`, and optionally `requestId`, `idempotencyKey`, and for a policy `payer` or `policyId`. `options.ttlSeconds` is 1 to 300, default 60.

Returns `RemittanceQuote`: the recipient's `amount`, `grossDebit`, `protocolFee`, `feeBps`, `selectedPolicyId`, the approval needed (none when the allowance is already unlimited), the balance, `canSend` and `issues`, a simulation of each step, gas estimates marked `rpc_estimate` or `conservative_hint`, and the block, `checkedAt` and `expiresAt` it describes. Amounts are base units, as `bigint`. A quote reserves nothing.

### `remittances.prepare(input, options?)`

Quotes, refuses a payment that can't be sent or that costs more than `maxDebit`, and returns `{ quote, input }`. The input fixes the token, the policy and `maxDebit`, and sets `startBy` to the quote's expiry. Send checks everything again.

### Following a payment

| Method | What it does |
|---|---|
| `remittances.get(key, { funding? }?)` | Reads a saved payment and what the chain says about it. Signs and sends nothing. |
| `remittances.listPending({ funding? }?)` | The saved payments not yet final, failed, cancelled or expired, paused ones included. |
| `remittances.reconcile(key, { funding?, waitMs? }?)` | Continues a payment that has started: sends its saved transactions, or a wallet payment's remaining steps. Never starts a payment. |
| `remittances.wait(key, options?)` | Waits for `included` (the default) or `finalized`. Sends nothing. `timeoutMs` 1 to 86,400,000, default 20 minutes; `intervalMs` 1 to 60,000, default 1,500; `signal`; `funding`. |
| `remittances.recoverPending(options?)` | One pass of `reconcile` over started payments, oldest first. `limit` 1 to 1,000, default 25, bounds the work; `funding`, `waitMs` and `signal` as above. |

Each returns a `PaymentOperation`: `key`, `funding`, `status`, `stage`, `payer`, `to`, `token`, `amount`, `createdAt`, the hash and ids it has, a verified `proof` once included, and an `error` when something needs attention. The statuses are `prepared`, `awaiting_approval`, `signed`, `broadcast`, `included`, `finalized`, `failed`, `cancelled`, `paused`, `expired` and `needs_reconciliation`.

A wallet payment whose step reverted while its schedule is live is `needs_reconciliation`: it could still be paid, and reconciling cancels it. So is a transaction whose nonce was used with no receipt to show by what: look at its hash; the SDK never pays it again. `wait()` throws on a timeout, an abort, or a payment that failed, was cancelled, paused or expired. If a key is in both journals, pass `funding`.

### `invoices`

| Method | What it does |
|---|---|
| `invoices.sign(input)` | Signs an invoice's exact terms as its recipient, optionally for an existing one-off request. |
| `invoices.create(input)` | Creates a one-off request with the same terms, then signs them. |
| `invoices.verify(invoice, { allowExpired? }?)` | Checks the invoice's form, signature and expiry. Returns its terms, an `id` derived from them, and the `idempotencyKey` that pays it. Pays nothing. |
| `invoices.pay(invoice, options)` | Verifies it, quotes the payment and refuses one that can't be made now, reserves the invoice for this route, then pays its exact terms. `funding` is required; `policyId` for a policy, `maxDebit`, `waitMs`. Returns the payment and `invoiceId`. |
| `invoices.verifyPayment(invoice, input)` | Checks a transaction is this invoice's payment, on its terms and in its validity window. Finalized by default. Returns `{ invoiceId, orderId, payment }`. |

`sign` and `create` take `payer`, a decimal `amount`, `token`, `orderId` and `expiresAt` in Unix seconds. `recipient` defaults to, and must be, the signing account. `nonce` (32 random bytes) and `issuedAt` (now) are defaults: keep them to rebuild the same invoice.

An invoice without a request is tied to its payment by the memo `invoiceReference(id)`, so it is paid from a policy; a wallet payment's schedule can't carry a memo. `verifyPayment` takes `txHash`, `policyId` or `scheduleId`, and `finality`, and accepts only the invoice's own payment: the request's, or the one carrying its reference. A payment that landed while the invoice was valid still verifies after it expires. Store the invoice id, the payment's `eventId` and the order uniquely when you fulfil it.

### Server and framework adapters

| Import | API |
|---|---|
| `remesso-sdk/postgres` | `createPostgresStorage(postgresClient, { namespace?, jobLeaseMs?, heartbeatMs? })`: `initialize()`, both journals, the invoice store, the shared lock, jobs (a claim lasts five minutes by default) and a fulfilment inbox. Needs direct or session-pooled connections. |
| `remesso-sdk/dev` | `startDev(options?)`: a local Celo fork with funded public test accounts, a stand-in for Remesso's backend, clients, a sample invoice, `smoke()` and `close()`. Needs Foundry's `anvil`. The command line is `npx remesso-sdk dev`. |
| `remesso-sdk/signers` | `managedSigner({ address, signTransaction, signTypedData, signMessage? })`: a viem account whose callbacks only sign. The SDK checks every field of what comes back, the signer, and that each signature is low-s. |
| `remesso-sdk/tools` | `createAgentTools(client, { authorizeWrite?, enableWrites? }?)`: tool definitions with schemas, `list()` and `call(name, input)`. Tools that pay are refused unless the host allows them. |

### `agents.pay(agentId, input)`

Pays an agent registered in ERC-8004 through `remittances.send`, after checking its wallet in the registry and its payee profile. `funding` is required. With `requestId`, the request gives the amount and token, and the key defaults to `request:<id>`; without one, pass `amount`, `token` and `idempotencyKey`. `expectedWallet` makes it refuse any other wallet. `policyId` and `payer` apply to policy funding. Returns the payment and `counterparty: { agentId, wallet }`.

It refuses a profile it can't read, a token not on Celo, a missing required reference, a request addressed to someone else, and a wallet that changes before it sends. It never sends a payment anywhere a profile names.

### `receipts.verify(input)`

Takes `txHash`, `from` (whose money moved), `to`, `token` and the exact decimal `amount` received. `policyId` or `scheduleId`, not both, says which payment; `memo` must match a policy payment's. `finality` is `"included"` by default, or `"finalized"`.

Returns a `PaymentProof`: `eventId`, `chainId`, `contract`, `txHash`, `logIndex`, `blockNumber`, `blockHash`, `from`, `to`, `token`, `amount` in base units, and the `finality` checked. A policy payment's proof has `kind: "policy_payment"`, `policyId`, `agent`, `memo` and `callerVerified`; a schedule's has `kind: "run"`, `scheduleId`, `amountIn` and `runNumber`.

It refuses a reverted or replaced transaction, a block no longer on the chain, a payment by another contract, the wrong token, amount, payer or recipient, and more than one match. `finalized` refuses until the block is final, and when the RPC can't say. A receipt some of forno's nodes have lost is read from its block instead. `callerVerified` is `false` when a contract called the policy, since receipts don't show internal calls.

Store `eventId` uniquely when you fulfil an order: verifying proves a payment, not that you haven't already delivered for it.

## `schedules`

Schedules a payer signs once. See the [schedules guide](../guides/schedules.md).

### `schedules.create(input)`

Approves the contract for the schedule's total, on top of any existing approval, and creates the schedule: two transactions, sent with consecutive nonces. Refuses before signing anything the executor would never run.

| Field | Type | Description |
|---|---|---|
| `to` | `string` | Who gets paid. With `request`, it must match the request's address, and defaults to it. |
| `amount` | `string` | Per payment, what leaves your wallet, as a decimal string. Give this or `receive`, not both. |
| `receive` | `string` | Per payment, what the recipient receives after the fee. The SDK works out what to send. |
| `token` | `string` | A symbol or address. Default `USDT`, or the request's token. |
| `every` | `Cadence` or `number` | `"week"`, `"fortnight"`, `"month"` (30 days) or `"quarter"` (90 days), or seconds, at least 3,600. Default `"week"`, or the request's. |
| `runs` | `number` | How many payments. Required, unless the request names it. |
| `firstRunAt` | `Date` | When the first payment is due. Default now, so it goes out within minutes. |
| `trigger` | `"remesso"`, `string` or `null` | Who may bring a payment forward: `"remesso"` for Remesso's executor, or an address. Default nobody. |
| `triggers` | `number` | How many early sends the trigger may make. Default: all of them. |
| `request` | `string` | A payment request id this schedule answers. Its terms fill whatever you leave out, and the schedule is reported against it. |
| `approve` | `boolean` | `true` (default) approves the schedule's total; `false` when you manage approvals yourself. |

Returns `Promise<CreatedSchedule>`:

| Field | Type | Description |
|---|---|---|
| `id` | `bigint` | The schedule's id on the contract. |
| `hash` | `Hex` | The `createSchedule` transaction. |
| `approveHash` | `Hex \| null` | The approval transaction, or `null` with `approve: false`. |
| `to`, `token` | | The recipient and the token's symbol. |
| `amountIn` | `bigint` | What leaves the payer's wallet each payment, in base units. |
| `recipientGets` | `bigint` | What the recipient receives each payment, after the fee. |
| `feeBps`, `runs`, `intervalSeconds` | `number` | The fee in basis points, the number of payments and the cadence. |
| `firstRunAt`, `expiresAt` | `Date` | When the first payment is due, and when the schedule expires. |
| `request` | object | With `request`: how the request took the answer, `{ status, signed }`, or `{ error }`. |
| `warnings` | `string[]` | For example, a balance below one payment: payments fail until it is funded. |

Errors: `invalid` (missing or malformed input, `to` is this wallet, `firstRunAt` in the past), `refused` (a token not taken for new schedules, an amount outside the per-payment limits, more payments than fit in a year, a request that isn't open or isn't addressed to this wallet), `no_account`, `wrong_chain`, `no_gas`, `reverted`.

### `schedules.get(id)`

Returns `Promise<Schedule>`, as the contract stores it: `id`, `sender`, `to`, `token` (an address), `amountIn`, `recipientGets`, `feeBps`, `intervalSeconds`, `maxRuns`, `runsExecuted`, `nextRunAt`, `lastRunAt` (or `null`), `expiresAt`, `active`, `cancelled`, `payoutType`, `trigger` and `triggersLeft`. Throws `not_found` for an id nobody has created.

### `schedules.status(id)`

Whether a payment can go out: `Promise<{ due: boolean; funded: boolean; approved: boolean; nextRunAt: Date }>`. `funded` checks the payer's balance and `approved` the allowance, against one payment.

### `schedules.list(sender?)`

The ids of every schedule a sender created: `Promise<bigint[]>`. Default: this account.

### `schedules.cancel(id)`

Stops the schedule for good: `Promise<Hex>`. Only its payer can cancel. The token approval stays; lower it if nothing else needs it.

### `schedules.setActive(id, active)`

Pauses (`false`) or resumes (`true`) the schedule: `Promise<Hex>`.

### `schedules.setTrigger(id, trigger, triggers?)`

Changes who may bring a payment forward, and how many times: `Promise<Hex>`. `"remesso"` grants Remesso's executor; `null` removes the trigger. `triggers` defaults to 0, which allows no early sends, so pass the count you mean.

## `pay(input)`

As an agent, pays through a policy a person granted. It signs, records the payment in the store, broadcasts it and waits for the receipt. See the [agent payments guide](../guides/agent-payments.md).

| Field | Type | Description |
|---|---|---|
| `to` | `string` | The recipient. |
| `amount` | `string` | Decimal, in the policy token's units. |
| `token` | `string` | Symbol or address. Default: the token of the policy used. |
| `policyId` | id | Which policy to pay under. Default: an active one for the token that can cover the amount. |
| `payer` | `string` | Optional: only use a policy owned by this wallet. Request payments set it automatically. |
| `memo` | `string` | Up to 32 bytes, recorded on-chain in the `Paid` event. A request's reference goes here. |
| `idempotencyKey` | `string` | One per payment you intend. A retry with the same key reports the first attempt and never pays twice. |
| `allowRepeat` | `boolean` | Pay even though an identical payment went out in the last ten minutes. |
| `waitMs` | `number` | How long to wait for the receipt before answering `"pending"`: 1 to 120,000 milliseconds. Default 45 seconds. |
| `startBy` | `number` | Optional, Unix seconds: don't start the payment at or after this time. Ignored once the key has a saved payment. |
| `validUntil` | `number` | Optional, Unix seconds: the payment must land before this. It isn't started within a minute of it, nor broadcast within 30 seconds of it, and if it's still unsent then, a no-op is signed at its nonce so it can never land late. A retry can't change it. |

Returns `Promise<PaymentResult>`: `status` (`"confirmed"` or `"pending"`), `hash`, `policyId`, `to`, `amount` (base units), `token`, `sent` (for example `"1.5 USDT"`), `explorer` (a Celoscan link), `repeat` (true when this key had already paid and nothing new was sent), and `cancellation`, the no-op's hash, when the deadline passed before it went out. On `"pending"`, call again with the same key: whatever happened, the answer is about that one payment.

Errors: `refused` (outside the policy, revoked or expired, or cancelled after its deadline with `details.expired`), `key_reused`, `repeat`, `no_account` (no local account), `no_gas`, `reverted`.

## `policies`

Spending limits a person grants an agent.

### `policies.create(input)`

As the owner, approves a budget for the allowance contract and creates the policy: `Promise<{ id: bigint; hash: Hex; approveHash: Hex }>`.

| Field | Type | Description |
|---|---|---|
| `agent` | `string` | The agent's address: the key that will call `pay`. |
| `token` | `string` | Symbol or address. |
| `perPayment` | `string` | The cap per payment, decimal. |
| `perDay` | `string` | The cap per day, decimal: a 24-hour window that opens with the first payment after the previous window has closed. |
| `days` | `number` | How long it lasts. Default 30. |
| `recipients` | `string[]` | If given, the only addresses the agent may pay. |
| `budget` | `string` | Added to your approval for the allowance contract: the most this and your other policies for this token can spend together. |

### `policies.get(id)`

Returns `Promise<Policy>`: `id`, `owner`, `agent`, `token`, `symbol`, `perPayment`, `perDay`, `expiresAt`, `allowlistOnly`, `revoked`, `remainingToday`, `ownerBalance`, `ownerAllowance` (shared by all the owner's policies for the token), `active` (not revoked and not expired) and `spendable` (the largest payment the policy allows right now, every limit counted). Throws `not_found` for a policy that doesn't exist.

### `policies.find(agent?)`

Every policy naming an agent, newest first: `Promise<bigint[]>`. Default: this account. Reads Remesso's index, plus the newest ids from the chain, so a policy created seconds ago shows.

### `policies.revoke(id)`

As the owner, ends the policy now: `Promise<Hex>`.

### `policies.setRecipient(id, recipient, allowed)`

As the owner, adds an address to the policy's allowlist or removes it: `Promise<Hex>`. The allowlist applies only to a policy created with `recipients`: whether a policy is limited to a list is fixed when it is created.

## `requests`

Payment requests. See the [payment requests guide](../guides/payment-requests.md).

### `requests.create(input)`

Asks a wallet to pay you. Free. Returns `Promise<{ id: string; reference: string; link: string; status: RequestState }>`. The `reference` is the id without dashes, which an agent payment carries in its memo to answer the request.

| Field | Type | Description |
|---|---|---|
| `payer` | `string` | The wallet you're asking. |
| `to` | `string` | Where you want to be paid. Default: this account. |
| `amount` | `string` | What you want to receive per payment, decimal. The payer's form adds the fee on top. |
| `token` | `string` | Symbol or address. |
| `every` | `Cadence` | How often. |
| `runs` | `number` | How many payments. |
| `from` | `string` | Who is asking, up to 40 characters. |
| `note` | `string` | Why, up to 120 characters. |

### `requests.get(id)`

Where a request stands: `Promise<RequestStatus>`, with `id`, `reference`, `status`, `payer`, `requested` (`to`, `amount`, `token`, `intervalSeconds`, `runs`), `signed` (what the payer signed, once answered) and `payment` (`null` until answered, then `state`, `schedule`, `txs` and `reason`). It is paid only when `payment.state` is `"paid"`.

### `requests.list(payer?)`

The live requests addressed to a wallet, pending and under 30 days old: `Promise<RequestSummary[]>`. Default: this account.

### `requests.answer(id, scheduleId, contract?, opts?)`

Reports the schedule that answers a request: `Promise<{ status: RequestState; signed: unknown }>`. It binds only if the schedule is from the wallet asked, pays the address that asked, was created after the request and answers no other request. While the backend can't see a schedule that has just landed, it retries for up to `opts.waitMs` (default 90 seconds). Answering twice with the same schedule returns the first answer. `schedules.create({ request })` calls this for you.

### `requests.decline(id, opts?)`

Turns a request down for everyone, with an EIP-712 signature: `Promise<{ ok: boolean; id: string; status: RequestState }>`. Signed by the wallet the request was sent to, or by an agent under a live policy from that wallet (`opts.policyId`). `opts.ttlSeconds` (default 600) is how long the signature is valid.

### `requests.pay(id, opts?)`

As an agent, pays a request through a policy from the wallet it was sent to: `Promise<PaymentResult>`. The payment carries the request's reference as its memo, and the request id is the default idempotency key, so each request is paid once. `opts` takes `pay`'s fields except `to`, `memo` and `token`, and `amount` defaults to the request's.

### `requests.waitUntilPaid(id, opts?)`

Polls until the request has a payment with a transaction: `Promise<RequestStatus>`. `opts.timeoutMs` (default 20 minutes), `opts.intervalMs` (default 15 seconds) and `opts.signal`. Pass `opts.final: true` to wait until at least one payment transaction is finalized. Throws `refused` if the request is declined or expires, and `timeout` when time runs out.

## `events`

Payment events from Remesso's indexer. See the [payment events guide](../guides/payment-events.md).

### `events.list(query?)`

One page of events: `Promise<{ events: PaymentEvent[]; next: number }>`. Pass `next` as `after` for the following page.

| Field | Type | Description |
|---|---|---|
| `address` | `string` | Default: this account. |
| `role` | `"to"`, `"from"`, `"agent"` or `"any"` | Which side of the event the address is on. Default `"any"`. |
| `kinds` | `EventKind[]` | Any of `"run"`, `"schedule_created"`, `"policy_payment"`, `"policy_created"`, `"policy_revoked"`. |
| `after` | `number` | Events with a `seq` above this. Default 0, from the start. |
| `limit` | `number` | 1 to 500. Default 100. |

### `events.watch(query?)`

An async iterator: every event from `after` on, then each new event or change as it comes, until `signal` aborts. Takes `list`'s fields plus `intervalMs` (default 15 seconds) and `signal`.

### `events.waitFor(match, query?)`

The first event from `after` on that `match` accepts: `Promise<PaymentEvent>`. Takes `list`'s fields plus `timeoutMs` (default 20 minutes) and `intervalMs`. Throws `timeout`.

## `webhooks`

Webhook subscriptions for the receiving address, each request signed by this client's account. See the [webhooks guide](../guides/webhooks.md).

| Method | Returns | Description |
|---|---|---|
| `subscribe({ url, recipient? })` | `{ ok, subscription, recipient, url, state, secret }` | Starts delivering the address's payments to `url` (https). The endpoint must already answer the challenge. The `secret` is returned once. |
| `rotate({ url, recipient? })` | `{ ok, secret, previousSecretValidUntil }` | A new signing secret. The old one keeps signing alongside it for a day. |
| `revoke({ url, recipient? })` | `{ ok, state }` | Stops deliveries to `url`. |
| `replay({ url, recipient?, days? })` | `{ ok, requeued, days }` | Sends failed deliveries from the last `days` (default 1) again. |

`recipient` defaults to this account.

## `agents.find(agentId)`

An ERC-8004 agent's wallet and payee profile: `Promise<FoundAgent>`, with `agentId`, `wallet` (from the registry's `getAgentWallet` only, or `null` when the agent has set none: then don't pay it), `profile` (the `remesso` entry of its registration file, or `null`) and `note` (why either is missing). Reading an https or ipfs registration file needs the `fetchText` option. See [find agents](../guides/find-agents.md).

## `payLink(input)`

The link that opens a payer's Remesso form filled in: `string`. `to` defaults to this account. The other fields (`from`, `amount`, `token`, `every`, `runs`, `note`, `request`) are optional. See [pay links](../guides/payment-requests.md).
