# remesso-sdk

Agent-to-agent remittances on Celo, in TypeScript, on viem. Build agents that
request payments, pay other agents and verify settlement before fulfilling an
order, using either the agent's own wallet or a delegated treasury policy.

- **Schedules:** a payer signs once, on-chain, a fixed amount to a fixed
  address on a fixed cadence. Remesso's executor sends each payment when it is
  due. Nothing can change the recipient, the amount or the cadence afterwards;
  cancelling is the only edit.
- **Agent payments:** a person grants their agent's key a policy (one token, a
  cap per payment and per day, an expiry). The agent pays from the person's
  wallet, and the contract refuses anything outside the policy. A payment
  retried with its idempotency key pays once.
- **Payment requests:** ask a wallet to pay you, and see when it's paid.
- **Payment events and signed webhooks:** know you were paid without running a
  node.

> **The default client uses live Celo mainnet contracts, which have not been
> audited by a person.** The local development fork below provides a place to
> test without spending real money.

The developer page walks through the same steps: https://remesso.xyz/developers

## Build an agent-to-agent application

The seller creates a fixed, one-off invoice addressed to the funding wallet.
Your application approves the order; the SDK moves the funds and produces
evidence your receiver can independently check.

```ts
import { createRemesso } from "remesso-sdk";
import { fileRemittanceStore, fileStore, safeFetchText } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const buyer = createRemesso({
  account: privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`),
  store: fileStore("./state/policy-payments.json"),
  remittanceStore: fileRemittanceStore("./state/wallet-remittances.json"),
  fetchText: safeFetchText,
});

// Pay from this agent's own wallet. amount is what the recipient receives.
const sent = await buyer.remittances.send({
  funding: "wallet",
  to: process.env.SELLER_ADDRESS!,
  amount: "1",
  token: "USDT",
  requestId: process.env.REQUEST_ID!,
  idempotencyKey: `request:${process.env.REQUEST_ID!}`,
});
console.log(sent.status, sent.hash);
```

Choose `funding: "policy"` and optionally `policyId` to spend a treasury's or
person's funds under an existing policy. The invoice's payer must be that
policy owner. Policy payments have no protocol fee. Wallet payments use one
V5 mandate capped at one run and sender `runNow`; the gross debit includes
the pinned V5 fee. They use the existing token/run limits and event indexer.

For a registered counterparty, `buyer.agents.pay(agentId, { funding: "wallet",
requestId, expectedWallet })` resolves the wallet from ERC-8004, enforces the
published Celo token and reference requirements, and defaults the retry key
to the request id. Use policy funding the same way with `funding: "policy"`.

The receiver calls `reader.receipts.verify({ txHash, from, to, token, amount,
scheduleId, finality: "finalized" })`, or supplies `policyId` and the request
reference as `memo` for a policy payment. This checks the actual event and
immutable funding terms on-chain. Persist the returned `eventId` atomically
with fulfillment so a replay cannot deliver an order twice.

An invoice amount is exact; the one-off path rejects recurring or unspecified
terms. A `pending` payment may still be paid: retry it with the same key and
terms, never a new key, and the SDK continues that one payment. A wallet
payment that can't be completed has its schedule cancelled first, and is
reported as not paid (`refused`, with `details.cancelled`) only once that has
landed. Both journals default to memory unless configured above. File stores
need one process per signer; use shared Postgres coordination for multiple
workers. Only a verified `RunExecuted` or `Paid` transaction proves payment.

See the full [agent-to-agent guide](../../docs-site/docs/guides/agent-to-agent.md)
and runnable [buyer/seller example](../../examples/agent-to-agent.ts).

## Build and test locally

With Node 20+ and Foundry's `anvil` installed:

```bash
npx remesso-sdk dev --smoke
```

This starts a local fork of Celo, funds public test accounts, creates a sample
invoice, pays once from a wallet and once from a policy, checks both with a
signed webhook receiver, and stops. `npx remesso-sdk dev` keeps it running and
prints the settings to use. The backend is an in-memory stand-in, so production
cron and public webhook networking need separate tests. Never fund its public
test keys on a real network. From this repository, `npm run dev:smoke` in
`packages/remesso-sdk` builds and runs the same.

## Run multiple agent workers

Install `postgres@3.4.5` and share the same database, namespace and all four
options across processes using a signing wallet:

```ts
import postgres from "postgres";
import { createRemesso } from "remesso-sdk";
import { createPostgresStorage } from "remesso-sdk/postgres";
import { privateKeyToAccount } from "viem/accounts";

