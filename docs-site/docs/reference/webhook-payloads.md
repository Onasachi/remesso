---
title: Webhook payloads
description: The exact format of Remesso's webhook deliveries, how each one is signed, and the rules for retries and duplicates.
---

This page specifies what Remesso sends to a subscribed endpoint: the headers, the signature, the challenge, each message type and every field. The [webhooks guide](../guides/webhooks.md) shows how to receive them with the SDK.

## Headers

Every delivery is an HTTPS `POST` with a JSON body and these headers, as [Standard Webhooks](https://www.standardwebhooks.com/) defines them:

| Header | Example | Meaning |
|---|---|---|
| `webhook-id` | `msg_775f0089945d724d7d63cae36e805f8c` | The delivery's id. The same on every attempt at this delivery. |
| `webhook-timestamp` | `1792937521` | Unix seconds when this attempt was signed. New on every attempt. |
| `webhook-signature` | `v1,6+i64kmGDzTxyH+NKSPRQDTpmBehkBJdRsVeNRzdclo=` | One or more signatures, separated by spaces. |
| `content-type` | `application/json` | |

During a secret rotation, `webhook-signature` carries one `v1,` signature per secret, so a server holding either secret verifies.

## How a delivery is signed

The signature is an HMAC-SHA256 over the id, the timestamp and the raw body, joined by dots:

```text
signed content = webhook-id + "." + webhook-timestamp + "." + raw body
key            = base64-decode(the secret, without its "whsec_" prefix)
signature      = "v1," + base64(HMAC-SHA256(key, signed content))
```

To verify a delivery:

1. Read the raw body as bytes, before any JSON parsing. A parsed and re-serialised body won't match.
2. Refuse it if `webhook-timestamp` is more than 5 minutes from your clock. That is what stops a captured delivery being replayed later.
3. Compute the signature with your secret and compare it, in constant time, with each `v1,` entry in `webhook-signature`. Accept the delivery if any one matches.

`verifyWebhook` and `parseWebhook` in remesso-sdk do exactly this. So does any Standard Webhooks library, such as `standardwebhooks` or `svix`. Without them, in TypeScript with Web Crypto:

```ts
const TOLERANCE_SECONDS = 5 * 60;

export async function verify(raw: string, headers: Headers, secret: string): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`)));
  const expected = btoa(String.fromCharCode(...mac));

  return signatures.split(" ").some((part) => part.startsWith("v1,") && sameString(part.slice(3), expected));
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

In Python:

```python
import base64, hashlib, hmac, time

def verify(raw: bytes, headers, secret: str) -> bool:
    msg_id = headers.get("webhook-id")
    timestamp = headers.get("webhook-timestamp")
    signatures = headers.get("webhook-signature") or ""
    if not msg_id or not timestamp:
        return False
    if abs(time.time() - int(timestamp)) > 5 * 60:
        return False
    key = base64.b64decode(secret.removeprefix("whsec_"))
    signed = f"{msg_id}.{timestamp}.".encode() + raw
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    return any(
        part.startswith("v1,") and hmac.compare_digest(part[3:], expected)
        for part in signatures.split(" ")
    )
```

### A test vector

With the secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, the headers in the table above and this exact body, on one line, your signature must come out as `6+i64kmGDzTxyH+NKSPRQDTpmBehkBJdRsVeNRzdclo=`. The timestamp is in the past, so skip the 5-minute check while you test.

```text
{"type":"payment.received","timestamp":"2026-10-25T14:12:01.214Z","data":{"chainId":42220,"contract":"0x3c357af3300f383ea49b6d6ed8e084199a92bed8","schedule":"2","from":"0x5732925393fd10baf447d98826ae72febabff483","to":"0xb21051155ab66d9e599af24475359fa8f3d63838","token":"0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e","amount":"1000000","amountIn":"1002507","runNumber":1,"early":false,"txHash":"0xbbb4e6f9c90474e18f9ce1c6b99885c5d6579ae2d1a0765352af228ccadf6041","logIndex":8,"blockNumber":81036705,"blockHash":"0x6b7f2ce27a4ec5911aa720fcff02fe55d45dd14b8296e4d830bf09f6438bffe7","blockTime":"2026-10-25T14:11:03+00:00","final":false,"removed":false}}
```

