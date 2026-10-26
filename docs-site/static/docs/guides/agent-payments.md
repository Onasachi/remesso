# Agent payments

> Let an agent pay from a person's wallet within limits the person sets on-chain, and pay exactly once per idempotency key.

Source: https://docs.remesso.xyz/docs/guides/agent-payments

An agent payment moves tokens from a person's wallet, sent by their agent's key, inside a policy the person signed on-chain. This page covers both sides: the person who sets the policy, and the agent that pays under it.

There are two roles:

- **The person** owns the money. They create a **policy** on the `RemessoAgentAllowance` contract that names the agent's address: one token, a cap per payment, a cap per day, an expiry, and optionally the only recipients allowed.
- **The agent** holds its own key and calls `pay`. The contract moves the tokens straight from the person's wallet to the recipient, and refuses anything outside the policy.

Agent payments carry no fee: what the agent pays is what arrives. The contract has no owner and no admin. Nobody but a policy's owner can change it, and nobody but its agent can spend under it.

## Create a policy

The person creates the policy, in code or in the Remesso app at [remesso.xyz/agent-wallet](https://remesso.xyz/agent-wallet):

```ts
const { id, hash, approveHash } = await person.policies.create({
  agent: "0xAgentAddress",
  token: "USDT",
  perPayment: "5",
  perDay: "20",
  days: 30,
  budget: "100",
});
console.log(`policy ${id}: approval ${approveHash}, policy ${hash}`);
```

Like a schedule, this is two transactions: an approval for the allowance contract, then the policy itself.

| Option | Required | What it is |
|---|---|---|
| `agent` | Yes | The agent's address: the only key that can pay under the policy. |
| `token` | Yes | A symbol or an address. A policy spends one token. |
| `perPayment` | Yes | The most one payment can be, as a decimal string. Above zero, and at most `perDay`. |
| `perDay` | Yes | The most the agent can pay in one day, as a decimal string. |
| `days` | No | How long the policy lasts, in days. Default 30, at most 365. |
| `recipients` | No | If given, the only addresses the agent may pay, up to 50. |
| `budget` | Yes | Added to the person's approval for the allowance contract, as a decimal string. |

### What the budget is, and isn't

The budget is not a total for this policy. It is added to the approval the person gives the allowance contract for that token, and that one approval is shared by all their policies for the token. It caps what all of them can spend together. A policy has no total of its own: it is bounded by its caps per payment and per day until it expires, and by the person's balance and approval.

So size the caps and the expiry for what you are willing to lose, and keep the approval to the budget you mean.

### How the day is counted

The daily cap counts within a 24-hour window. The window opens with the first payment after the previous window closed. It is not a rolling 24 hours, so across a window boundary up to twice `perDay` can move in a short span. `perDay` bounds each window. The expiry and the approval bound the rest.

## Manage a policy

As the person:

```ts
import { formatAmount } from "remesso-sdk";

const p = await person.policies.get(policyId);
console.log(p.active ? `can pay up to ${formatAmount(p.spendable, p.token)} right now` : "revoked or expired");

await person.policies.setRecipient(policyId, "0xNewSupplier", true); // allow a recipient
await person.policies.setRecipient(policyId, "0xOldSupplier", false); // take one off
await person.policies.revoke(policyId); // ends it now, for good
```

- **`get(id)`** returns the policy with what it can spend right now. `active` means not revoked and not expired. `remainingToday` is what is left in the current window. `spendable` is the largest payment allowed this moment, counting the per-payment cap, today's remainder, and the owner's balance and approval.
- **`find(agent?)`** returns the ids of every policy naming an agent, newest first. It defaults to this account, so an agent can find its own.
- **`revoke(id)`** ends a policy now. It is one-way. New limits or a new key means a new policy, so a revoked one can never be quietly brought back.
- **`setRecipient(id, recipient, allowed)`** edits the allowlist of a policy created with `recipients`. A policy created without recipients lets the agent pay anyone, and adding recipients later doesn't change that. To restrict an open policy, revoke it and create one with `recipients`.

Each of these writes needs the owner's key. It pays gas in CELO, or in the policy's token if the owner holds no CELO and the token can pay gas.

## Pay as the agent

```ts title="agent-pays.ts"
import { createRemesso } from "remesso-sdk";
import { fileStore } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const agent = createRemesso({
  account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`),
  store: fileStore(), // the record that makes a retry pay once, kept on disk
});

