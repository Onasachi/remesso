---
title: Errors
description: Every RemessoError code the SDK throws, what causes it, and what to do about it.
---

This page lists every error code remesso-sdk throws, with its usual causes and what to do.

## Catch and branch on the code

Every refusal is a `RemessoError` with a `code`, so you can tell "this would never run" from "the network is down" without reading the message. The message is written for a person and says what was wrong.

```ts
import { RemessoError } from "remesso-sdk";

try {
  await payer.schedules.create({ to: "0xRecipient", amount: "1", token: "USDT", every: "month", runs: 12 });
} catch (e) {
  if (!(e instanceof RemessoError)) throw e; // an RPC or network failure, not a refusal
  switch (e.code) {
    case "invalid":
    case "refused":
      console.error("fix the request:", e.message);
      break;
    case "no_gas":
      console.error("fund the payer:", e.message);
      break;
    case "reverted":
      console.error("mined and reverted:", e.details?.hash);
      break;
    default:
      throw e;
  }
}
```

`e.details` carries more where the SDK has it:

| When | `details` |
|---|---|
| A Remesso endpoint answered with an error | `status`, the HTTP status, and `body`, its JSON answer |
| A transaction reverted | `hash` |
| An identical payment went out minutes ago (`repeat`) | `hash` of that payment |
| The contract's simulation refused a write | `cause`, the underlying error as text |
| A transaction succeeded but its id couldn't be read | `hash` |

:::note
Errors from the RPC itself, such as a network failure while reading the chain or a receipt that doesn't arrive in time, come from viem unchanged. They are not `RemessoError`s.
:::

## How endpoint answers map to codes

When a Remesso endpoint refuses a call, the SDK turns the HTTP status into a code: `400` is `invalid`, `404` is `not_found`, `409` is `conflict`, `401`, `403` and `429` are `refused`, and anything else, or an endpoint that can't be reached, is `http`. The message is the endpoint's own `error`, with its `detail` after it.

## Codes

### invalid

**The input is wrong.** Retrying the same call won't help: change it.

- An address that isn't one: `not an address: 0x12`.
- A token Remesso doesn't take: `unknown token XYZ: Remesso takes USDT, USDC, ...`.
- An amount that isn't a decimal string, or has more decimals than the token: `USDT has 6 decimals; 1.0000001 has 7`.
- A schedule that can't be what you meant:
  - `to is this wallet: a schedule paying itself only loses the fee`;
  - `give amount (what you send each time) or receive (what arrives), not both`;
  - `runs is required: how many payments`;
  - `firstRunAt is in the past`;
  - `every, in seconds, must be a whole number of at least 3600`.
- A memo over 32 bytes, a request id that isn't one, or an empty `idempotencyKey`.
- A builder code Remesso's runs wouldn't carry. `createRemesso` throws this, for example `builder code "Acme": 1 to 32 of a-z, 0-9 and _, as Celo's attribution codes are`.
- An endpoint answered `400`. For example, a webhook endpoint that didn't answer its challenge: `the endpoint didn't confirm the subscription: the endpoint answered 404`.
- `parseWebhook` was given a body that isn't a payment message.

**What to do:** fix the input the message names.

### wrong_chain

**The RPC isn't Celo mainnet, so nothing is signed:** `the RPC answers chain 44787, not Celo mainnet (42220), so nothing is signed`.

The SDK asks the RPC for its chain id before the first write and refuses anything but `42220`. Remesso runs on Celo mainnet only, and there is no testnet.

**What to do:** point `rpcUrl` or `publicClient` at Celo mainnet. The default, `https://forno.celo.org`, is.

### no_account

**A call needs an account, and the client has none, or one that can't do this:**

- a read-only client (no `account` or `walletClient`) creating a schedule, paying, declining a request or managing webhooks;
- an agent payment from a `walletClient` whose account lives in a browser wallet: `agent payments are signed before they're sent, which needs a local account (privateKeyToAccount)`.

**What to do:** create the client with an `account` (`privateKeyToAccount(...)`) or a `walletClient` that has one. Agent payments need a local account, because the SDK records the signed transaction before sending it.

### refused

**Remesso's contracts or its backend would refuse this, and nothing was sent.** The SDK simulates every write first, and checks Remesso's own rules before that, so a refusal costs no gas.

- **Outside the executor's per-payment limits:** `Remesso's executor sends 1 USDT to 1,000 USDT per payment, and this is 0.5 USDT. A schedule outside that is valid on-chain and never runs.` See [tokens and limits](./tokens-and-limits.md).
- **A token the executor doesn't take for new schedules:** `the contract doesn't take XYZ for new schedules`.
- **Too long a schedule:** `60 payments every 7 days don't fit in a schedule's year`.
- **The contract's own reason**, from the simulation. For example, `the contract would refuse createSchedule: the token refused the transfer: the balance or the approval is too low`.
- **A policy that doesn't allow this payment:**
  - `no active policy names this agent for USDT: its person sets one up first`;
  - `policy 12 was revoked by its owner`, or `policy 12 has expired`;
  - `0.06 USDT is over what policy 12 allows right now (0.05 USDT)`;
  - `the policy refuses this payment: today's cap is used up; it resets 24 hours after the day's first payment`.