The addresses and hashes in it are made up.

## The challenge

When you subscribe, Remesso first posts a verification message to the endpoint, before the subscription is active:

```json
{
  "type": "webhook.verification",
  "timestamp": "2026-10-25T14:00:00.000Z",
  "data": {
    "challenge": "9f86d081884c7d659a2feaa0c55ad015",
    "recipient": "0xb21051155ab66d9e599af24475359fa8f3d63838",
    "url": "https://example.com/remesso"
  }
}
```

Answer within 10 seconds with a 2xx status and the challenge, either as the whole body or as JSON:

```json
{ "challenge": "9f86d081884c7d659a2feaa0c55ad015" }
```

The message is signed with the new secret, like every later delivery, but you can't check it yet: the secret is returned only once the endpoint has answered. Answer only for addresses you subscribe, which is what `webhookHandler` does through its `recipient` option. Echoing every challenge would let a stranger point their deliveries at your server.

## Message types

| Type | Sent when |
|---|---|
| `payment.received` | The indexer sees a payment to the address, before it is final. Usually within a minute or two of the transaction. |
| `payment.finalized` | Celo's finalized block passes the payment, usually 25 to 30 minutes later. A payment first seen already final gets only this one. |
| `payment.removed` | A reorg undid a payment you were already told about. Only a subscription that received a message about the payment gets this, and anything still queued about it is cancelled. |

Only payments are delivered: schedule payments (runs) and agent payments under a policy, to the subscribed address. Schedules and policies being created or revoked are not; read those as [payment events](../guides/payment-events.md).

## The body

Every message has the Standard Webhooks shape `{ type, timestamp, data }`:

| Field | Type | Meaning |
|---|---|---|
| `type` | string | One of the message types above. |
| `timestamp` | string | ISO 8601 time when the delivery was queued. The body, and so this, is the same on every attempt. |
| `data` | object | The payment (below). |

## The `data` fields

Amounts are base units as strings, after Remesso's fee: what the recipient received. Addresses are lowercase.

| Field | Type | Set for | Meaning |
|---|---|---|---|
| `chainId` | number | all | `42220`, Celo mainnet. |
| `contract` | string | all | The executor for a schedule payment, the allowance contract for a policy payment. |
| `schedule` | string | schedule payments | The schedule's id. |
| `policy` | string | policy payments | The policy's id. |
| `from` | string | all | The payer: the schedule's sender, or the policy's owner. |
| `to` | string | all | The recipient: your subscribed address. |
| `token` | string | all | The token that arrived. |
| `amount` | string | all | Base units that arrived. |
| `amountIn` | string or null | schedule payments | Base units that left the payer, before the fee. |
| `runNumber` | number or null | schedule payments | Which payment of the schedule this is, from 1. |
| `early` | boolean | schedule payments | Whether a trigger brought this payment forward. |
| `memo` | string or null | policy payments | The 32-byte memo, as hex. |
| `memoText` | string or null | policy payments | The memo as text, when it is plain text. A payment request's reference arrives here. |
| `txHash` | string | all | The transaction. |
| `logIndex` | number | all | The log inside it. `txHash` and `logIndex` together identify the payment. |
| `blockNumber` | number | all | The block it was mined in. |
| `blockHash` | string | all | That block's hash. |
| `blockTime` | string | all | When that block was mined. |
| `final` | boolean | all | At or below Celo's finalized block. |
| `removed` | boolean | all | Undone by a reorg. |

## Examples

A schedule payment, just seen:

