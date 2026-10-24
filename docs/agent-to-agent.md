# Agent-to-agent remittance: letting developers build on Remesso

**Status: planned, nothing built yet.** Written 2026-10-23. Revised the same
day after an audit of this plan against the contracts, the Supabase functions
and migrations, both MCP servers and the web app. Every finding below was
checked in the code before it went in. The open questions were decided on
2026-10-24 (see Decisions at the end). The phases, files and shipping steps
are in [`agent-to-agent-implementation.md`](agent-to-agent-implementation.md).

This is the plan for the next feature. It lets developers build agents that pay
each other through Remesso, and it lets Remesso tell an agent when it has been
paid.

**The promise it has to keep:** an agent pays the intended invoice once, within
its actual budget, and both sides can verify and recover the outcome.

Today Remesso serves two cases. A person pays someone (the app), and a person's
agent pays within limits that person signed (the Claude plugin and the Claude
app). The live system doesn't fully keep that promise yet, so the plan starts by
fixing it (step 1). After that, three pieces are missing:

- **The receiving side.** A recipient's agent can't tell when it has been paid.
  It also can't tell whether a request it sent was accepted.
- **Recurring payments from a person's money.** An agent spending its person's
  money, under a `RemessoAgentAllowance` policy, can only make one-off
  payments. A recurring payment still needs the person to sign a V5 schedule.
  An agent paying from its own funded wallet can already create a schedule:
  schedule #7 was one.
- **A developer kit.** There is no SDK. We build on Celo mainnet only, with no
  testnet (decided 2026-10-24), and both contracts there are unaudited.

