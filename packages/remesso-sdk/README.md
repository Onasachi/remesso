# remesso-sdk

Recurring and agent payments on Celo, in TypeScript, on viem.

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

> **The contracts are live and have not been audited by a person.** There is no
> testnet: everything here moves real money on Celo mainnet. Start with small
> amounts, a dollar rather than a payroll.

The developer page walks through the same steps: https://remesso.xyz/developers

## Quickstart: a payment and its webhook

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
- Without a key, an identical payment within ten minutes is refused unless you
  pass `allowRepeat`.
- Agent payments are signed before they are sent, so they need a local account
  (`privateKeyToAccount`). The agent's key pays its own gas: send it a little
  CELO.

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
| `publicClient` | Your own viem public client. |
| `store` | Where agent payments are recorded so a retry pays once. Default: memory. |
| `fetchText` | Reads an https or ipfs registration file for `agents.find`: pass `safeFetchText`. |
| `attribution` | Tag transactions for ERC-8021 attribution. Default true. |

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
| `pay(input)` | As an agent, pay through a policy: `to`, `amount`, `token`, `policyId`, `memo`, `idempotencyKey`, `allowRepeat`, `waitMs`. |
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
| `requests.waitUntilPaid(id)` | Wait for a payment with a transaction. |
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
