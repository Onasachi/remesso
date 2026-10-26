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
| `remittanceStore` | `RemittanceStore` | `memoryRemittanceStore()` | Wallet-funded one-off progress, including the original signed creation and execution transactions. Use `fileRemittanceStore()` from `remesso-sdk/node` across restarts. |
| `invoiceStore` | `InvoiceStore` | `memoryInvoiceStore()` | Atomic reservations binding signed invoices to one funding route, signer, payer and payment key. Share it across worker processes and restarts. |
| `coordinator` | `SignerCoordinator` | process-local queue | Shared signer lock and nonce floor. Use the Postgres adapter together with both journals and its invoice store for multiple workers. |
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

## Agent-to-agent remittances (0.3.0-rc.1 source)

These methods are in the current source and are not yet published to npm. See the complete [agent-to-agent guide](../guides/agent-to-agent.md) and [production service guide](../guides/production-sdk.md).

### `remittances.send(input)`

| Field | Type | Description |
|---|---|---|
| `funding` | `"wallet" \| "policy"` | Required explicit funding source. Wallet mode spends this local account; policy mode spends its policy owner's funds. |
| `to`, `amount`, `token` | `string` | Exact recipient, decimal amount received and supported token symbol/address. |
| `idempotencyKey` | `string` | Required stable intended-payment key. Retry with identical terms and the same journal. |
| `requestId` | `string` | Optional exact one-off invoice. Recipient, amount, token and payer must match. Recurrence is refused. |
| `policyId`, `payer` | id, `string` | Policy mode only: select a policy and/or restrict its owner. |
| `waitMs` | `number` | From 1 to 120,000 ms. Default 45 seconds. Pending progress is recoverable with the same call. |
| `maxDebit` | `string` | Maximum decimal token debit including protocol fees; excludes network gas. |
| `validUntil` | `number` | Last Unix second when the SDK may start/resume the send. Wallet schedule expiry is capped by it. It cannot invalidate policy transaction bytes already broadcast. |

Returns `Promise<RemittanceResult>`, discriminated by `funding`. Both modes include `status`, `payer`, `to`, `token`, recipient `amount` in base units, and `fee`. Policy mode also has the existing `PaymentResult` fields. Wallet mode adds `amountIn`, `feeBps`, optional `scheduleId`, `approvalHash`, `createHash`, `executionHash`, `repeat`, and invoice binding progress in `request`. Its `hash` is present once an exact `RunExecuted` payment exists; a pending call may have no payment hash yet.

Wallet mode uses one immutable V5 schedule with `maxRuns: 1` and immediate sender execution. Signed progress is saved before broadcast. A key never creates another schedule, and the regular executor winning a race cannot create a second run. Fees and executor token/run limits apply. A replaced or missing original receipt is not proof of success. Fee-drift and cancellation conflicts must be reconciled using their reported transaction/schedule details.

### `remittances.quote(input, options?)`

Reads readiness without signing or broadcasting. Input has `funding`, `to`,
`amount`, `token`, optional `requestId`, `idempotencyKey`, and policy-only
`payer`/`policyId`. `options.ttlSeconds` is 1–300, default 60.

Returns `RemittanceQuote`: exact recipient `amount`, `grossDebit`,
`protocolFee`, `feeBps`, `selectedPolicyId`, approval targets, balance,
`canSend`, issues, step simulations, gas estimates, reference block and
`checkedAt`/`expiresAt`. Amounts are base-unit bigints. Gas steps identify
`rpc_estimate` or `conservative_hint`; wallet execution remains a hint until its
schedule and allowance exist. CELO estimates exclude fee-currency conversion.
Discovery and HTTP reads are not an atomic snapshot; a quote reserves nothing.

### `remittances.prepare(input, options?)`

Takes `send` input and quote options. Returns `{ quote, input }`, refusing an
unready quote or debit above `maxDebit`. Returned input pins the token, selected
policy, debit ceiling and expiry. Send `prepared.input` promptly. Bounds are
checked again during send; a prepared input does not guarantee later execution.

### Payment lifecycle

| Method | Behavior |
|---|---|
| `remittances.get(key, { funding? }?)` | Read saved terms and current canonical evidence without signing, broadcasting or mutating journals. |
| `remittances.listPending({ funding? }?)` | Read retained operations except finalized, failed, cancelled and expired ones. Includes paused operations requiring attention. |
| `remittances.reconcile(key, { funding?, waitMs? }?)` | Resume an existing key with its original terms and deadline. Unknown keys never create payments; consumed-nonce uncertainty requires investigation. |
| `remittances.wait(key, options?)` | Observe inclusion/finality; never sends. `finality` is included by default. `timeoutMs`: 1–86,400,000, default 20 minutes; `intervalMs`: 1–60,000, default 1,500; optional `signal` and `funding`. |
| `remittances.recoverPending(options?)` | One sequential recovery pass over existing pending keys. Optional `funding`, `waitMs`, `signal`, and `limit`: 1–1,000, default 25. Signal stops between operations. No recurring task is scheduled. |

Returns `PaymentOperation` with `key`, `funding`, `status`, `stage`, payer,
recipient, token, base-unit amount, creation time, available transaction and
policy/schedule IDs, optional verified `proof` and structured `error`. Stages
are creation, approval, execution, payment and cancellation. Statuses are
`prepared`, `awaiting_approval`, `signed`, `broadcast`, `included`, `finalized`,
`failed`, `cancelled`, `paused`, `expired`, `needs_reconciliation`.

