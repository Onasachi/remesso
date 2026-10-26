# Give an AI agent a budget

> Cap what an agent's key can spend from a person's wallet, pay with idempotency keys so a retry never pays twice, and let the person review and revoke.

Source: https://docs.remesso.xyz/docs/use-cases/ai-agent-budget

An AI agent that buys things for a person needs money it can spend, within limits the person trusts. Handing it a funded key trusts it with everything. With a policy, the person caps what the agent's key can pay: so much per payment, so much per day, for so many days, and optionally only to a fixed list of recipients. The agent pays from the person's wallet, and the contract refuses anything outside the policy.

## What you'll build

- `grant.ts`: the person creates the policy, once.
- `agent.ts`: the agent pays, with an idempotency key per payment and a store on disk, so a retry after a timeout or a crash never pays twice.
- Paying or declining a payment request sent to the person.
- `review.ts`: the person sees the policy, the agent's payments, and can revoke it.

## Prerequisites

- The setup from [Installation](../installation.md).
- **The person:** a key holding the USDT the agent may spend, and a little CELO to sign the policy. With no CELO, the SDK pays that gas in USDT. The person can also set the policy up in the Remesso app at [remesso.xyz/agent-wallet](https://remesso.xyz/agent-wallet).
- **The agent:** its own key, generated for this and holding nothing of value. Agent payments are signed before they're sent, so they need a local account (`privateKeyToAccount`). The agent's key pays its own gas, so keep a little CELO in it. The SDK wants twice a payment's gas in hand before it signs, about 0.05 CELO at 200 gwei. Alternatively, a little USDT of its own then pays the gas.

Policy payments carry no fee: what the agent pays is what arrives. There's no per-payment minimum either: the executor's 1-dollar floor applies to schedules only.

## Step 1: The person grants a policy

```ts title="grant.ts"
import { createRemesso } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const person = createRemesso({
  account: privateKeyToAccount(process.env.PERSON_KEY as `0x${string}`),
});

const policy = await person.policies.create({
  agent: process.env.AGENT_ADDRESS!, // the agent's key, which will call pay()
  token: "USDT",
  perPayment: "5", // at most 5 USDT a payment
  perDay: "20", // and 20 USDT in any rolling day
  days: 30, // it ends by itself after 30 days
  budget: "100", // added to your USDT approval for the allowance contract
  recipients: [process.env.SHOP!], // optional: the only addresses the agent may pay
});
console.log(`policy #${policy.id}: https://celoscan.io/tx/${policy.hash}`);
```

This sends two transactions: an approval, then the policy. `budget` is added to the person's USDT approval for the allowance contract. That approval is the most this policy and the person's other USDT policies can ever spend together, whatever the caps say. Leave out `recipients` to let the agent pay anyone. Whether a policy has a list is fixed when it's created. On a policy created with one, the person can add or remove recipients later with `policies.setRecipient(id, address, allowed)`.

## Step 2: The agent pays

Give every payment you intend its own idempotency key, such as an order or invoice id. The SDK signs the payment and records it in the store before broadcasting it. A retry with the same key then reports what became of that payment instead of making another.

```ts title="agent.ts"
import { createRemesso, RemessoError } from "remesso-sdk";
import { fileStore } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const agent = createRemesso({
  account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`),
  store: fileStore(), // ~/.remesso-sdk/payments.json: a retry pays once, even after a restart
});

/// Pay for one order. Safe to call again with the same order id, after a timeout or a crash.
export async function payForOrder(orderId: string, shop: string, amount: string) {
  try {
    const r = await agent.pay({
      to: shop,
      amount, // decimal, in the policy's token: "2.50"
      token: "USDT",
      idempotencyKey: `order:${orderId}`, // one key per payment you intend
      memo: `order ${orderId}`, // up to 32 bytes, recorded on-chain
    });
    if (r.status === "pending") return { state: "pending", hash: r.hash } as const; // call again later, same order id
    return { state: r.repeat ? "already paid" : "paid", hash: r.hash, sent: r.sent } as const;
  } catch (e) {
    if (e instanceof RemessoError && e.code === "refused") return { state: "refused", reason: e.message } as const;
    throw e;
  }
}
```

The agent can check its limits before it promises anything:

```ts
import { formatAmount } from "remesso-sdk";

for (const id of await agent.policies.find()) {
  const p = await agent.policies.get(id);
  if (!p.active) continue;
  console.log(`policy #${p.id}: up to ${formatAmount(p.spendable, p.token)} now, ${formatAmount(p.remainingToday, p.token)} left today`);
}
```

`spendable` counts every limit at once: the per-payment cap, what's left of today, and the person's balance and approval.

### What `pay` answers

| What happened | What `pay` does | What the agent does |
|---|---|---|
| It landed | Returns `status: "confirmed"` | Done. |
| No receipt within 45 seconds (`waitMs`) | Returns `status: "pending"` | Call again later with the same key. |
| The same key again, after it paid | Returns `confirmed` with `repeat: true`, and sends nothing | Treat it as paid. |
| The same key for a different payment | Throws [`key_reused`](../reference/errors.md#key_reused) | Fix the bug: one key per payment. |
| An identical payment in the last ten minutes, without a key | Throws [`repeat`](../reference/errors.md#repeat) | Pass a key, or `allowRepeat` if you mean it. |
| Over a cap, revoked, expired, or a recipient not on the list | Throws `refused`, before anything is signed | Tell the person. |
| Mined, and reverted | Throws `reverted`: nothing moved | Use a new key to try again. |

A pending payment resolves on the next call with its key. If the transaction is in a block, the call reports the outcome. If it never left the machine, its own signed bytes go out now, with the same nonce, so it still pays at most once. If another transaction took its nonce and it never landed, it's paid afresh under the same key.

`fileStore` keeps a record for 30 days, up to 1,000 of them. Use one process per file: the file isn't locked. The default store is memory, which only protects retries inside one process.

## Step 3: Requests sent to the person

Other people and agents can ask the person to pay with a payment request. The agent sees the person's inbox and can answer a one-off request, such as an invoice, from the policy:

```ts
for (const r of await agent.requests.list(process.env.PERSON_WALLET)) {
  console.log(`${r.from ?? "someone"} asks for ${r.amount} ${r.token}: "${r.note ?? ""}" (${r.id})`);
}

// Pay it: its own amount, its reference as the memo, at most once per request.
await agent.requests.pay(requestId);

// Or turn it down, signed by the agent under the person's policy.
await agent.requests.decline(requestId, { policyId });
```

`requests.pay` pays only a request addressed to the policy's owner, from an active policy of the same token. Its idempotency key defaults to the request id, so paying the same request twice pays once. The memo carries the request's reference, so the requester sees it answered. A request for recurring payments asks for a schedule, which the person signs themselves.

## Step 4: The person reviews and revokes

```ts title="review.ts"
import { createRemesso, formatAmount } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const person = createRemesso({
  account: privateKeyToAccount(process.env.PERSON_KEY as `0x${string}`),
});
const policyId = BigInt(process.env.POLICY_ID!);

const p = await person.policies.get(policyId);
console.log(`policy #${p.id} for ${p.agent}: ${p.active ? "active" : p.revoked ? "revoked" : "expired"}`);
console.log(`${formatAmount(p.spendable, p.token)} spendable now, ${formatAmount(p.remainingToday, p.token)} left today`);

// Every payment made from this wallet under a policy, as Remesso's indexer reads it from the chain.
const { events } = await person.events.list({ role: "from", kinds: ["policy_payment"] });
for (const e of events.filter((x) => x.refId === p.id.toString())) {
  console.log(`${e.blockTime}  ${formatAmount(e.amount!, e.token!)} to ${e.to}  ${e.memoText ?? ""}`);
}

if (process.argv.includes("--revoke")) {
  console.log("revoked:", await person.policies.revoke(policyId)); // the agent's next payment is refused
}
```

Revoking takes effect at once, and no one can undo it, Remesso included. To give the agent a budget again, create a new policy.

## Test it safely

1. Grant a small policy: `perPayment: "0.05"`, `perDay: "0.10"`, `days: 1`, `budget: "0.10"`.
2. Send the agent's key a little CELO, then call `payForOrder("test-1", yourOtherWallet, "0.02")`.
3. Call it again with `"test-1"`: it answers `already paid`, and nothing new is sent.
4. Run `review.ts` to see the payment, then `review.ts --revoke`. A payment after that is refused.

## Where to go next

- [Agent payments](../guides/agent-payments.md): policies, stores and every option of `pay`.
- [Payment requests](../guides/payment-requests.md): requests, references and declines.
- [Errors](../reference/errors.md): every `RemessoError` code, and what to do about it.
- [Security](../resources/security.md): what a policy protects, and what it doesn't.
