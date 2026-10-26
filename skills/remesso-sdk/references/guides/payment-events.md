# Payment events

> Read every payment to or from an address, as Remesso's indexer records it from the chain, and follow new ones as they arrive.

Source: https://docs.remesso.xyz/docs/guides/payment-events

This guide shows how to read payment events: every schedule payment and agent payment to or from an address, as Remesso records it from Celo, with no node of your own.

## What is a payment event?

Remesso's indexer reads the executor and allowance contracts every minute and records each log as a payment event. That covers every way money moves through Remesso:

- a schedule's payment, whether Remesso's executor sent it on time or a trigger brought it forward;
- an agent's payment under a policy;
- a schedule or policy being created, and a policy being revoked.

Payment events are public and free, like the chain they come from. You read them by address: as the recipient, the payer, or the agent that paid.

## List an address's events

`events.list` returns one page of events and the `next` value to pass back for the following page.

```ts
import { formatAmount } from "remesso-sdk";

const { events, next } = await receiver.events.list({
  role: "to",
  kinds: ["run", "policy_payment"],
});

for (const e of events) {
  console.log(e.kind, formatAmount(e.amount!, e.token!), e.final ? "final" : "not final yet", e.txHash);
}
console.log("next page after", next);
```

The query takes these options:

| Option | Default | Meaning |
|---|---|---|
| `address` | the client's account | The address to read. Required on a read-only client. |
| `role` | `"any"` | Which side of the event the address is on: `"to"`, `"from"`, `"agent"` or `"any"`. |
| `kinds` | every kind | Any of `run`, `schedule_created`, `policy_payment`, `policy_created`, `policy_revoked`. |
| `after` | `0` | The `next` of a previous page. `0` starts from the beginning. |
| `limit` | `100` | Events per page, from 1 to 500. |

A read-only client can read any address:

```ts
const { events } = await reader.events.list({
  address: "0xTheirWallet",
  role: "from",
  kinds: ["schedule_created"],
});
console.log(events.map((e) => e.refId)); // the ids of the schedules this wallet created
```

## Page through everything

Events come in the order of their `seq`, a number that only grows. Pass each page's `next` back as `after` until a page comes back short:

```ts
import type { PaymentEvent } from "remesso-sdk";

const all: PaymentEvent[] = [];
let after = 0;
for (;;) {
  const page = await receiver.events.list({ role: "to", after, limit: 500 });
  all.push(...page.events);
  after = page.next;
  if (page.events.length < 500) break;
}
console.log(`${all.length} events; resume from ${after} next time`);
```

Keep the last `next` you processed. Starting from it later returns only what is new or changed since.

## Watch for new events

`events.watch` is an async iterator. It yields every event from `after` on, then waits and yields each new one or change as it comes. When it has caught up it polls every `intervalMs`, 15 seconds by default. Stop it with an `AbortSignal`.

```ts
import { formatAmount } from "remesso-sdk";

const stop = new AbortController();
process.on("SIGINT", () => stop.abort());

let cursor = 0; // load the last seq you handled from your own storage
for await (const e of receiver.events.watch({ role: "to", kinds: ["run", "policy_payment"], after: cursor, signal: stop.signal })) {
  console.log(e.kind, formatAmount(e.amount!, e.token!), e.final ? "final" : "not final yet");
  cursor = e.seq; // save it, so a restart resumes here
}
```

Without `after`, a watch starts from the address's first event. To act only on what arrives from now on, store the `seq` of the last event you handled and pass it back when you start again.

## Wait for one payment