- **A request in the wrong state, or for someone else:** `request ... is declined, so it isn't paid`, or `request ... was sent to 0x..., not to 0x...`.
- **A webhook signature that doesn't verify:** `the webhook signature doesn't verify`, from `parseWebhook`.
- **An endpoint answered `401`, `403` or `429`:**
  - `this address already has 5 webhook subscriptions: revoke one first`;
  - `this wallet already has the maximum pending requests: ...`;
  - `the signature is not from the recipient address`.

**What to do:** read the message. It names the limit, the policy or the state that stood in the way. Nothing was sent, so you can fix it and try again.

### conflict

**Already done, or taken.** An endpoint answered `409`.

- Subscribing a URL that is already subscribed for the address: `this url is already subscribed for this address: rotate its secret or revoke it`.
- Answering a request with a schedule that can't answer it: `that schedule can't answer this request: it was made before the request`, or `that schedule or payment already answers another request`.
- Declining a request that is no longer pending: `this request is already accepted`.
- A schedule the backend hasn't seen on-chain yet: `that schedule hasn't been seen on-chain yet; try again in a minute`. `requests.answer` retries this one by itself for up to 90 seconds before giving up.

**What to do:** check the current state, with `requests.get`, `schedules.get` or `webhooks.rotate`, rather than repeating the call.

### reverted

**The transaction was mined and reverted, so nothing moved.** The gas was spent. `details.hash` is the transaction, and the message links it on Celoscan.

The state changed between the simulation and the block: a balance or an approval spent elsewhere, or a policy revoked in between. For an agent payment, a retry with the same key reports it again: `this key's payment reverted on-chain, so nothing was paid: ... Use a new key to try again.`

**What to do:** look at the transaction, fix the cause, and try again. For an agent payment, use a new idempotency key: the old one stays tied to the payment that reverted.

### no_gas

**The account can't pay for gas.** It doesn't hold enough CELO, and doesn't hold a token that can pay gas through Celo's fee abstraction: `0x... has 0 CELO, and this costs about 0.06. Send it a little CELO, or hold some USDT, which can pay for gas.`

The SDK pays gas in CELO when the account has enough, and otherwise in the token being sent, for the tokens that support it. [Tokens and limits](./tokens-and-limits.md) shows which do. An agent pays its own gas, so its key needs a little CELO, or a balance of the policy's token.

**What to do:** send the account a little CELO, or some of a token that pays gas.

### key_reused

**An idempotency key was already used for a different payment:** `idempotency key "invoice-1" was already used for a different payment (0.02 USDT to 0x...)`.

A key stands for one intended payment. The same key with a different recipient, amount or token is refused, so a mistake can't pay twice under one key.

**What to do:** for a retry, send exactly the first call's details again. For a new payment, use a new key.

### repeat

**An identical payment went out in the last ten minutes, and no idempotency key was given:** `an identical payment went out in the last 10 minutes: ... Pass allowRepeat to pay again, or an idempotencyKey to make retries safe.` `details.hash` is the earlier payment.

"Identical" means the same policy, recipient, amount and memo. The check stops a retry without a key from paying twice.

**What to do:** give every agent payment an `idempotencyKey`, such as an invoice or order id. If you really mean a second identical payment, pass `allowRepeat: true`.

### http

**A Remesso endpoint failed:** it answered with a status other than those above, usually a `5xx`, or couldn't be reached at all (`couldn't reach ...`). `details.status` and `details.body` hold its answer when there was one.

One case is different: `created, but 0x... has no ScheduleCreated log: read the receipt yourself` means the transaction succeeded and the SDK couldn't read the new id from it. `details.hash` is the transaction.

**What to do:** retry a read later: these are usually brief. Don't repeat a write that says `created, but`: the schedule or policy exists, so read its id from the receipt.

### not_found

**It doesn't exist:**

- `there is no schedule 99 on 0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8`;
- `there is no policy 42`;
- an endpoint answered `404`: `no such request`, or `no subscription for this address and url`.

**What to do:** check the id, and for webhooks the exact URL you subscribed.

### timeout

**The SDK waited, and what it was waiting for didn't happen in time.** Nothing failed.

- `events.waitFor`, after `timeoutMs` (20 minutes by default): `no matching payment event in time`.
- `requests.waitUntilPaid`, after `timeoutMs` (20 minutes by default): `request ... isn't paid yet (accepted)`.
- Either one when its `signal` aborts: `stopped`.

An agent payment whose receipt hasn't arrived within `waitMs` doesn't throw. It returns `status: "pending"`, and a call with the same idempotency key later reports the outcome.

**What to do:** wait longer, or check again later. A schedule created outside the Remesso app is picked up within about 5 minutes. A payment appears as an event within a minute or two, and is final 25 to 30 minutes after that.