const sql = postgres(process.env.DATABASE_URL!, {
  max: 8,
  connection: { synchronous_commit: "on" },
});
const storage = createPostgresStorage(sql, { namespace: "my-agent-service" });
await storage.initialize();
const agent = createRemesso({
  account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`),
  store: storage.paymentStore,
  remittanceStore: storage.remittanceStore,
  invoiceStore: storage.invoiceStore,
  coordinator: storage.coordinator,
});
```

`createRemesso` refuses a `coordinator` without the three stores: with journals
in memory, each worker would keep its own keys and a retry on another worker
would pay again. Use direct PostgreSQL or session pooling. The advisory lock
covers signing and broadcast, and connection loss fails closed. Keys and signed
bytes are retained; keep the SDK tables private. Before signing anything, the
SDK sends again any saved transaction the chain hasn't mined, or cancels one
past its deadline at its nonce, so a lost broadcast can't hold up the rest.
[POSTGRES.md](./POSTGRES.md) covers jobs, fenced acknowledgements and atomic
invoice fulfillment.

## Prepare, observe and recover

```ts
const prepared = await agent.remittances.prepare({
  funding: "wallet", to: receiverAddress, amount: "1", token: "USDT",
  idempotencyKey: "order-123", maxDebit: "1.01",
}, { ttlSeconds: 60 });
const sent = await agent.remittances.send(prepared.input);
const operation = await agent.remittances.get("order-123", { funding: "wallet" });
const recovered = await agent.remittances.recoverPending({ limit: 25, waitMs: 5000 });
```

`quote()` reads approval, fee, budget, simulation and gas details. `prepare()`
fixes the token, policy and maximum debit, and sets `startBy` to the quote's
expiry: the payment must start by then, and once started it continues. Neither
reserves funds. `validUntil` is a hard deadline: a wallet payment's schedule
expires before it, and a policy payment still unsent near it is cancelled.
`get`/`listPending` only read; `reconcile` and `recoverPending` continue payments
that have started and never start one; `wait(key, options)` observes finality.

Signed invoices add authenticated order terms:

```ts
const invoice = await seller.invoices.create({
  payer: buyer.address, amount: "1", token: "USDT", orderId: "order-123",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});
const paid = await buyer.invoices.pay(invoice, { funding: "wallet", maxDebit: "1.01" });
if (paid.status === "confirmed" && paid.hash) {
  const proof = await seller.invoices.verifyPayment(invoice, {
    txHash: paid.hash,
    ...(paid.funding === "wallet" ? { scheduleId: paid.scheduleId } : { policyId: paid.policyId }),
    finality: "finalized",
  });
  console.log(proof.invoiceId, proof.payment.eventId);
}
```

Finalized verification may need a later retry. Atomically dedupe the invoice ID,
payment event ID and issuer/order with your business writes before fulfillment.
The shared invoice store pins funding route and key across worker restarts. An
invoice signed without a request (`invoices.sign`) is tied to its payment only
by the memo `invoiceReference(id)`, so it is paid from a policy.

Optional adapters stay separate from the root browser entry:

| Entry | Purpose |
|---|---|
| `remesso-sdk/postgres` | Shared journals, signer locks, nonce evidence, jobs and fulfillment inbox. |
| `remesso-sdk/dev` | Programmatic owned local fork and receiving emulator. |
| `remesso-sdk/signers` | `managedSigner` sign-only callbacks, checking exact Celo transaction fields and recovered signatures. |
| `remesso-sdk/tools` | `createAgentTools` JSON schemas and structured results; writes denied unless the trusted host authorizes them. |

Managed signer support is tested at the callback boundary; no named custody
provider integration is certified. Callbacks must never broadcast. Build the
repository MCP stdio server with `npm --prefix mcp run build` before starting
it; its generic SDK write tools need explicit host authorization.

See the [production service guide](../../docs-site/docs/guides/production-sdk.md)
for complete invoice verification, database fulfillment, signer and tool examples.

## Scheduled payment and webhook quickstart

About 15 minutes, most of it waiting. Node 20 or later.

**1. Install**, in a new folder. The SDK is ES modules only, and `tsx` runs
TypeScript without a build.

```bash
npm init -y && npm pkg set type=module
npm install remesso-sdk viem
npm install -D tsx
```

**2. Make two keys**, one that pays and one that receives. Save this as
`keys.ts` and run `npx tsx keys.ts` twice:

```ts
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
console.log(key, privateKeyToAccount(key).address);
```

Send the payer about **1.05 USDT** on Celo, and a little CELO for gas if you
have it. With no CELO, the SDK pays gas in USDT. The receiver needs nothing.
Use keys that hold only what you are willing to lose.

```bash
export PAYER_KEY=0x… RECEIVER_KEY=0x… RECEIVER=0x…
```

**3. Run a receiver.** In one terminal, open a public HTTPS address to port
8787. A Cloudflare quick tunnel needs no account, and prints a
`trycloudflare.com` URL:

```bash
cloudflared tunnel --url http://localhost:8787
```

Then save this as `receiver.ts`:

```ts
import { createServer } from "node:http";
import { createRemesso, formatAmount, webhookHandler } from "remesso-sdk";
import { toNodeListener } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const receiver = createRemesso({
  account: privateKeyToAccount(process.env.RECEIVER_KEY as `0x${string}`),
});

// Remesso returns the signing secret once your endpoint has answered its
// challenge, so the handler reads it when each delivery arrives.
let secret: string | undefined;

const handler = webhookHandler({
  recipient: receiver.address,
  secret: () => secret,
  onPayment: (m) =>
    console.log(m.type, formatAmount(m.data.amount, m.data.token), m.data.final ? "final" : "not final yet", m.data.txHash),
});

const server = createServer(toNodeListener(handler));
await new Promise<void>((done) => server.listen(8787, done));
```

**4. Subscribe.** Add these lines to the end of `receiver.ts`, and run it with
the tunnel's URL: `PUBLIC_URL=https://….trycloudflare.com npx tsx receiver.ts`.
Remesso first posts a challenge to the URL; the handler answers it for your
address only, and the signing secret comes back once.

```ts
const sub = await receiver.webhooks.subscribe({ url: process.env.PUBLIC_URL! });
secret = sub.secret; // shown once: save it if the receiver must survive a restart
console.log("subscribed", sub.subscription, "for", receiver.address);
```

A quick tunnel gets a new URL each time it starts, and an address can hold 5
subscriptions: drop old ones with `webhooks.revoke({ url })`.

**5. Pay.** In a second terminal, save this as `pay.ts` and run
`npx tsx pay.ts`. One payment of 1 USDT, the smallest the executor sends: it
approves the contract and creates the schedule, two transactions.

```ts
import { createRemesso, formatAmount } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const payer = createRemesso({
  account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`),
});

