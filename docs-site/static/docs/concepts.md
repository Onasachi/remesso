# Core concepts

> Schedules, the executor, triggers, fees, agent policies, payment requests, payment events, finality and webhooks, and how they fit together.

Source: https://docs.remesso.xyz/docs/concepts

Remesso has a small number of moving parts. This page explains each one and what it guarantees, so the guides that follow read as variations on the same model.

## Celo mainnet, stablecoins only

Remesso runs on Celo mainnet (chain id `42220`) and nowhere else.

Payments are in stablecoins and local-currency tokens: USDT, USDC, USDm and USA₮ (US dollars), Ripio's wARS, wBRL, wCOP, wMXN, wCLP and wPEN (Argentine, Colombian, Mexican and Chilean pesos, Brazilian reais and Peruvian soles), and cNGN (Nigerian naira). Tokens have different decimals: USDT has 6 and wARS has 18. The SDK takes amounts as decimal strings, like `"2.50"`, and returns base units as `bigint`. The full list is in [tokens and limits](./reference/tokens-and-limits.md).

## Schedules: a payer signs once

A **schedule** is a standing instruction a payer signs on-chain: this amount, to this address, this often, this many times. It lives in the `RemessoExecutorV5` contract, created with two transactions from the payer's wallet: an ERC-20 approval for the contract, then the schedule itself.

What the payer signs is final:

- **The recipient, the amount and the cadence never change.** Not by Remesso, not by the contract's owner, not by the payer. Cancelling is the only edit.
- **It ends.** A schedule has a number of payments and an expiry, at most a year after it starts.
- **It can be paused and resumed** by the payer, and **cancelled** for good.
- **It spends through the approval.** Revoking the approval stops every future payment, so the payer always keeps a way out.

A payment is gone once it is sent. Remesso can't reverse it, and neither can the payer.

## The executor sends each payment

Remesso's **executor** is a backend service with a key of its own. Every minute it finds schedules that are due and asks the contract to run them. The contract checks each request against what the payer signed. The executor pays the gas for each payment; the payer pays none after creating the schedule.

A few rules shape when a payment goes out:

- **The first payment follows creation within minutes.** A schedule created in the Remesso app is known at once. One created anywhere else, such as with the SDK, is discovered by a sync that runs every five minutes.
- **Each payment must be worth between 1 and 1,000 dollars**, or the same in local currency. A schedule outside those bounds is valid on-chain but the executor never runs it, so the SDK refuses one before you sign. See [fees, limits and gas](./guides/fees-and-gas.md).
- **A payment that can't go out waits.** If the payer's balance or approval is short when a payment is due, the executor skips it, and it goes out once the payer tops up. Payments aren't caught up in a burst.

## Triggers: bringing a payment forward

A payer can grant a **trigger**: an address allowed to bring the next payment forward. The payment is the same one, with the same recipient and amount. A trigger moves a payment earlier and never adds one. Granting `"remesso"` lets Remesso's executor do it, which is what makes `trigger-run` (a paid early send) usable for that schedule.

## Fees

Remesso takes **0.25% of each scheduled payment**, out of the payment and rounded up. When a payer sends 1 USDT, the recipient receives 0.9975. The fee is pinned in each schedule when it is signed. Agent payments carry no fee, and receiving costs nothing.

When you want the recipient to get an exact amount, ask for it with `receive` and the SDK works out what to send. Payment requests work the same way: a requested amount is what the recipient receives.

## Agent policies: spending within limits

A **policy** lets a person's agent pay from the person's wallet, within limits the person sets. It lives in the `RemessoAgentAllowance` contract, which has no owner and no admin. A policy has:

- one token;
- a cap per payment, and a cap per day: a 24-hour window that opens with the first payment after the previous window has closed;
- an expiry;
- optionally, a list of the only addresses the agent may pay;
- a budget: the person's token approval for the allowance contract, shared by their policies for that token.

The agent's key calls `pay` and pays its own gas. The contract refuses any payment outside the policy, and the person can revoke the policy at any time.

**Idempotency** keeps retries safe. Give each payment you intend an idempotency key, such as an invoice id. A retry with the same key reports the first attempt's outcome and never pays twice, even if the first attempt timed out after it was sent. Without a key, an identical payment within ten minutes is refused.

## Payment requests: asking to be paid

A **payment request** asks a wallet to pay you: how much, in which token, how often. It costs nothing to send. It appears in the payer's Remesso inbox and comes with a link that opens their payment form filled in. A request can't move money: the payer still signs in their own wallet.

A request has a state:

| State | Meaning |
|---|---|
| `pending` | Waiting for the payer. Requests stay live for 30 days. |
| `accepted` | A schedule or payment answered it on the requested terms. |
| `accepted_with_changes` | It was answered, but some terms differ from what was asked. |
| `declined` | The payer, or their agent, turned it down with a signature. |
| `expired` | Not answered in time. |

**Accepted is not paid.** A request counts as paid only when a payment with a transaction is recorded against it.

## Payment events and finality

Remesso's **indexer** reads the contracts every minute and records each payment as a **payment event**: payments sent on a schedule, schedules created, agent payments, and policies created or revoked. You can list them by address, or have them delivered as webhooks.

Two fields matter most:

- **`final`** turns true once the block is at or below Celo's finalized block, about 25 to 30 minutes after the payment. Before that, a payment is very likely to stand but not yet certain. Ship goods or grant access on `final` when the amount warrants it.
- **`removed`** turns true if a chain reorganisation undid the block. The event is kept and marked, never deleted.

Every change to an event gives it a new `seq`, so reading from your last `seq` misses nothing.

## Webhooks

A **webhook** subscription sends an address's payment events to your HTTPS endpoint as they happen. Deliveries follow the Standard Webhooks format and are signed with a secret only you and Remesso know. There are three types: `payment.received`, `payment.finalized` and `payment.removed`.

Delivery is at least once: a failed delivery is retried with the same `webhook-id` for 24 hours. Deduplicate on that id.

## Builder codes

Celo credits on-chain activity to the app that caused it, through ERC-8021 attribution codes on each transaction. Every transaction the SDK sends carries Remesso's codes. Add your own **builder code** and it rides along too, including on every payment Remesso sends for the schedules your app creates. See [builder codes](./guides/builder-codes.md).

## Reads can lag behind writes

Celo's public RPC is several nodes behind a load balancer. For a few seconds after a transaction lands, a read can come from a node that hasn't seen it. The SDK waits for things it has just created to become visible, and retries an answer to a request while the backend can't see the schedule yet. In your own code, expect a balance or a status read straight after a transaction to be a block behind, and read again.

## What is on-chain and what isn't

| On-chain, enforced by contracts | Off-chain, run by Remesso |
|---|---|
| Schedules and everything they pin | The executor that sends due payments |
| Agent policies and their limits | Payment requests and their states |
| Every payment, and its recipient and amount | The indexer, payment events and webhooks |

The contracts are the authority. If Remesso's backend stopped, no schedule could pay more, pay someone else or pay earlier than its payer allowed; scheduled payments would simply wait until it came back. Agent payments go straight to the contract, so they keep working.

## Next steps

- [Pay on a schedule](./guides/schedules.md)
- [Agent payments](./guides/agent-payments.md)
- [Payment requests](./guides/payment-requests.md)
