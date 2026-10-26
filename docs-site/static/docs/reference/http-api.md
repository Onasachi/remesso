# HTTP API

> Remesso's public endpoints over plain HTTP, for any language: payment requests, payment events, webhooks and the capability document.

Source: https://docs.remesso.xyz/docs/reference/http-api

This page documents the HTTP endpoints remesso-sdk calls, for developers working in another language or without the SDK.

## Conventions

All four endpoints live under one base URL, need no API key and allow cross-origin calls:

```text
https://engaboljiqudghvzmebq.supabase.co/functions/v1
```

- Bodies are JSON. Send `content-type: application/json`.
- An error answers with a status and `{ "error": "...", "detail": "..." }`, where `detail` is there only sometimes.
- Amounts that moved or were signed (payment events, a request's `signed` terms and its payments) are base units as strings: an 18-decimal amount doesn't survive as a JSON number. Amounts you send to `request-payment` are decimals in the token's own units, such as `"2.50"`, and a request's `requested` terms echo them that way.
- Addresses in responses are lowercase.
- A `GET` on `request-payment` or `webhooks` returns a description of what it accepts.

The SDK maps each status to an error code: see [errors](./errors.md#how-endpoint-answers-map-to-codes).

## request-payment

`POST /request-payment` asks a wallet to pay you, and reports where that request stands. The `action` field picks what it does. Without one, it creates a request.

A request can't create a schedule or move a token. It shows up in the payer's Remesso app and gives you a link that opens their payment form filled in, and nothing is authorised until they sign in their own wallet. See [payment requests](../guides/payment-requests.md).

### Create a request

```bash
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment \
  -H 'content-type: application/json' \
  -d '{"payer":"0xTheirWallet","to":"0xYourAddress","amount":"50","token":"USDT","every":"month","runs":12,"from":"Ada studio","note":"monthly retainer"}'
```

| Field | Required | Meaning |
|---|---|---|
| `payer` | yes | The wallet you're asking to pay. |
| `to` | yes | The address you want paid. |
| `amount` | no | What you want to receive per payment, as a decimal. The payer's form adds Remesso's fee on top. |
| `token` | no | `USDT`, `USDC`, `USDm`, `USA₮`, `wARS`, `wBRL`, `wCOP` or `cNGN`. The `GET` description lists the current set. |
| `every` | no | `week`, `fortnight`, `month` or `quarter`. `weekly`, `fortnightly`, `monthly` and `quarterly` also work. |
| `runs` | no | How many payments, 1 to 9999. |
| `from` | no | Who is asking, up to 40 characters. |
| `note` | no | Why, up to 120 characters. |

It answers `201`:

```json
{
  "ok": true,
  "id": "50a5be6a-079f-43fe-9804-0925179fd5f0",
  "link": "https://…/schedules/new?to=0x…&from=Ada+studio&amount=50&token=USDT&every=month&runs=12&note=monthly+retainer&req=50a5be6a-079f-43fe-9804-0925179fd5f0",
  "status": "pending",
  "detail": "the payer decides. Nothing is authorised until they sign."
}
```

Send the `link` to the payer however you already reach them. It carries `req=`, so the schedule they sign from it is reported against your request.

A payer can have at most 10 live requests: pending, and under 30 days old. An eleventh is refused with `429`, saying how many are waiting.

### List a payer's requests

```bash
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment \
  -H 'content-type: application/json' \
  -d '{"action":"list","payer":"0xTheirWallet"}'
```

It returns up to 20 live requests addressed to the payer, newest first:

```json
{
  "requests": [
    {
      "id": "50a5be6a-079f-43fe-9804-0925179fd5f0",
      "reference": "50a5be6a079f43fe98040925179fd5f0",
      "to": "0x…",
      "amount": "50",
      "token": "USDT",
      "intervalSeconds": 2592000,
      "runs": 12,
      "from": "Ada studio",
      "note": "monthly retainer",
      "status": "pending",
      "createdAt": "2026-10-25T14:02:11.513421+00:00"
    }
  ]
}
```

`reference` is the id without its dashes, 32 characters. An agent paying under a policy puts it in the payment's memo, and the request is then answered by that payment.

### A request's status

```bash
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment \
  -H 'content-type: application/json' \
  -d '{"action":"status","id":"50a5be6a-079f-43fe-9804-0925179fd5f0"}'
```

```json
{
  "id": "50a5be6a-079f-43fe-9804-0925179fd5f0",
  "reference": "50a5be6a079f43fe98040925179fd5f0",
  "status": "accepted",
  "payer": "0x…",
  "requested": { "to": "0x…", "amount": "50", "token": "USDT", "intervalSeconds": 2592000, "runs": 12 },
  "signed": { "amount": "50000000", "token": "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", "intervalSeconds": 2592000, "runs": 12, "changed": [] },
  "payment": {
    "state": "paid",
    "schedule": { "contract": "0x3c357af3300f383ea49b6d6ed8e084199a92bed8", "id": "5" },
    "txs": [{ "txHash": "0x…", "amount": "50000000", "final": true, "blockTime": "2026-10-25T14:20:44+00:00" }],
    "reason": null
  }
}
```

- `status` is `pending`, `accepted`, `accepted_with_changes`, `declined` or `expired`. A pending request expires after 30 days.
- `signed` is what the payer actually signed, with `amount` in base units after the fee: what you receive per payment. `changed` lists which of `token`, `amount`, `cadence` and `runs` differ from what you asked. It is `null` until the request is answered.
- `payment` is `null` until the request is answered. Then its `state` is `scheduled` (answered, nothing paid yet), `paid` (with the transactions in `txs`) or `failed` (with Remesso's reason).

> **Warning**
>
> Accepted is not paid. Release anything only for a payment with a transaction, ideally once it is `final`, and check that transaction on the chain yourself.

### Answer a request with a schedule

The payer, or their agent, reports the schedule that answers a request:

```bash
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment \
  -H 'content-type: application/json' \
  -d '{"action":"answer","id":"50a5be6a-079f-43fe-9804-0925179fd5f0","schedule":"5"}'
```

It answers `{ "ok": true, "id": "...", "status": "accepted", "signed": { ... } }`. `contract` is optional and defaults to the executor.

The schedule answers the request only if:

- it was created by the wallet the request was sent to;
- it pays the address that asked;
- it was created after the request;
- it answers no other request.

Otherwise the answer is refused with `409` and says which rule failed. A schedule only seconds old can be refused with `409`, `that schedule hasn't been seen on-chain yet; try again in a minute`. Try again a few seconds later. Answering again with the schedule that already answers the request returns the first answer, so a retry is safe.

### Decline a request

Only the wallet the request was sent to can turn it down for everyone, with an EIP-712 signature over this typed data:

```json
{
  "domain": { "name": "Remesso", "version": "1", "chainId": 42220 },
  "primaryType": "PaymentRequestAction",
  "types": {
    "PaymentRequestAction": [
      { "name": "request", "type": "string" },
      { "name": "action", "type": "string" },
      { "name": "expiry", "type": "uint64" }
    ]
  },
  "message": { "request": "50a5be6a-079f-43fe-9804-0925179fd5f0", "action": "decline", "expiry": 1792940000 }
}
```

Sign it with any EIP-712 library, or `eth_signTypedData_v4`, then send:

```bash
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment \
  -H 'content-type: application/json' \
  -d '{"action":"decline","id":"50a5be6a-079f-43fe-9804-0925179fd5f0","expiry":1792940000,"signature":"0x…"}'
```

- `expiry` is Unix seconds, in the future and at most 24 hours ahead. A signature is worthless after it.
- An agent can sign instead of the payer, if it holds a live policy from the payer. Add `"agent": "0x…"` and `"policy_id": "12"`, and sign with the agent's key.
- A smart account signs through ERC-1271.
- It answers `{ "ok": true, "id": "...", "status": "declined" }`. Declining twice gives the same answer. A request that is already accepted answers `409`.

## payment-events

`GET /payment-events` lists every payment to or from an address, as Remesso's indexer reads it from the chain. See [payment events](../guides/payment-events.md) for what each event means.

```bash
curl 'https://engaboljiqudghvzmebq.supabase.co/functions/v1/payment-events?address=0xYourAddress&role=to&kind=run,policy_payment&after=0&limit=100'
```

| Parameter | Default | Meaning |
|---|---|---|
| `address` | required | The address to read. |
| `role` | `any` | `to`, `from`, `agent` or `any`: which side of the event the address is on. |
| `kind` | all kinds | A comma-separated list of `run`, `schedule_created`, `policy_payment`, `policy_created`, `policy_revoked`. |
| `after` | `0` | The `next` of the previous page. |
| `limit` | `100` | 1 to 500. |

```json
{
  "events": [
    {
      "seq": 25,
      "chainId": 42220,
      "contract": "0x3c357af3300f383ea49b6d6ed8e084199a92bed8",
      "kind": "run",
      "refId": "2",
      "from": "0x…",
      "to": "0x…",
      "agent": null,
      "token": "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
      "amount": "1000000",
      "amountIn": "1002507",
      "memo": null,
      "memoText": null,
      "runNumber": 1,
      "early": false,
      "details": { "nextRunAt": "1793542263" },
      "txHash": "0x…",
      "logIndex": 8,
      "blockNumber": 81036705,
      "blockHash": "0x…",
      "blockTime": "2026-10-25T14:11:03+00:00",
      "final": true,
      "removed": false
    }
  ],
  "next": 25
}
```

Pass `next` back as `after` to read the next page. A page shorter than `limit` means you have caught up. `seq` moves whenever an event changes, so an event you saw before it was final comes round again once it is, and again if a reorg removes it.

## webhooks

`POST /webhooks` manages the webhook subscriptions of a receiving address: `subscribe`, `rotate`, `revoke` and `replay`. The [webhooks guide](../guides/webhooks.md) explains the flow, and [webhook payloads](./webhook-payloads.md) the messages.

Every request is signed by the receiving address, with EIP-712, over this typed data:

```json
{
  "domain": { "name": "Remesso", "version": "1", "chainId": 42220 },
  "primaryType": "WebhookAction",
  "types": {
    "WebhookAction": [
      { "name": "recipient", "type": "address" },
      { "name": "url", "type": "string" },
      { "name": "chainId", "type": "uint256" },
      { "name": "action", "type": "string" },
      { "name": "nonce", "type": "string" },
      { "name": "expiry", "type": "uint64" }
    ]
  },
  "message": {
    "recipient": "0x…",
    "url": "https://example.com/remesso",
    "chainId": 42220,
    "action": "subscribe",
    "nonce": "f3b1c9a07d2e4e18",
    "expiry": 1792938121
  }
}
```

Then send the same fields with the signature:

```bash
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/webhooks \
  -H 'content-type: application/json' \
  -d '{"action":"subscribe","recipient":"0x…","url":"https://example.com/remesso","chainId":42220,"nonce":"f3b1c9a07d2e4e18","expiry":1792938121,"signature":"0x…"}'
```

| Field | Meaning |
|---|---|
| `action` | `subscribe`, `rotate`, `revoke` or `replay`. |
| `recipient` | The receiving address. Its key, or its ERC-1271 smart account, signs. |
| `url` | Your HTTPS endpoint, at most 512 characters, with no credentials and no fragment. |
| `chainId` | `42220`. |
| `nonce` | 8 to 128 letters, digits, `-` or `_`, used once. |
| `expiry` | Unix seconds, in the future and at most an hour ahead. |
| `signature` | The EIP-712 signature. |
| `days` | `replay` only: how far back, 1 to 7. It isn't signed. |

What each action answers:

| Action | Success | Refusals |
|---|---|---|
| `subscribe` | `201`, `{ ok, subscription, recipient, url, state: "active", secret }`. The secret is shown this once. | `400` if the endpoint didn't answer the [challenge](./webhook-payloads.md#the-challenge), with why. `409` if the URL is already subscribed for the address. `429` at 5 subscriptions. |
| `rotate` | `200`, `{ ok, secret, previousSecretValidUntil }`. The old secret keeps signing until then. | `404` if there is no active subscription for the address and URL. |
| `revoke` | `200`, `{ ok, state: "revoked" }` | `404` if there is no subscription for the address and URL. |
| `replay` | `200`, `{ ok, requeued, days }` | |

Any action can also answer `400` for a malformed field, `401` if the signature isn't from `recipient`, or `409` if the nonce was already used: sign again with a new one.

## agent

`GET /agent` returns Remesso's capability document: what it is, who runs it, and everything a caller needs to use it. Machines can read it, and it is cached for 5 minutes.

```bash
curl https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent
```

Its sections:

| Key | What it holds |
|---|---|
| `identity` | Remesso's ERC-8004 and Self Agent ID registrations, so a caller can check who it deals with. |
| `chain` | The network, the executor contract, the trigger sentinel a payer grants, the key that sends payments, and Remesso's attribution code. |
| `limits` | `perRun`: the smallest and largest payment the executor sends, per token, in decimals and base units. |
| `receiving` | What being paid needs (an address, nothing else), the tokens accepted, and the ways to hand your address to a payer and to know you were paid. |
| `developers` | The SDK, its documentation, and how [builder codes](../guides/builder-codes.md) work. |
| `services` | Each endpoint, with its price and what it refuses. |
| `guarantees` | What a payer's schedule can never be made to do, whoever asks. |
| `verification` | The contract and the read calls that let anyone check a schedule themselves. |

## Paid services

Remesso also sells a few services per call, paid in stablecoins over [x402](https://x402.celo.org/) on Celo, with no account:

- `trigger-run` brings one payment of a schedule forward;
- `rate-service` gives live USDT/NGN and USDC/NGN rates;
- `latam-rate` gives USD to wARS and wBRL rates;
- `latam-route` gives a route for delivering pesos or reais.

A `POST` without a payment returns the price in a `402` response. The capability document lists each one under `services`, and [AGENTS.md](https://bitbucket.org/crackedstudios/remesso/src/main/docs/AGENTS.md) explains how to pay for them.