`events.waitFor` watches until an event matches, then returns it. It throws a `RemessoError` with code [`timeout`](../reference/errors.md#timeout) after `timeoutMs`, 20 minutes by default.

```ts
const paid = await receiver.events.waitFor(
  (e) => e.kind === "run" && e.refId === scheduleId.toString(),
  { role: "to", timeoutMs: 15 * 60_000 },
);
console.log("paid in", paid.txHash, "final:", paid.final);
```

## The five kinds

| Kind | Contract | `refId` | `from` | `to` | `amount` |
|---|---|---|---|---|---|
| `run` | executor | schedule id | the payer | the recipient | what arrived, after the fee |
| `schedule_created` | executor | schedule id | the payer | the recipient | what each payment will deliver, after the fee |
| `policy_payment` | allowance | policy id | the policy's owner | the recipient | what was paid; agent payments carry no fee |
| `policy_created` | allowance | policy id | the owner | none | none |
| `policy_revoked` | allowance | policy id | the owner | none | none |

`agent` is set on the three policy kinds: the agent the policy names.

## The fields of an event

Amounts and ids are strings, because an 18-decimal amount doesn't fit in a JavaScript number. Addresses come back in lowercase, so compare them without regard to case.

| Field | Type | Meaning |
|---|---|---|
| `seq` | number | Position in the feed. It moves whenever the event changes. |
| `chainId` | number | `42220`, Celo mainnet. |
| `contract` | address | The contract that emitted the log. |
| `kind` | string | One of the five kinds above. |
| `refId` | string | The schedule id or the policy id. |
| `from`, `to`, `agent` | address or null | The payer, the recipient and the paying agent, as the table above sets them. |
| `token` | address or null | The token that arrived. |
| `amount` | string or null | Base units after the fee: what the recipient received. |
| `amountIn` | string or null | For a run, base units before the fee: what left the payer. |
| `memo`, `memoText` | string or null | A policy payment's 32-byte memo, and the same as text when it is plain text. A request's reference travels here. |
| `runNumber` | number or null | Which payment of the schedule this run was, from 1. |
| `early` | boolean or null | For a run, whether a trigger brought it forward. |
| `details` | object | Facts specific to the kind (below). |
| `txHash`, `logIndex` | string, number | The transaction and the log inside it. Together they identify the event. |
| `blockNumber`, `blockHash`, `blockTime` | number, string, string | Where and when it was mined. |
| `final` | boolean | At or below Celo's finalized block. |
| `removed` | boolean | Undone by a reorg. |

What `details` holds depends on the kind:

- `run`: `nextRunAt`, the Unix time the next payment is due. An early payment adds `triggeredBy` and `triggersLeft`.
- `schedule_created`: `interval` (seconds), `maxRuns`, `expiresAt`, `minRateE6`, `payoutType`, `feeBps`, `fundingToken`, and `builderCodes`: the integrator codes read from the transaction that created it (see [builder codes](./builder-codes.md)). Events recorded before 25 October 2026 have no `builderCodes`.
- `policy_created`: `perPayment`, `perDay`, `expiresAt` and `allowlistOnly`.

## Final and removed

A payment appears as soon as the indexer sees it, usually within a minute or two of its transaction, with `final: false`. Celo's finalized block passes it usually 25 to 30 minutes later, and the same event comes round again with `final: true` and a new `seq`.

A block above the finalized one can still be replaced by a reorg. If that undoes an event you were shown, it comes round once more with `removed: true`. Removed events are never deleted, so you can always see what changed.

So decide what each step of your own process needs:

- show "payment received" as soon as an event arrives with `final: false`;
- release anything you can't take back, such as goods or a withdrawal, only once the same event reads `final: true`;
- treat `removed: true` as "that payment didn't happen", and key your records on `txHash` and `logIndex` so the later versions of an event replace the earlier one.

> **Tip**
>
> For anything valuable, also read the transaction yourself. The event names it in `txHash`, and the chain is the authority.

## Poll, or use webhooks?

Both read the same payment events.

- **Polling** with `events.list` or `events.watch` needs no public endpoint. It suits scripts, agents and anything behind a firewall. You keep the cursor.
- **[Webhooks](./webhooks.md)** push each payment to your server as it happens, signed, and retry for 24 hours if your server is down. They suit a web service that should react at once.

Many integrations use both: webhooks for speed, and a periodic `events.list` from the last `seq` to catch anything missed.

The same feed is available over plain HTTP, without the SDK: see [`payment-events` in the HTTP API](../reference/http-api.md#payment-events).