const r = await agent.pay({
  to: "0xShop",
  amount: "2.50",
  token: "USDT",
  memo: "order 1042",
  idempotencyKey: "order-1042",
});
console.log(r.status, r.sent, r.explorer); // confirmed 2.5 USDT https://celoscan.io/tx/0x…
```

| Option | Required | What it is |
|---|---|---|
| `to` | Yes | The recipient's address. |
| `amount` | Yes | A decimal string in the policy token's units: `"0.10"`. |
| `token` | No | A symbol or an address. Default: the token of the policy used. |
| `policyId` | No | Which policy to pay under. Default: an active policy naming this agent, for the token, that can cover the amount now. |
| `memo` | No | Up to 32 bytes, recorded on-chain in the `Paid` event. |
| `idempotencyKey` | Strongly advised | One per payment you intend, such as an invoice or order id. A retry with the same key never pays twice. |
| `allowRepeat` | No | Pay even though an identical payment went out in the last ten minutes. |
| `waitMs` | No | How long to wait for the receipt before answering `"pending"`. Default 45,000. |

Before signing, the SDK checks the policy is active, names this agent and spends this token, and that the amount fits what it can spend now. Then it simulates the payment, so a refusal from the contract arrives as [`refused`](../reference/errors.md#refused) with its reason in words, before anything is signed.

### What `pay` returns

`pay` resolves to a `PaymentResult`:

| Field | What it is |
|---|---|
| `status` | `"confirmed"`: mined and successful. `"pending"`: sent, but no receipt within `waitMs`. |
| `hash`, `explorer` | The transaction, and its Celoscan link. |
| `policyId`, `to`, `amount`, `token` | What was paid, under which policy. `amount` is in base units. |
| `sent` | The amount and symbol, for people: `"2.5 USDT"`. |
| `repeat` | `true` when this key had already paid and nothing new was sent. |

A `"pending"` result means the payment is out and its outcome isn't known yet. Don't pay again with a new key. Call `pay` again later with the same key, and it reports what became of the first attempt. If the payment was mined and reverted, `pay` throws [`reverted`](../reference/errors.md#reverted): nothing was paid, and a new key is needed to try again.

## Retries and idempotency keys

An agent's tool call can time out after its transaction went out, and the agent tries again. The contract checks nothing about repeats, so without care that is a second payment inside every cap. The SDK prevents it.

Every payment is signed first and recorded in the client's store, with its hash and its signed bytes, before it is broadcast. A retry with the same `idempotencyKey` finds that record and reconciles it with the chain:

| What became of the first attempt | What the retry does |
|---|---|
| Confirmed | Returns it with `repeat: true`. Nothing new is sent. |
| Sent, still waiting to be mined | Returns it as `"pending"`. |
| Signed and recorded, never sent | Sends the recorded bytes, with the same nonce, so it still pays at most once. |
| Dropped: its nonce went to another transaction | Pays now, under the same key. |
| Reverted | Throws `reverted`. Use a new key to try again. |

Two more rules guard against mistakes:

- **A key belongs to one payment.** Reusing a key for a different recipient, amount or memo throws [`key_reused`](../reference/errors.md#key_reused).
- **No key, no quick repeats.** Without a key, a payment identical to one in the last ten minutes, with the same policy, recipient, amount and memo, throws [`repeat`](../reference/errors.md#repeat). The SDK looks in its own store and on-chain. Pass `allowRepeat: true` if you mean to pay twice.

A client sends its agent payments one at a time, so two calls in parallel can't sign with the same nonce.

## Where payment records live

The store is what makes a retry safe, so it must outlive the failure you are guarding against:

- **`memoryStore()`**, the default, covers retries inside one process. A restart forgets it.
- **`fileStore(path?)`** from `remesso-sdk/node` keeps records in a JSON file with mode 0600, by default `~/.remesso-sdk/payments.json`. It holds across restarts. Use one process per file: it isn't locked.
- **Your own store**, such as a database table, implements `PaymentStore`:

```ts
import type { PaymentRecord, PaymentStore } from "remesso-sdk";