An included state requires exact independent payment evidence. A finalized
verification conflict is never downgraded to included. Reads can discover a
regular executor's payment after a sender restart. If the same key exists in
both funding journals, specify `funding`. `wait()` throws on timeout, abort,
failed payments or cancelled/paused/expired schedules.

### `invoices`

| Method | Behavior |
|---|---|
| `invoices.sign(input)` | Sign exact invoice terms, optionally bound to an existing backend `requestId`. |
| `invoices.create(input)` | Create an exact one-off backend request, then sign its terms; an existing `requestId` is reused. |
| `invoices.verify(invoice, { allowExpired? }?)` | Validate schema, EIP-712 domain, identity, terms and expiry; returns `VerifiedInvoice` with terms-derived `id` and stable `idempotencyKey`. Does not pay. |
| `invoices.pay(invoice, options)` | Verify, atomically reserve funding identity, then remit exact signed terms. Requires `funding`; accepts policy-only `policyId`, plus `maxDebit` and `waitMs`. Returns the remittance result and `invoiceId`. |
| `invoices.verifyPayment(invoice, input)` | Check a transaction against signed invoice terms and any bound request; finalized by default. Returns `{ invoiceId, orderId, payment: PaymentProof }`. |

Signing takes `payer`, exact decimal `amount`, supported `token`, `orderId` and
Unix-second `expiresAt`. Optional `recipient` defaults to the signing account;
V1 requires the recipient to be its issuer. `nonce` defaults to 32 random bytes;
`issuedAt` defaults to now. Preserve both when reconstructing an invoice.
`requestId` binds an existing exact one-off request.

Payment verification takes `txHash`, optional `policyId` or `scheduleId`, and
`finality`. Expired invoices remain verifiable if payment inclusion fell within
their signed validity window. Persist invoice ID, payment event ID and
issuer/order atomically with fulfillment; signature verification alone prevents
neither repeated business effects nor cross-worker replay.

### Optional server and framework adapters

| Entry | API |
|---|---|
| `remesso-sdk/postgres` | `createPostgresStorage(postgresClient, { namespace?, jobLeaseMs?, heartbeatMs? })` returns initialization, both journals, invoice store, signer coordinator, fenced jobs and transactional fulfillment inbox. Requires direct/session PostgreSQL connections and a trusted server role. |
| `remesso-sdk/dev` | `startDev(options?)` starts an owned local Celo fork and receiving emulator, returning clients, settings, sample invoice, smoke test and cleanup. Requires `anvil`; public test keys stay local. |
| `remesso-sdk/signers` | `managedSigner({ address, signTransaction, signTypedData, signMessage? })` returns a viem local account. Callbacks sign only; exact Celo transaction fields and returned signatures are validated. |
| `remesso-sdk/tools` | `createAgentTools(client, { authorizeWrite?, enableWrites? }?)` returns tool definitions, schemas, `list()` and `call(name, input)`. Writes are denied by default; the trusted host must authorize exact inputs. |

Postgres signed transaction evidence protects nonce coordination for generic
contract writes; it does not add application idempotency to a new policy or
schedule creation. See the [production guide](../guides/production-sdk.md) for
working configuration and fulfillment examples. Managed signer testing covers
the callback boundary, rather than a certified named custody provider.

### `agents.pay(agentId, input)`

Uses `remittances.send` after verifying the agent's registry wallet and supported payment profile. Requires `funding`; with `requestId`, amount/token come from that invoice and the key defaults to `request:<id>`. Without a request, require `amount`, `token` and `idempotencyKey`. Optional `expectedWallet` pins the approved counterparty; `policyId`/`payer` apply only to policy funding. Returns the remittance result plus `counterparty: { agentId, wallet }`.

It refuses missing/unreadable profiles, unsupported Celo assets, missing required references, invoices addressed to another recipient and a wallet that changes during preparation. It never follows a profile URL as an alternative payment backend.

### `receipts.verify(input)`

Requires `txHash`, `from` (the actual funds owner), `to`, supported `token` and exact decimal `amount` received. Optional `policyId` or `scheduleId` identifies the payment; they cannot be combined. Optional UTF-8 `memo` matches a policy payment's invoice reference. `finality` is `"included"` by default or `"finalized"`.

Returns `Promise<PaymentProof>` with stable `eventId`, `chainId`, known `contract`, `txHash`, `logIndex`, `blockNumber`, `blockHash`, funds owner, recipient, token, base-unit amount and checked finality. Policy proofs have `kind: "policy_payment"`, `policyId`, `agent`, `memo`, `callerVerified`; run proofs have `kind: "run"`, `scheduleId`, `amountIn`, `runNumber`. It checks historical contract state, original successful receipt and canonical block identity before and after reads. Ambiguous matches and wrong terms fail. Finalized checks fail closed when the RPC lacks the finalized tag. Historical reads require a suitable RPC. Ordinary receipts do not expose internal smart-contract callers; those policy proofs report `callerVerified: false`.

Persist `eventId` uniquely with fulfillment. Verification does not itself authenticate an invoice or deduplicate your business effects.

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

Returns `Promise<PaymentResult>`: `status` (`"confirmed"` or `"pending"`), `hash`, `policyId`, `to`, `amount` (base units), `token`, `sent` (for example `"1.5 USDT"`), `explorer` (a Celoscan link) and `repeat` (true when this key had already paid and nothing new was sent). On `"pending"`, call again with the same key.

Errors: `refused` (outside the policy, revoked or expired), `key_reused`, `repeat`, `no_account` (no local account), `no_gas`, `reverted`.

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