const s = await payer.schedules.create({
  to: process.env.RECEIVER!,
  amount: "1",
  token: "USDT",
  every: "week",
  runs: 1,
});
console.log("schedule", s.id, "pays", formatAmount(s.recipientGets, "USDT"), s.hash);
```

**6. Watch the receiver's terminal.** Remesso finds a schedule created outside
its app within about 5 minutes, and sends the payment within a minute of that.
A minute or two later the handler gets `payment.received` with `final: false`:
0.9975 USDT, after the 0.25% fee. `payment.finalized` follows when Celo
finalizes the block, 25 to 30 minutes later. A failed delivery is retried with
the same `webhook-id` for 24 hours, so dedupe on it.

No public endpoint? Pull the same events instead:

```ts
for await (const e of receiver.events.watch({ role: "to", kinds: ["run", "policy_payment"] })) {
  console.log(e.kind, formatAmount(e.amount!, e.token!), e.final ? "final" : "not final yet", e.txHash);
}
```

## Getting paid by request

The request lands in the payer's Remesso inbox, and the link opens their form
filled in. It carries `req=`, so the schedule they sign is reported against
your request. Nothing is authorised until they sign in their own wallet.

```ts
const req = await receiver.requests.create({
  payer: "0xTheirWallet",
  amount: "50",
  token: "USDT",
  every: "month",
  runs: 12,
  from: "Ada's studio",
  note: "monthly retainer",
});
console.log(req.link); // send it however you already reach them