```json
{
  "type": "payment.received",
  "timestamp": "2026-10-25T14:12:01.214Z",
  "data": {
    "chainId": 42220,
    "contract": "0x3c357af3300f383ea49b6d6ed8e084199a92bed8",
    "schedule": "2",
    "from": "0x5732925393fd10baf447d98826ae72febabff483",
    "to": "0xb21051155ab66d9e599af24475359fa8f3d63838",
    "token": "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
    "amount": "1000000",
    "amountIn": "1002507",
    "runNumber": 1,
    "early": false,
    "txHash": "0xbbb4e6f9c90474e18f9ce1c6b99885c5d6579ae2d1a0765352af228ccadf6041",
    "logIndex": 8,
    "blockNumber": 81036705,
    "blockHash": "0x6b7f2ce27a4ec5911aa720fcff02fe55d45dd14b8296e4d830bf09f6438bffe7",
    "blockTime": "2026-10-25T14:11:03+00:00",
    "final": false,
    "removed": false
  }
}
```

1 USDT arrived (`1000000` at 6 decimals); 1.002507 left the payer, the difference being Remesso's 0.25% fee.

An agent payment, now final. It carries a payment request's reference in its memo:

```json
{
  "type": "payment.finalized",
  "timestamp": "2026-10-25T14:44:10.032Z",
  "data": {
    "chainId": 42220,
    "contract": "0xa6351faeeb097698289586c4d6188530300db209",
    "policy": "8",
    "from": "0x5732925393fd10baf447d98826ae72febabff483",
    "to": "0xb21051155ab66d9e599af24475359fa8f3d63838",
    "token": "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
    "amount": "20000",
    "memo": "0x3533613862613131336466633436653539613432363431353830386438613634",
    "memoText": "53a8ba113dfc46e59a426415808d8a64",
    "txHash": "0xa30259d8bc0fb86ae3aed765aff8efe2dbb7e652eec5fc0bb5817c51e800281d",
    "logIndex": 400,
    "blockNumber": 81036939,
    "blockHash": "0x9251f5ca74510ea4d7220f3525960621c42580bcaaca5f372ce8ce60b15b9346",
    "blockTime": "2026-10-25T14:14:57+00:00",
    "final": true,
    "removed": false
  }
}
```

A payment a reorg undid. The fields describe the payment as you were told about it, with `removed: true`:

```json
{
  "type": "payment.removed",
  "timestamp": "2026-10-25T14:13:30.508Z",
  "data": {
    "chainId": 42220,
    "contract": "0x3c357af3300f383ea49b6d6ed8e084199a92bed8",
    "schedule": "2",
    "from": "0x5732925393fd10baf447d98826ae72febabff483",
    "to": "0xb21051155ab66d9e599af24475359fa8f3d63838",
    "token": "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e",
    "amount": "1000000",
    "amountIn": "1002507",
    "runNumber": 1,
    "early": false,
    "txHash": "0xbbb4e6f9c90474e18f9ce1c6b99885c5d6579ae2d1a0765352af228ccadf6041",
    "logIndex": 8,
    "blockNumber": 81036705,
    "blockHash": "0x6b7f2ce27a4ec5911aa720fcff02fe55d45dd14b8296e4d830bf09f6438bffe7",
    "blockTime": "2026-10-25T14:11:03+00:00",
    "final": false,
    "removed": true
  }
}
```

If the same transaction is mined again in another block, it is news again: a new `payment.received` follows, with the new `blockHash`.

## Delivery and retries

- **Success** is a 2xx answer within 10 seconds. Only the status is read, and at most 16 KB of the body.
- **Retries:** after a failed attempt, Remesso tries again after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then every 6 hours, for 24 hours from the first attempt. Each attempt has the same `webhook-id` and body, and a new timestamp and signature.
- **After 24 hours** a delivery is held as failed until the address asks for a replay, which reaches back 1 to 7 days and restarts the 24 hours.
- **Duplicates:** a delivery can arrive more than once, for example when your answer was lost. Record the `webhook-id`s you have processed and skip repeats.
- **Order isn't guaranteed.** A retried `payment.received` can arrive after the `payment.finalized` for the same payment. Keep the latest state you have for each `txHash` and `logIndex`, and let `final` and `removed` decide.
- **New subscriptions start from now.** Payments made before the subscription are not delivered.

:::tip
Before releasing anything valuable, read the transaction in `txHash` from the chain yourself, and wait for `final: true`.
:::