// A stand-in for your database: one record per transaction hash.
const records = new Map<string, PaymentRecord>();

const store: PaymentStore = {
  // The latest record for a key, in one deployment.
  async byKey(key, deployment) {
    return [...records.values()].reverse().find((r) => r.key === key && r.deployment === deployment);
  },
  // Records newer than a time, in milliseconds since the epoch.
  async since(since) {
    return [...records.values()].filter((r) => Date.parse(r.at) > since);
  },
  // A key has one record, its latest attempt: replace by hash, or by key in its deployment.
  async save(rec) {
    for (const [hash, r] of records) {
      if (hash === rec.hash || (rec.key && r.key === rec.key && r.deployment === rec.deployment)) records.delete(hash);
    }
    records.set(rec.hash, rec);
  },
};
```

Pass it as `createRemesso({ account, store })`. The built-in stores keep records for 30 days, up to 1,000 of them.

## Memos

A memo is 32 bytes on-chain, measured in bytes, not characters: a plain letter is 1 byte, an accented letter 2, an emoji 4. A longer memo is refused with [`invalid`](../reference/errors.md#invalid), not cut, because a cut reference no longer matches what it refers to. The memo is recorded in the `Paid` event, and [payment events](./payment-events.md) show it as text.

To pay a [payment request](./payment-requests.md), use `agent.requests.pay(requestId)`. It puts the request's 32-character reference in the memo for you.

## What the agent's key needs

**A local account.** Agent payments are signed before they are sent, so the client needs an account made with `privateKeyToAccount`. A browser wallet's `walletClient` can create policies and schedules, but `pay` throws [`no_account`](../reference/errors.md#no_account).

**A little CELO for gas.** The tokens move from the person's wallet, but the agent's key sends the transaction and pays its gas, about 85,000 gas per payment. With too little CELO, an agent that holds some of the policy's token pays gas in that token instead, if it is one that can (USDT, USDC, USDm, USA₮). Otherwise `pay` throws [`no_gas`](../reference/errors.md#no_gas). See [Fees, limits and gas](./fees-and-gas.md).

## What the policy refuses

The SDK simulates every payment, and the contract's refusal comes back as `refused` with its reason:

| The contract says | Because |
|---|---|
| the policy names a different agent | `policyId` belongs to another agent's key. |
| the policy was revoked | Its owner revoked it. |
| the policy has expired | Its `days` have run out. |
| the amount is over the policy's per-payment cap | Lower the amount, or ask the person for a new policy. |
| today's cap is used up | The current 24-hour window is spent. It reopens 24 hours after the window's first payment. |
| the recipient isn't on the policy's allowlist | The policy was created with `recipients`, and this one isn't among them. |
| a policy can't pay its own owner | Paying the person from their own wallet does nothing. |
| the token refused the transfer | The person's balance or approval is too low. |

The SDK checks `spendable` before simulating, so an amount over what the policy allows right now is refused with the exact limit, for example `3 USDT is over what policy 12 allows right now (2 USDT)`.

## Next steps

- [AI agent budget](../use-cases/ai-agent-budget.md): a complete agent that pays under a policy.
- [Payment requests](./payment-requests.md): pay a request as an agent, or decline it for the person.
- [Payment events](./payment-events.md): see each `Paid` event, with its memo.
