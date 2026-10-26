# Security model

> What the contracts guarantee, what Remesso operates and can't do, and how to handle keys, approvals and webhooks safely.

Source: https://docs.remesso.xyz/docs/resources/security

Remesso is built so that the money path depends on contracts, not on trusting Remesso. This page sets out what is enforced, what is operated, and what is left to you.

## What the contracts enforce

**Schedules (`RemessoExecutorV5`)**

- A schedule's recipient, amount, cadence, number of payments and expiry are fixed when the payer signs. No one can change them, including Remesso and the contract's owner.
- Each payment moves only when it is due, and never more than the amount signed.
- A payment can come early only if the payer granted a trigger. A trigger brings the next payment forward; it never adds one.
- The payer can pause, resume or cancel at any time, and revoking the token approval stops every future payment.

**Agent policies (`RemessoAgentAllowance`)**

- An agent can pay only within its policy: one token, a cap per payment and per day, an expiry and, optionally, a list of allowed recipients.
- The contract has no owner and no admin. Only the person who created a policy can revoke it or change its recipient list.
- The person's token approval to the contract caps what all their policies for that token can spend together.

## What Remesso operates

- **The executor**, a backend service with a hot key that sends payments when they are due. The key pays gas and nothing else: the contract decides what each payment is.
- **The indexer**, which reads the contracts and records payment events.
- **Webhooks**, signed deliveries of those events.
- **Payment requests**, which are notes asking to be paid. No request can authorise or move money.

If any of these stopped, scheduled payments would wait and events would stop arriving, but no payment could go to the wrong place or for the wrong amount.

## What you are responsible for

### Keys

- Keep private keys out of code and repositories. Load them from the environment or a secrets manager.
- Use a separate key for each role: the wallet that pays on a schedule, an agent's key, and a receiving address.
- An agent's key should hold only CELO for gas. It spends the person's tokens through its policy, not its own balance.

### Approvals

- `schedules.create` approves the schedule's total and `policies.create` approves the budget, each on top of what is already approved. Keep approvals close to what you intend to pay.
- To stop everything at once, revoke the token approval for the contract.

### Webhooks

- Verify every delivery's signature. `webhookHandler` does it for you; if you handle requests yourself, use `verifyWebhook` or `parseWebhook` on the raw body, before any JSON parser.
- Deduplicate on `webhook-id`: a delivery can arrive more than once.
- For large amounts, act on `payment.finalized`, not `payment.received`, and handle `payment.removed`.
- Treat the signing secret like a password. Rotate it with `webhooks.rotate` if it may have leaked.

### Agent payments

- Give every payment an idempotency key, so a retry after a timeout can't pay twice.
- Keep payment records with `fileStore` or your own store, not in memory, for any agent that restarts.
- Set the tightest policy that works: a low cap per payment and per day, a short expiry and a recipient list when you know who will be paid.

## Reporting a vulnerability

Report security issues privately to the Remesso maintainers, through the [repository](https://bitbucket.org/crackedstudios/remesso), rather than in a public issue.