const paid = await receiver.requests.waitUntilPaid(req.id);
console.log(paid.payment?.txs);
```

A requested amount is what you receive: the payer's form signs `grossFor` of
it, the amount plus the fee. Accepted is not paid; `waitUntilPaid` waits for a
payment with a transaction. A payer using the SDK answers with the request's
own terms:

```ts
await payer.schedules.create({ request: req.id }); // the request's terms, the fee on top
```

## Agent payments

A person gives their agent's key a policy at https://remesso.xyz/agent-wallet,
or in code. No fee: what the agent pays is what arrives.

```ts
// The person, once:
await person.policies.create({
  agent: "0xAgentAddress",
  token: "USDT",
  perPayment: "5",
  perDay: "20",
  days: 30,
  budget: "100", // added to their USDT approval for the allowance contract
});
```

`budget` increases the owner's token approval, shared by all their policies
for that token. The contract has no lifetime cap per policy. Its daily cap
uses fixed 24-hour windows; payments across a boundary can total up to twice
`perDay` in a short period. Size the approval, caps and expiry together.

```ts
import { createRemesso } from "remesso-sdk";
import { fileStore } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const agent = createRemesso({
  account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`),
  store: fileStore(), // the record that makes a retry pay once, kept on disk
});

const r = await agent.pay({ to: "0xShop", amount: "2.50", token: "USDT", idempotencyKey: "order-1042" });
// r.status is "confirmed", or "pending": call again with the same key, never a new one

await agent.requests.pay(requestId); // its reference goes in the memo, so the requester sees it
```

- A retry with the same idempotency key pays once, even when the first attempt
  timed out after it was sent. `fileStore` keeps that record on disk, so it
  holds across restarts; the default store is memory.
- Keys are scoped to the signing agent, chain and contract. Reusing a key
  with another token, policy, payer, recipient, amount or memo is refused.
  Keys and unresolved signed payments are retained until you explicitly
  archive the store; deleting history removes the retry protection.
- Use one process per `fileStore` file. Clients for the same signer within
  that process share a transaction queue. Multiple worker processes need
  durable storage and external coordination for the signer and payment keys.
- If a nonce was consumed and the original receipt cannot be found, the SDK
  refuses to sign another payment. Reconcile the reported hash before retrying
  with a new key. An unreadable or corrupt store also refuses new payments.
- `confirmed` means a successful receipt with the matching `Paid` event,
  not finality. Retries recheck that receipt. For fulfillment that needs
  finality, use `payment.finalized`, or `requests.waitUntilPaid(id, { final: true })`.
- Without a key, an identical payment within ten minutes is refused unless you
  pass `allowRepeat`.
- Agent payments are signed before they are sent, so they need a local account
  (`privateKeyToAccount`). The agent's key pays its own gas: send it a little
  CELO.

## Builder codes

Celo credits on-chain volume to the app that caused it, by the ERC-8021 code
on each transaction
([attribution tags](https://github.com/celo-org/attribution-tags)). Pass your
own, and every transaction this client sends carries it after Remesso's.
Remesso's executor then carries it on every run of each schedule the client
creates, so the volume a schedule moves counts for you too, for as long as it
runs.

```ts
import { createRemesso } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const payer = createRemesso({
  account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`),
  builderCodes: ["your_code"],
});
const s = await payer.schedules.create({ to: "0xRecipient", amount: "5", token: "USDT", every: "month", runs: 12 });

// A minute later, what Remesso read from the transaction that created it:
const { events } = await payer.events.list({ role: "from", kinds: ["schedule_created"] });
console.log(events.find((e) => e.refId === s.id.toString())?.details?.builderCodes); // ["your_code"]
```

- Up to three codes, each 1 to 32 of `a-z`, `0-9` and `_`. The SDK refuses
  anything else before signing, by the rules the executor applies.
- Without the SDK, tag your own `createSchedule` transaction with
  `toDataSuffix` or `withAttribution` from `@celo/attribution-tags`. Only
  Schema 0, the one they write, is read. A schedule created through an
  ERC-4337 bundle isn't read yet: the codes come from the outer transaction.
- The suffix sits after the calldata, where the EVM ignores it. A code
  changes who is credited, never what a payment does.

## What it costs

- **0.25% of each scheduled payment**, taken from it and rounded up: a 1 USDT
  payment delivers 0.9975. Policy payments carry no fee. Receiving costs
  nothing.
- **Per payment, the executor sends the equivalent of 1 to 1,000 dollars**: 1
  to 1,000 USDT, USDC, USA₮ or USDm; 1,500 to 1.5 million wARS; 5 to 5,000
  wBRL; 3,200 to 3.2 million wCOP; 1,300 to 1.3 million cNGN. Outside that a
  schedule is valid on-chain and never runs, so the SDK refuses it before
  signing. `runLimits(token)` gives the bounds, and
  `https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` publishes them
  under `limits.perRun`.
- **Gas, measured on our own transactions, not promised:** creating a schedule
  is about 224,000 gas (about $0.004) plus an approval, paid by the payer. Each
  payment is about 91,875 gas, paid by Remesso's executor. A policy payment is
  about 85,000 gas, paid by the agent. That was at 202 gwei with CELO near
  $0.09; the numbers move with both.

## API

### `createRemesso(options)`

| Option | |
|---|---|
| `account` | The key that pays, signs and receives: `privateKeyToAccount(...)`. Leave it out to read only. |
| `walletClient` | A wallet client instead of an account, such as a browser wallet on Celo. |
| `rpcUrl` | Default `https://forno.celo.org`. |
| `publicClient` | Your own viem public client. For agent payments configure it with `chain: celo`. |
| `store` | Where agent payments are recorded so a retry pays once. Default: memory. |
| `fetchText` | Reads an https or ipfs registration file for `agents.find`: pass `safeFetchText`. |
| `attribution` | Tag transactions for ERC-8021 attribution. Default true. |
| `builderCodes` | Your own ERC-8021 codes, up to three: on every transaction this client sends, and on every run of the schedules it creates (see Builder codes). |

The client:

| | |
|---|---|
| `address` | This client's address, or null when it only reads. |
| `schedules.create(input)` | Approve and create a schedule. `amount` (what you send each time) or `receive` (what arrives); `token`, `every`, `runs`, `firstRunAt`, `trigger`, `request`. Refuses amounts outside the per-run limits before signing. |
| `schedules.get(id)` | The schedule as the contract stores it, with what the recipient gets per payment. |
| `schedules.status(id)` | Whether a payment is due, funded and approved. |
| `schedules.list(sender?)` | The ids of every schedule a sender created. |
| `schedules.cancel(id)` | Stop it for good. |
| `schedules.setActive(id, active)` | Pause or resume. |
| `schedules.setTrigger(id, trigger, count)` | Change who may bring a payment forward; `"remesso"` grants Remesso's executor. |
| `pay(input)` | As an agent, pay through a policy: `to`, `amount`, `token`, `policyId`, optional `payer`, `memo`, `idempotencyKey`, `allowRepeat`, `waitMs` (1–120,000 ms). |
| `policies.find(agent?)` | Every policy naming an agent, newest first. |
| `policies.get(id)` | A policy, with what it can spend right now. |
| `policies.create(input)` | As the owner: approve a budget and create a policy. |
| `policies.revoke(id)` | As the owner: end it now. |
| `policies.setRecipient(id, recipient, allowed)` | As the owner: edit the allowlist. |
| `requests.create(input)` | Ask a wallet to pay you. Returns the id, the reference and the link. |
| `requests.get(id)` | Where a request stands, its payer, and its payments. |
| `requests.list(payer?)` | The live requests addressed to a wallet. |
| `requests.answer(id, scheduleId)` | Report the schedule that answers a request. |
| `requests.decline(id, { policyId? })` | Turn a request down, signed by the payer or by its agent under a policy. |
| `requests.pay(id)` | As an agent, pay a request through a policy, its reference as the memo. |
| `requests.waitUntilPaid(id, options?)` | Wait for a payment with a transaction. Pass `{ final: true }` to wait for a finalized payment. |
| `events.list(query)` | Payment events by address, role and kind, paged by `seq`. |
| `events.watch(query)` | Every event from `after` on, then each new one or change. |
| `events.waitFor(match, query)` | The first event that matches. |
| `webhooks.subscribe({ url })` | Start receiving this address's payments at `url`. Returns the signing secret once. |
| `webhooks.rotate({ url })` | A new secret; the old one keeps signing alongside it for a day. |
| `webhooks.revoke({ url })` | Stop. |
| `webhooks.replay({ url, days })` | Send failed deliveries again. |
| `agents.find(agentId)` | An ERC-8004 agent's wallet, from `getAgentWallet` only, and its payee profile. |
| `payLink(input)` | The link that opens a payer's form prefilled, to this account by default. |

### Exports

| | |
|---|---|
| `createRemesso`, `Remesso`, `RemessoOptions` | The client. |
| `webhookHandler(options)` | A fetch-style `(Request) => Promise<Response>` handler: answers the challenge for your address, verifies every delivery, calls `onPayment`. |
| `verifyWebhook(raw, headers, secrets)` | Whether a delivery was signed with one of your secrets in the last five minutes. |
| `parseWebhook(raw, headers, secrets)` | A verified delivery, parsed; throws otherwise. |
| `payLink(input)`, `parsePayLink(url)` | Build a pay link, or read one, keeping only what validates. |
| `feeOf`, `netOf`, `grossFor` | The commission in base units, rounded up as the contract rounds it. |
| `token`, `findToken` | A token by symbol (USAT for USA₮) or address. |
| `toUnits`, `formatAmount` | Decimal strings to base units and back. |
| `runLimits(token)` | The per-run bounds the executor sends. |
| `memo32(memo)` | A memo as bytes32, refused over 32 bytes. |
| `memoryStore()` | The default payment store. |
| `deployment` | Celo mainnet as Remesso runs it, generated from what is live. |
| `CHAIN_ID`, `EXECUTOR`, `ALLOWANCE`, `REGISTRY`, `CURRENT_EXECUTOR`, `FEE_BPS` | The chain, the contracts, Remesso's trigger sentinel and the commission. |
| `executorAbi`, `allowanceAbi`, `erc20Abi`, `registryAbi` | ABIs. |
| `ATTRIBUTION` | The ERC-8021 suffix the SDK adds to transactions. |
| `attributionFor(builderCodes)` | That suffix with your codes after ours, checked by the executor's rules: for a transaction you send yourself. |
| `CADENCES` | `week`, `fortnight`, `month` and `quarter`, in seconds. |
| `RemessoError` | Every refusal; see the codes below. |

Types: `Cadence`, `CreateScheduleInput`, `CreatedSchedule`, `Schedule`,
`PayInput`, `PaymentResult`, `Policy`, `CreatePolicyInput`,
`CreateRequestInput`, `RequestState`, `RequestStatus`, `RequestSummary`,
`EventKind`, `EventQuery`, `PaymentEvent`, `WebhookHandlerOptions`,
`WebhookMessage`, `WebhookType`, `FoundAgent`, `PayeeProfile`, `PayLink`,
`PayLinkInput`, `PaymentRecord`, `PaymentStore`, `Token`.

### `remesso-sdk/node`

| | |
|---|---|
| `fileStore(path?)` | Agent payment records in a 0600 JSON file, default `~/.remesso-sdk/payments.json`. One process per file. |
| `safeFetchText(url)` | Fetches a remote registration file only from public addresses, connecting to the address it checked. |
| `toNodeListener(handler)` | Runs a fetch-style handler under `http.createServer` or Express. Mount it before any JSON body parser. |

## Errors

Every refusal is a `RemessoError` with a `code` (type `RemessoErrorCode`):

| Code | |
|---|---|
| `invalid` | The input is wrong: an address that isn't one, an unknown token, an amount out of range. |
| `wrong_chain` | The RPC isn't Celo mainnet, so nothing is signed. |
| `no_account` | A write needs an account and none was given. |
| `refused` | The contract or Remesso's backend would refuse it, caught before anything was sent. |
| `conflict` | Already done or taken: a subscription that exists (rotate its secret instead), a request already answered, a nonce already spent. |
| `reverted` | Mined, and reverted: nothing moved. |
| `no_gas` | Neither CELO nor a token that can pay for gas. |
| `key_reused` | An idempotency key already used for a different payment. |
| `repeat` | An identical payment went out minutes ago and no idempotency key was given. |
| `http` | A Remesso endpoint answered with an error. |
| `not_found` | A request, a schedule or a subscription that doesn't exist. |
| `timeout` | Waited, and it didn't happen in time. |

## Links

- Developer page: https://remesso.xyz/developers
- The same endpoints over plain HTTP: https://bitbucket.org/crackedstudios/remesso/src/main/docs/AGENTS.md
- Example agents: https://bitbucket.org/crackedstudios/remesso/src/main/examples/
- Every endpoint, the contracts and the registrations: https://remesso.xyz/.well-known/agent.json
- Source: https://bitbucket.org/crackedstudios/remesso

MIT licensed.
