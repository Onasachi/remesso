# Payment requests

> Ask a wallet to pay you, follow the request until it is paid, and answer or decline requests sent to you.

Source: https://docs.remesso.xyz/docs/guides/payment-requests

A payment request asks a wallet to pay you: an amount, a token and, if you like, a cadence and a number of payments. This page covers sending one, following it until it is paid, and the payer's side, answering or declining.

A request is free to send and needs no account with Remesso. It lands in the payer's Remesso inbox, and you get a link that opens their payment form filled in. A request can't move money. Nothing is authorised until the payer signs in their own wallet.

## How a request is answered

A request can be answered in two ways:

- **By a schedule.** The payer signs a schedule for the terms, in the Remesso app or with the SDK, and it is reported against the request.
- **By an agent payment.** The payer's agent pays through a [policy](./agent-payments.md), with the request's reference in the memo.

A request has a status:

| Status | What it means |
|---|---|
| `pending` | Waiting for the payer. |
| `accepted` | Answered with the terms you asked for. |
| `accepted_with_changes` | Answered, with some terms different. The answer lists which. |
| `declined` | The payer, or their agent, turned it down with a signature. |
| `expired` | Still pending after 30 days. |

**Accepted is not paid.** A schedule can be accepted days before its first payment, and that payment can still fail. A request counts as paid only once a payment with a transaction answers it. That shows in `payment.state`, described in [Check where a request stands](#check-where-a-request-stands).

## Ask to be paid

```ts
const req = await receiver.requests.create({
  payer: "0xTheirWallet",
  amount: "50",
  token: "USDT",
  every: "month",
  runs: 12,
  from: "Ada's studio",
  note: "Monthly retainer",
});
console.log(req.id, req.reference);
console.log(req.link); // send it however you already reach them
```

| Field | Required | What it is |
|---|---|---|
| `payer` | Yes | The wallet you are asking to pay. |
| `to` | No | Where you want to be paid. Default: this account. |
| `amount` | No | What you want to receive per payment, as a decimal string. The payer covers the fee on top. |
| `token` | No | The token, one of those schedules accept. |
| `every` | No | `"week"`, `"fortnight"`, `"month"` or `"quarter"`. |
| `runs` | No | How many payments, 1 to 9,999. |
| `from` | No | Who is asking, shown to the payer. Up to 40 characters. |
| `note` | No | Why, up to 120 characters. |

Anything you leave out, the payer chooses. `create` returns:

- `id`: the request's id, which every other call takes;
- `reference`: the id without its dashes, 32 characters, which an agent payment carries in its memo to answer the request;
- `link`: the payer's form, prefilled;
- `status`: `"pending"`.

**A wallet can have at most 10 live requests**, meaning pending and under 30 days old. Beyond that, `create` throws [`refused`](../reference/errors.md#refused) until the payer answers or declines some, or they expire. The cap protects the payer's inbox.

> **Note**
>
> Requests are public to anyone who names the payer's address, the way an invoice is. Don't put anything private in `from` or `note`.

## Share the link

The link opens `remesso.xyz/schedules/new` with the request's terms filled in. It also carries `req=`, the request's id, so the schedule the payer signs from it is reported against your request. The form tells the payer a link filled it, and they review every field before signing.

Send the link however you already reach the payer: by email, in a chat, or as a QR code. The request also shows in their Remesso inbox, so a payer who opens the app sees it without the link.

## See the requests sent to you

The payer's inbox is a list of live requests addressed to a wallet:

```ts
for (const r of await payer.requests.list()) {
  const amount = r.amount ? `${r.amount} ${r.token ?? ""}` : "an amount you choose";
  console.log(`${r.id}: ${r.from ?? "someone"} asks for ${amount}`, r.note ?? "");
}
```

`list(payer?)` defaults to this account. A read-only client can pass any address. Each entry has the request's `id`, `reference`, `to`, `amount`, `token`, `intervalSeconds`, `runs`, `from`, `note`, `status` and `createdAt`. It lists live requests only: pending and under 30 days old.

## Answer with a schedule

As the payer, create a schedule from the request. Its terms fill whatever you leave out, and the SDK reports the schedule against the request:

```ts
const s = await payer.schedules.create({ request: requestId });
console.log(`schedule ${s.id}`, s.request); // { status: "accepted", signed: { … } }
```

The request's amount is what the recipient receives, so the SDK sends that amount plus the fee. The answer is `accepted` when every term matches, and `accepted_with_changes` when the schedule differs in token, amount, cadence or number of payments. `signed.changed` names which.

If you created the schedule another way, report it yourself:

```ts
const answer = await payer.requests.answer(requestId, scheduleId);
console.log(answer.status, answer.signed);
```

The backend may not see a new schedule for a few seconds, because a node behind Celo's RPC can answer from an earlier block. `answer` retries for up to 90 seconds while the backend says the schedule hasn't been seen yet, and after a server error. Answering again with the same schedule is safe: it returns the first answer.

A schedule answers a request only if all of these hold. Otherwise `answer` throws [`conflict`](../reference/errors.md#conflict) with the reason:

- it is from the wallet the request was sent to;
- it pays the address that asked;
- it was created after the request;
- it doesn't already answer another request.

## Pay a request as an agent

An agent with a policy from the payer can pay the request directly:

```ts
const r = await agent.requests.pay(requestId);
console.log(r.status, r.sent, r.explorer);
```

`requests.pay` reads the request and finds an active policy from the wallet the request was sent to, for the request's token (USDT if it names none). Then it pays the requested amount to the requested address, with:

- the request's 32-character reference as the memo, which is how the payment answers the request;
- the idempotency key `request:<id>` unless you pass your own, so the request is paid at most once.

Pass `amount` if the request names none. You can also pass `policyId`, `idempotencyKey`, `allowRepeat` and `waitMs`, as for [`pay`](./agent-payments.md#pay-as-the-agent). A request that is declined or expired is refused. Remesso's indexer binds the payment to the request within about a minute.

## Decline a request

Declining turns a request down for everyone: the requester sees it as `declined`. It needs a signature from the wallet the request was sent to:

```ts
await payer.requests.decline(requestId);
```

An agent can decline for its person, under a live policy from that wallet:

```ts
await agent.requests.decline(requestId, { policyId });
```

The signature is EIP-712 typed data that expires after 10 minutes. `ttlSeconds` sets it from 60 seconds to a day. Declining needs an account that can sign: a local account or a wallet client. Hiding a request in the Remesso app is different: it is private to that session and declines nothing.

## Wait until it is paid

```ts
const paid = await receiver.requests.waitUntilPaid(requestId, { timeoutMs: 30 * 60_000 });
for (const tx of paid.payment?.txs ?? []) {
  console.log(tx.txHash, tx.amount, tx.final ? "final" : "not final yet");
}
```

`waitUntilPaid` checks the request every 15 seconds until a payment with a transaction answers it:

- it throws [`refused`](../reference/errors.md#refused) if the request is declined or expires;
- it throws [`timeout`](../reference/errors.md#timeout) if it isn't paid within `timeoutMs`, 20 minutes by default;
- it takes an `AbortSignal` as `signal`, and `intervalMs` to change how often it checks.

Allow for the first payment of a schedule. Remesso's sync finds a schedule created outside its app within about five minutes, and the payment follows within a minute. In a server, [webhooks](./webhooks.md) tell you the moment a payment lands, without polling.

## Check where a request stands

```ts
const r = await receiver.requests.get(requestId);
console.log(r.status, r.payment?.state ?? "not answered yet");
if (r.payment?.state === "failed") console.log("the last attempt failed:", r.payment.reason);
```

`get(id)` returns the request's `status`, the `payer` asked, the `requested` terms, the `signed` terms once answered, and `payment`:

| `payment.state` | What it means |
|---|---|
| `null` | Not answered yet. |
| `"scheduled"` | Answered by a schedule, and nothing paid yet: its first payment hasn't come due. |
| `"paid"` | At least one payment landed. `payment.txs` lists each, with `txHash`, `amount`, `final` and `blockTime`. |
| `"failed"` | Answered by a schedule whose last attempt failed. `payment.reason` says why, for example a balance below one payment. |

For a schedule, `payment.schedule` gives its contract and id.

## Pay links

A pay link fills in the payer's form, like a request's link, but it creates no request: nothing reaches their inbox, and nothing is tracked unless the link carries a request id. Build one with `payLink`, and read one with `parsePayLink`:

```ts
import { parsePayLink, payLink } from "remesso-sdk";

// To this account, at the client's app origin.
const mine = receiver.payLink({ amount: "25", token: "USDT", every: "month", runs: 6, from: "Ada's studio" });

// To any address.
const theirs = payLink({ to: process.env.RECIPIENT!, amount: "10", token: "USDC" });

const fields = parsePayLink(mine);
console.log(fields.to, fields.amount, fields.token, fields.intervalSeconds, fields.runs);
```

A link is input from a stranger, so `parsePayLink` keeps only what validates, the same rules as the app's form:

- an address;
- `from` cut to 40 characters, and a note cut to 120;
- a positive decimal amount;
- a token that schedules accept;
- a cadence the form offers;
- `runs` from 1 to 9,999;
- a request id.

It drops anything else. A link can't create a schedule, approve an allowance or sign anything.

## Next steps

- [Pay on a schedule](./schedules.md): everything `schedules.create` takes.
- [Agent payments](./agent-payments.md): policies, and paying exactly once.
- [Webhooks](./webhooks.md): be told when a request's payment lands.
- [Bill a client monthly](../use-cases/freelancer-retainer.md): a complete requester.