| | |
|---|---|
| `RemessoExecutorV5` | `0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8`: schedules, runs, early sends |
| `RemessoAgentAllowance` | `0xA6351fAeEb097698289586C4D6188530300DB209`: an agent's spending limits, one-off `pay()` with a memo |
| ERC-8004 registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`: how one agent finds another's wallet |

---

## The flow we're aiming for

1. The recipient's agent publishes how it wants to be paid: the tokens it
   accepts, and whether a payment must carry a reference. Its wallet comes from
   the ERC-8004 registry.
2. It asks the payer's agent to pay, through `request-payment`.
3. The payer's agent checks the request against the limits its person signed.
   Then it pays once or sets up a standing order.
4. Our agent runs each payment. The recipient's agent gets a signed "you were
   paid" message, checks the transaction, and acts on it: it cashes out through
   Ripio or Textile, saves, or issues a receipt.

Where each step stands today:

1. Publishing gives a wallet and nothing else.
2. A request reaches the person's app, but not their agent.
3. The payer's agent can only pay once, and a retry can pay twice.
4. Our agent runs each payment, but no message goes out, and a reverted run can
   be recorded as delivered.

## What developers can use today

| Piece | What it does | Where |
|---|---|---|
| V5 schedules | Any app or agent can create a schedule. `sync-schedules` adopts it within 5 minutes, and `execute-due-runs` runs each payment on time. | `examples/create-schedule.ts` |
| Early sends | A schedule can let another program bring one payment forward (`runNow`). It can also let Remesso do it, and Remesso sells that as `trigger-run` over x402 ($0.01). | contract, `supabase/functions/trigger-run` |
| Policy payments | An agent pays within its person's caps. `pay()` records a 32-byte memo in the `Paid` event, which can carry an invoice reference. | `mcp/src/server.mjs` (`pay`) |
| Agent lookup | `find_agent` turns an ERC-8004 id into that agent's `agentWallet`. | `mcp/src/server.mjs` |
| Payment requests | `request-payment` is free. The request shows on the payer's home screen with a prefill link. | `supabase/functions/request-payment` |
| Paid services | Rates, routes and early sends over x402 v2. | `skills/remesso-x402/` |
| History | The public Goldsky subgraph indexes V5. | `indexer/` |
| Capabilities | `/functions/v1/agent` and `/.well-known/agent.json` | |

Two caveats apply until steps 1 and 2 land. A policy's "total" is not enforced
for that policy alone (1a), and a retried policy payment can pay twice (2b).

---

## What to build, in this order

| Step | What | Contract change |
|---|---|---|
| 1 | Fix the live system: what a run records, who can touch requests, what a budget means | no |
| 2 | One deployment manifest, and payments that can't be paid twice | no |
| 3 | The receiving side: request tracking, payment events, webhooks | no |
| 4 | The developer kit, built on what steps 2 and 3 proved | no |
| 5 | Standing orders for agents | yes, plus an independent audit |
| 6 | Builder codes | no |

### 1. Fix the live system first

These already break the promise, for people as well as agents. Each was
confirmed in the code on 2026-10-23.

#### 1a. "Most in total" isn't a limit per policy

- The setup screen adds each new policy's total to the owner's single token
  approval for the allowance contract (`web/app/agent-wallet/page.tsx:145`).
- The contract tracks a limit per payment and per day
  (`contracts/src/RemessoAgentAllowance.sol:35`). It has no total.
- So every policy on a token shares one approval. Give agent A a total of 20
  and agent B another 20, and A can spend all 40 over two days. The audit
  reproduced this.

Fix now: say on the setup screen that the total is shared by every policy on
that token, and stop presenting it as one agent's limit. Fix for good: add
`totalLimit` and `totalSpent` to each policy in the next contract (step 5).

#### 1b. A reverted run can be recorded as delivered

- `executeRun` and `runNow` in `supabase/functions/_shared/celo.ts` (lines 343
  and 129) wait for the receipt but never check `receipt.status`. viem returns
  a reverted receipt without throwing.
- `execute-due-runs` then writes `delivered`
  (`supabase/functions/execute-due-runs/index.ts:331`). `trigger-run` answers
  `ok: true` to a payer it has already charged
  (`supabase/functions/trigger-run/index.ts:212`).
- A Direct run also records the wrong amount. It stores the amount sent as
  `amount_out`, because line 242 uses the amount in as its quote. The recipient
  actually gets that amount minus the commission.

Fix: accept a run only when `status === "success"` and the receipt holds the
expected `RunExecuted` log (this contract, this schedule id). Record the amount
from that event's `amountOut`, which is after the fee. The local MCP wallet and
the hosted connector already check the status on `pay()`
(`mcp/src/server.mjs:314`, `web/lib/mcp/hosted.ts:415`).

#### 1c. Runs can get stuck or collide

- `due_schedules` skips any schedule with a run in `pending` or `swapping`.
  Nothing moves such a row on, except `cngn-webhook` for bank payouts. If an
  invocation dies after writing the row and before finishing the run, that
  schedule silently drops out of every later pass.
- `execute-due-runs` and `trigger-run` sign with the same executor key, and
  neither manages nonces. A paid early send that lands during a cron pass can
  collide with it, and then fail after the payer was charged.

Fix:

- A recovery pass that checks stale `pending` and `swapping` rows against the
  chain. It asks whether a `RunExecuted` for that schedule landed after the row
  was written, then settles or fails the row.
- One nonce authority for the executor key, shared by both functions, for
  example a lock in Postgres around each send.

#### 1d. Anyone can hide or block a payer's requests

- `dismiss_payment_request` needs only the request's id.
  `payment_requests_for` hands the ids to anyone who names the payer's address
  (`supabase/migrations/20260928000002_payment_requests.sql:69`). So anyone can
  hide every request a payer gets. The first version of this doc called that
  harmless. It isn't.
- The limit of ten pending requests also counts requests older than 30 days
  (`supabase/functions/request-payment/index.ts:137`). The inbox stops showing
  those after 30 days, so nobody dismisses them. Ten abandoned requests then
  block a payer for good.
- The count and the insert are separate steps, so requests sent at the same
  moment can get past the limit.

Fix:

- **Dismissing in the app hides a request for that session only.** An
  anonymous session's claimed wallet is not proof of anything, and MiniPay
  can't sign, so it must not change anything for anyone else.
- **Agents decline with a signature.** An agent holds a key, so it can sign a
  decline. A signed decline is the only kind the requester is ever told about
  (step 3).
- **Expire requests the same way everywhere**, including in the pending count.
- **Make the limit atomic.** Check it and insert in one database function that
  locks on the payer.

**Done when:**

- A forced revert, in a test or on a fork, shows as failed in `runs` and in
  `trigger-run`'s answer.
- A schedule whose invocation was killed mid-run runs again on a later pass.
- A dismissal from another session hides nobody's request.
- Requests older than 30 days no longer count toward the limit.
- The setup screen says what the total really covers.

### 2. One deployment manifest, and payments that can't be paid twice

There is no testnet: we build and test on Celo mainnet with small amounts
(decided 2026-10-24). Some failures can't be forced safely on mainnet, such as
a revert after the simulation passed. Those are tested on a local fork of
mainnet.

#### 2a. One deployment manifest

- **One versioned deployment manifest.** Several clients still hardcode the
  mainnet chain, addresses, tokens or function URLs. For example, the local MCP
  wallet sets `chain: celo` (`mcp/src/server.mjs:101`). Generate one manifest
  from the deployments: chain id, contract addresses, tokens and their
  decimals, function URLs. The web app, both MCP servers, the skills and the
  SDK all read it, so a redeploy, like the contract in step 5, changes one
  file.
- **Check the chain.** Every client checks that the connected chain matches the
  manifest before it signs anything.
- **Keep caches apart.** The local wallet's saved state
  (`~/.remesso-agent/config.json`) is one file today, including how far it has
  scanned for policies. Key it by chain and contract. Policy ids restart at 1
  in every deployment. Otherwise the wallet would scan the step 5 contract
  from the old contract's position and miss its first policies.

#### 2b. Payments that can't be paid twice

`pay()` doesn't check the memo. The audit made two successful payments with the
same policy, recipient, amount and memo. Suppose an agent's tool call times out
after the transaction was sent, and the agent tries again. It pays twice, within
every cap.

- **An idempotency key per payment**, in the local MCP wallet and the hosted
  connector. The same key returns the first payment's result, never a second
  payment.
- **Save the tx hash before waiting** for the receipt.
- **Reconcile before retrying.** Check an uncertain outcome, such as a timeout
  or a dropped connection, against the chain first. Look for the saved hash, or
  a `Paid` event with the same reference.
- **The contract fix comes in step 5.** The next contract refuses a payment
  reference that was already used.

#### 2c. People can always find a policy to stop it

- The setup screen looks only at the newest 200 policies across all users
  (`RECENT_IDS`, `web/app/agent-wallet/page.tsx:40`). The hosted connector
  looks at the newest 1,000 (`web/lib/mcp/hosted.ts:193`).
- Once there are more policies than that, older live ones disappear from the
  screens people use to inspect and stop them.
- Find policies by owner instead, from `PolicyCreated`, whose `owner` field is
  indexed. The screens get them through the subgraph, and the backend through
  the event pipeline in step 3.
- The screens scan ids today because forno answers `getLogs` over at most 5,000
  blocks. The next contract can also keep its own list of policies per owner.

**Done when:**

- Every client's addresses and tokens match the manifest, and the drift check
  passes.
- A client pointed at the wrong chain refuses to sign.
- A payment retried with the same key pays once.
- A policy older than the newest 1,000 still shows on the setup screen.

### 3. The receiving side: request tracking, payment events, webhooks

#### 3a. Requests: accepted, scheduled and paid are different things

A schedule existing doesn't mean money arrived. An agent must never read
"accepted" as "release the goods". So a request has its own states, and
payments have theirs:

- **Request:** `pending`, then `accepted`, `accepted with changes`, `declined`
  (signed, see 1d) or `expired`.
- **Payment, per request:** `scheduled`, then `paid` for each payment that
  settled (with its tx), or `failed`.

Only `paid`, with a transaction the receiver has checked, means money arrived.

**Evidence has to name this request, not just the same two wallets.** Matching
only payer and recipient would tie an old schedule, or an unrelated payment, to
a new request. Bind each answer to:

- **The request reference.** For a policy payment, the request id goes in the
  memo: a UUID is 32 characters without dashes, which fits exactly. V5
  schedules have no memo, so the payer's app or agent reports the schedule id
  against the request.
- **The chain, contract and token address.**
- **The amount.**
- **The timing.** The schedule was created, or the payment made, after the
  request.
- **One answer per schedule.** A schedule that answered one request can't
  answer another.

**Gross or net (decided: net).** Today the form's amount is what the payer
spends, and the recipient receives it minus the 25bps commission. An invoice
names what is owed, so a requested amount is what the recipient receives, and
the form adds the commission on top. Evidence is checked against
`RunExecuted.amountOut`, which is after the fee.

**Changed terms are an answer too.** If the payer changes the amount, token or
cadence, the request reads `accepted with changes`. It shows the terms actually
signed, so the requester can agree or ask again.

**Also needed:**

- The app's prefill link carries the request id (`req=`, validated in
  `web/lib/payLink.ts`), and the form reports the schedule after
  `confirm-schedule`.
- `request-payment` answers status queries for a request id.
- The paying agent gets an inbox: `payment_requests` and `decline_request`
  tools in the MCP wallet and the connector. Today neither can see requests
  addressed to the person's wallet.

#### 3b. One durable record of payment events

Everything downstream reads one table of payment events, built from the chain:
webhooks, request states, the pull endpoint and policy discovery.

- **Sources.** `RunExecuted` and `RunTriggered` from V5. `Paid`,
  `PolicyCreated` and `PolicyRevoked` from the allowance contract.
- **Read the chain, not the subgraph.** The subgraph indexes V5 only, and
  receivers act on these events.
- **One path for every source.** An early send by a third party's trigger
  never passes through our functions, and neither does a policy payment from
  the plugin.
- **A unique identity per event:** chain id, contract, tx hash and log index.
  Store the block hash too.
- **Commit the event rows and the checkpoint together**, in one transaction, so
  a crash can't skip a range or repeat one.
- **An explicit finality rule.** An event counts as final some number of blocks
  behind the head. Measure that number on Celo; don't assume it. Messages say
  whether an event is final.
- **Reorg recovery.** Before reading further, compare the stored block hash at
  the checkpoint with the chain. If it changed, roll back to the last matching
  block and read again.
- **Neither event names the token.** Read it once from `getSchedule(id)` or
  `policy(id)` and keep it with the event.
- **Separate delivery workers** read the table and send webhooks. A slow
  receiver never holds up reading the chain, and failed deliveries can be
  replayed.
- **A free pull endpoint** serves the same events by address, after a cursor,
  for a receiver that was down.

#### 3c. Webhooks

**Delivery:**

- **Use the Standard Webhooks format:** `webhook-id`, `webhook-timestamp`,
  `webhook-signature: v1,<HMAC-SHA256>` and a `whsec_…` secret. Svix sends us
  Self's webhooks this way, and `_shared/self.ts` already verifies it, so the
  SDK can ship the same check.
- **Keep the id the same across retries.** The timestamp and signature are new
  on every attempt, as the spec says. Receivers deduplicate on the id.
- **Deliver at least once.** Retry with backoff for 24 hours, then keep
  failures replayable. cNGN's webhooks fire exactly once (trap 3 in
  `CLAUDE.md`); ours must never make a receiver depend on one delivery.
- **The payload says what to verify:**
  - chain id and contract
  - `schedule` or `policy`, with its id
  - from, to and token
  - amount received, in base units as a string. For a run this is
    `RunExecuted.amountOut`.
  - memo, for policy payments
  - for runs: the run number, and whether it was an early send
  - tx hash, log index, block number and block hash
  - whether the event is final

  A receiver about to release goods checks the transaction itself.

**Subscribing:**

- **The receiving wallet signs an EIP-712 message.** It names the recipient
  address, the endpoint URL, the chain, the action (subscribe, rotate or
  revoke), a nonce and an expiry. Smart accounts sign through ERC-1271. Without
  this, anyone could fill an address's subscription slots, or point our
  deliveries at someone else's server.
- **The endpoint proves it wants the messages.** It has to echo a challenge
  before any payment event is sent there.
- **Each subscription has its own secret**, which can be rotated and revoked.

**Fetching someone else's URL safely**, following
[OWASP's SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html):

- HTTPS only, and no redirects.
- Resolve the name first. Refuse private, loopback and link-local addresses, in
  IPv4 and IPv6.
- Connect to the address that was checked, so DNS rebinding can't swap it.
- Run delivery workers with no access to our internal network.
- The same rules cover `find_agent` when it fetches an agent's metadata (3d).

#### 3d. Payee profile

- **What to add.** `find_agent` reads only `getAgentWallet`. Add a payments
  entry to the ERC-8004 registration file, so a payer's agent learns which
  tokens a payee accepts and whether it needs a reference.
- **Never take an address from the profile.** The registration file can
  change, `data:` URI or not: the token's owner can call `setAgentURI` at any
  time, and `scripts/erc8004-v5.ts` in this repo does exactly that. The address
  to pay always comes from `getAgentWallet`. Only that wallet's own signature
  can set it, and the registry clears it when the token changes hands.
- **Check for a convention first.** Our own registration has `services` and a
  `payment` block (`docs/erc8004/registration.json`). Before defining a
  `remesso` entry other agents can add the same way, check the
  [ERC-8004 spec](https://eips.ethereum.org/EIPS/eip-8004) and Celo's agent
  docs, and follow any convention they already set.
- **Read every kind of URI.** Teach `find_agent` to read `data:`, `https:` and
  `ipfs:` URIs, under the fetching rules above.

**Done when:**

- A test agent subscribes with a signature, passes the endpoint check, and gets
  signed deliveries within two minutes of a V5 run to it and of a policy
  payment to it. The same code as `self.ts` verifies them.
- A request moves through `accepted`, `scheduled` and `paid`. An older schedule
  between the same two wallets doesn't move it.
- A reorg in a test rolls events back and delivers the corrected ones.
- `find_agent` returns a payee profile, and the address it gives comes from
  `getAgentWallet`.

### 4. The developer kit

Build this after steps 2 and 3, from the interfaces they proved.

- **`remesso-sdk` in TypeScript, on viem.** Most of it is extracted, not
  written:
  - schedules, from `examples/create-schedule.ts`
  - policy payments with idempotency keys, and agent lookup, from the MCP
    wallet
  - links, from `web/lib/payLink.ts`
  - request states, the event pull, and the webhook check from
    `_shared/self.ts`
  - networks, from the deployment manifest (2a), with a `--check` for drift
    like `scripts/build-skill-manifest.ts`. People will believe an SDK that
    describes something we no longer serve.
- **A developer page** at `remesso.xyz/developers`, next to `/claude`. Bring
  `docs/AGENTS.md` up to date too.
- **Two example agents in `examples/`.** Each shows the whole loop: request,
  answer, payment, webhook.
  - A freelancer's agent that asks a client for wARS every month.
  - A family allowance agent that pays cNGN every week.

**Done when:** a developer who has never seen the repo follows the developer
page alone. They get from `npm install` to a small mainnet payment and its
webhook in under 15 minutes. The page says the contracts are unaudited and to
start small.

### 5. Standing orders for agents (new contract and independent audit)

This is the piece that makes it fully agent-to-agent. A person signs one
policy, and their agent then sets up recurring payments within it without
asking again. Today a person's agent can't start "pay this freelancer 200 wARS
every month" unless the person signs a V5 schedule.

The fix is a second version of `RemessoAgentAllowance`. V5 stays as it is.

**What the contract must have:**

- **Real budgets.** `totalLimit` and `totalSpent` per policy (1a). Caps per
  payment, per day and per month, an end date and an allowlist of payees.
- **Unique payment references.** The contract refuses a reference it has
  already seen. Each payment of an order gets its own: the order's reference
  plus the payment number (2b).
- **One Stop button.** Revoking the policy stops every order under it.
- **Orders inside the policy.** The agent creates, changes and cancels orders
  (payee, amount, interval, number of payments), always within the caps. Every
  run counts against the same caps as one-off payments.
- **The same events.** Each run emits `Paid` with its own reference, so step 3
  covers it with no new work.
- **An owner index**, so the screens can list a person's policies without
  scanning (2c).

**Proposed answers (2026-10-24), to confirm in the design review:**

- **Missed payments: like V5.** A payment that can't run when due (no
  balance, over a cap) is retried while it stays due. The next date counts
  from when it actually ran, as V5 does (`nextRunAt = block.timestamp +
  interval`). Nothing is caught up, so a person is never charged for two
  periods at once.
- **One budget, many claims: first come, first served.** Whichever
  transaction lands first uses the cap. An order run that would go over waits
  for its retry, like a payment with no balance.
- **Edits: none.** A change is a cancel plus a new order. The person sees
  both, and an order's terms stay fixed, like a V5 schedule's.
- **Months: 30 days**, like V5 and the app's "every month" (30 × 86,400
  seconds). The monthly cap is a rolling 30-day window, and the app shows the
  actual next date.
- **A cancel against a run: the chain's order decides.** A run that lands
  before the cancel counts, and one after it reverts. The app shows what the
  chain says, including "one last payment went out before the cancel".
- **Who runs a due order: anyone, with our executor as the default.** These
  are plain transfers with no price to protect, so letting anyone run a due
  order is safe. A payee's own agent can then collect while we're down.
- **Fee: the 25bps commission on order runs**, as on V5. It pays for the
  executor's gas, about 92k per run. One-off payments stay free.

**Until it ships,** a paying agent can call `pay()` on its own timer, with the
payee on the policy's allowlist. That only works for an agent a developer runs
on a server. The plugin on a laptop has no timer, and neither does the hosted
connector, which acts only when the person talks to Claude.

**Done when:**

- Forge tests for the new contract pass, along with the existing 96.
- An independent audit is done.
- On mainnet, a person signs one policy, and their agent starts, runs and
  cancels a monthly order with no further signature.
- The same reference can't be paid twice.

### 6. Builder codes: a reason for developers to choose Remesso

An integrator's own ERC-8021 code rides on every payment of the schedules it
creates. Celo's rewards then count that volume for the integrator, not only for
us.

- **The integrator tags its own `createSchedule` transaction** with its code.
  It would do that anyway for its own rewards, and it registers the code with
  Celo, as we did `remesso`.
- **`sync-schedules` reads the code.** It already adopts every schedule created
  outside the app. For each one, it looks up the `ScheduleCreated` log (the id
  is indexed), reads the suffix of that transaction, and stores the codes with
  the schedule.
- **We carry the code on every run.** `execute-due-runs` and `trigger-run`
  append the codes after ours.
  - Schema 0 carries a list, and each code in it is credited
    (`_shared/attribution.ts`).
  - Cap how many codes we carry, and validate their format.
  - The EVM discards the suffix, so a wrong code can put credit in the wrong
    place but can't change what a run does.
- **Fee sharing comes later.** Sharing fees with integrators would need a new
  contract.

**Done when:** every run of a schedule created with an integrator's code
carries that code, checked with the attribution SDK's `verifyTx`.

---

## Before inviting developers to move real money

- **An independent audit** of both live contracts, and of the standing-orders
  contract before it ships. Neither live contract has had one.
- **The lawyer.** When agents pay across borders for other people, the
  money-transmission question gets harder. That question already keeps the
  naira rails off and the hosted agent invite-only.

There is no testnet, so until both are done the developer page says the
contracts are unaudited and to start small.

## Decisions (2026-10-24)

- **Gross or net:** a requested amount is what the recipient receives. The
  form adds the commission on top.
- **Declines:** a signed decline from the paying agent is reported to the
  requester. A dismissal in the app stays private.
- **Finality:** measured on Celo mainnet before step 3 starts, not assumed. A
  Supabase cron samples it every minute from 2026-10-24 to 2026-10-26 (Phase 0
  of the implementation plan).
- **Payee profile format:** follow an existing ERC-8004 or Celo convention if
  there is one. Otherwise define a `remesso` entry (Phase 0).
- **Standing orders:** the proposed answers under step 5, confirmed in the
  design review.
- **npm name:** `remesso-sdk`.
- **Network:** Celo mainnet only, with no testnet. We build and test with
  small amounts. Failures that can't be forced safely on mainnet are tested on
  a local fork.
