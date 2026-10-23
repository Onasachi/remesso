# Agent-to-agent remittance: letting developers build on Remesso

**Status: planned, nothing built yet (2026-10-23).** This is the plan for the
next feature. It lets developers build agents that pay each other through
Remesso, and it lets Remesso tell an agent when it has been paid.

Today Remesso serves two cases. A person pays someone (the app), and a person's
agent pays within limits that person signed (the Claude plugin and the Claude
app). Most of what a paying agent needs already exists. Three pieces are
missing:

- **The receiving side.** A recipient's agent can't tell when it has been
  paid. It also can't tell whether a request it sent was accepted.
- **Recurring payments from a person's money.** An agent spending its person's
  money, under a `RemessoAgentAllowance` policy, can only make one-off
  payments. A recurring payment still needs the person to sign a V5 schedule.
  An agent paying from its own funded wallet can already create a schedule:
  schedule #7 was one.
- **A developer kit.** There is no SDK and no testnet, so mainnet is the only
  place to build. Both contracts are live there and unaudited.

| | |
|---|---|
| `RemessoExecutorV5` | `0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8`: schedules, runs, early sends |
| `RemessoAgentAllowance` | `0xA6351fAeEb097698289586C4D6188530300DB209`: an agent's spending limits, one-off `pay()` with a memo |
| ERC-8004 registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`: how one agent finds another's wallet |

---

## The flow we're aiming for

1. The recipient's agent publishes how it wants to be paid: its wallet, the
   tokens it accepts, and whether a payment must carry a reference.
2. It asks the payer's agent to pay, through `request-payment`.
3. The payer's agent checks the request against the limits its person signed.
   Then it pays once or sets up a standing order.
4. Our agent runs each payment. The recipient's agent gets a signed "you were
   paid" message and acts on it: it cashes out through Ripio or Textile,
   saves, or issues a receipt.

Where each step stands today:

1. Publishing gives a wallet and nothing else.
2. A request reaches the person's app, but not their agent.
3. The payer's agent can only pay once.
4. Our agent runs each payment, but no message goes out.

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

---

## What to build, in this order

### 1. The receiving side (no contract change)

Every receiving agent needs this first, and it is the smallest step.

#### Payment webhooks

An agent registers a URL for its receiving address. We then send that URL a
signed message for every payment to the address, from either contract.

- **Read the events from the chain.** A new cron function (`notify-payees`,
  every minute) reads `RunExecuted` (V5) and `Paid` (allowance) logs from a
  stored block checkpoint. It stores every event and delivers each one to the
  URLs subscribed to its recipient.
  - It has to be one path for every source. An early send by a third party's
    trigger never passes through our functions, and neither does a policy
    payment from the plugin. A hook inside `execute-due-runs` would miss both.
  - Don't use the subgraph for this. It indexes V5 only, and a receiver acts on
    a "you were paid" message.
  - Neither event names the token. Read it once from `getSchedule(id)` or
    `policy(id)` and store it with the event.
- **Sign the messages like the webhooks we receive.** Use the Standard Webhooks
  format: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<HMAC-SHA256>`
  and a `whsec_…` secret. Svix sends us Self's webhooks in this format, and
  `_shared/self.ts` already verifies it. The SDK can ship the same check.
- **Deliver at least once.**
  - Retry with backoff for 24 hours. Receivers deduplicate on `webhook-id`.
  - Also serve a free pull endpoint: payments to an address after a cursor.
    A receiver that was down can then catch up.
  - cNGN's webhooks fire exactly once (trap 3 in `CLAUDE.md`). Ours must never
    make a receiver depend on one delivery arriving.
- **Only the address may subscribe.** Registering needs a signature from the
  receiving address (ERC-1271 for smart accounts). Without that, anyone could
  take an address's subscription slots, or point our deliveries at someone
  else's server.
- **Only safe URLs.** Accept HTTPS only, and refuse private and link-local
  addresses: a function that fetches a URL someone typed is an SSRF risk.
- **The payload says what to verify:**
  - chain id and contract
  - `schedule` or `policy`, with its id
  - from, to and token
  - amount received, in base units as a string. For a run this is
    `RunExecuted.amountOut`, which is after the fee.
  - memo, for policy payments
  - for runs: the run number, and whether it was an early send (`RunTriggered`
    in the same transaction)
  - tx hash, log index and block number

  A receiver about to release goods should check the transaction itself. The
  block number lets it wait for more confirmations.

#### Request outcomes

How requests work today, checked in the code:

- `request-payment` returns the request's id, but the prefill link carries no
  id. A schedule made from a request can't be traced back to it.
- The table has a `used` status, but nothing sets it. A request stays `pending`
  until the payer dismisses it, and drops off their list after 30 days.
- `dismiss_payment_request` takes only the id, and `payment_requests_for` hands
  the ids to anyone who names the payer's address. So anyone can clear any
  payer's requests. That's harmless while requests are advisory. Fix it before
  a request's state means anything to an agent.
- Neither the MCP wallet nor the Claude connector can see requests addressed to
  the person's wallet. The paying agent never sees the request at all.

What to build:

- **Anyone can report what answered a request, because we check it on-chain.**
  `request-payment` takes the request id plus a schedule id or a tx hash.
  - A schedule answers it if its `sender` is the request's payer and its
    `destination` is the request's `to`.
  - A tx answers it if it holds a `Paid` event from a policy the payer owns,
    sent to the request's `to`.
  - On a match, set `status = 'used'`. Add columns for the schedule id and
    executor address, because ids repeat across deployments, or for the tx hash.
- **The app reports its own schedules.** The prefill link carries the request
  id (`req=`, validated in `web/lib/payLink.ts`), and the form reports the
  schedule after `confirm-schedule`.
- **A policy payment needs no extra call.** A request id is a UUID: 32
  characters without dashes, which fits the memo exactly. `notify-payees` sees
  the memo and marks the request.
- **The asking agent can check the status.** `request-payment` returns
  `pending`, `accepted` or `expired`:
  - `accepted` comes with the schedule or tx, and the terms actually signed,
    which can differ from the terms asked for.
  - The webhook also sends `request.accepted`.
- **The paying agent gets an inbox.** Add `payment_requests` and
  `dismiss_request` tools to the MCP wallet and the connector.

#### Payee profile

`find_agent` reads only `getAgentWallet`. Add a payments entry to the ERC-8004
registration file. A payer's agent then learns which tokens a payee accepts and
whether it needs a reference, not just its wallet.

- Our own registration already has `services` and a `payment` block
  (`docs/erc8004/registration.json`). Define a `remesso` entry that other
  agents can add the same way.
- Teach `find_agent` to read the agent's URI, whether it is `data:`, `https:`
  or `ipfs:`.
- Before inventing anything, check the ERC-8004 spec and Celo's agent docs for
  an existing convention, and follow it if there is one.

**Done when:**

- A test agent on mainnet registers a webhook. It gets a signed delivery
  within two minutes of a V5 run to it, and of a policy payment to it. The same
  code as `self.ts` verifies both.
- A request reads `accepted`, with its schedule, after the payer signs in the
  app. It also reads `accepted` after a policy payment carrying its id.
- The MCP wallet lists requests addressed to it.
- `find_agent` returns a payee profile.

### 2. A developer kit (no contract change)

- **`@remesso/sdk` in TypeScript, on viem.** Most of it exists already and
  needs extracting, not writing:
  - schedules, from `examples/create-schedule.ts`
  - policy payments and agent lookup, from `mcp/src/server.mjs`
  - links, from `web/lib/payLink.ts`
  - the webhook check, from `_shared/self.ts`
  - requests and the step 1 calls

  Generate the addresses and token lists from the live `/agent` document, with
  a `--check` for drift, the way `scripts/build-skill-manifest.ts` does for the
  skills. People will believe an SDK that describes something we no longer
  serve.
- **Celo Sepolia, Celo's testnet.**
  - Deploy both contracts there, with test tokens that use the real decimals
    (6 and 18). Decimal mistakes then show up on testnet, not mainnet.
  - Run a test executor in a second Supabase project: `execute-due-runs`,
    `sync-schedules` and `notify-payees` against the testnet contracts.
  - Why a separate project: schedule ids repeat across deployments. Separated,
    no testnet row can ever reach the mainnet executor, and no mainnet key sits
    in a testnet environment.
- **A developer page** at `remesso.xyz/developers`, next to `/claude`. Bring
  `docs/AGENTS.md` up to date too.
- **Two example agents in `examples/`.** Each shows the whole loop: request,
  answer, payment, webhook.
  - A freelancer's agent that asks a client for wARS every month.
  - A family allowance agent that pays cNGN every week.

**Done when:** a developer who has never seen the repo follows the developer
page alone. They get from `npm install` to a testnet payment and its webhook in
under 15 minutes.

### 3. Standing orders for agents (new contract and audit)

This is the piece that makes it fully agent-to-agent. A person signs one
policy, and their agent then sets up recurring payments within it without
asking again.

Today, the allowance contract makes one-off payments only, and a V5 schedule
needs the payer's own signature. So a person's agent can't start "pay this
freelancer 200 wARS every month" unless the person signs a schedule.

The fix is a second version of `RemessoAgentAllowance`. V5 stays as it is.
Settle these in the design:

- **Caps in the terms a person thinks in.** Per payment, per day, per month
  ("up to 50 USDT a month"), an end date and an allowlist of payees. Today's
  policy has no monthly cap: a cap of 50 a day allows 1,500 a month.
- **Orders live under the policy.**
  - The agent creates, changes and cancels orders (payee, amount, interval,
    number of payments, memo), always within the caps.
  - Each run counts against the same caps as one-off payments, so the caps
    bound everything the agent can cause.
  - Revoking the policy stops every order at once. The person keeps one Stop
    button.
- **Who runs a due order.** By default our executor, as with V5. These are
  plain transfers with no price to protect, so letting anyone run a due order
  is also safe. It would let a payee's own agent collect while we are down.
  Decide this in the design review.
- **Fee.** V5 runs carry the 25bps commission and policy payments carry none.
  Our executor would pay gas on every run, about 92k gas each, as for a V5 run.
- **The same events.** Each run emits `Paid` with the order's memo, so the
  step 1 webhooks cover it with no new work.

Until it ships, a paying agent can call `pay()` on its own timer, with the
payee on the policy's allowlist. That only works if the agent is running when a
payment falls due: the hosted agent is, a laptop isn't.

**Done when:**

- Forge tests for the new contract pass with the existing 96.
- A person has audited it.
- On mainnet, a person signs one policy, and their agent starts, runs and
  cancels a monthly order with no further signature.

### 4. Builder codes: a reason for developers to choose Remesso

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

- **An audit.** A person has to audit both live contracts, and the
  standing-orders contract before it ships. Neither live contract has had one.
- **The lawyer.** When agents pay across borders for other people, the
  money-transmission question gets harder. That question already keeps the
  naira rails off and the hosted agent invite-only.

## Open questions

- **Dismissed requests.** Do we tell the asking agent when a payer dismisses its
  request? An invoice that's declined usually says so, but a person ignoring a
  stranger's request may not want to. Proposed: no. The request reads `expired`
  once it drops off the payer's list after 30 days.
- **Payee profile format.** Is there already a convention for a payee profile in
  ERC-8004 registrations, or in Celo's agent docs?
- **Standing orders.** Do they carry a fee, and who may run a due order?
- **npm name.** `@remesso/sdk` needs the `remesso` npm organisation. Otherwise
  use `remesso-sdk`, next to `remesso-wallet`.
- **Testnet tokens.** Which real tokens exist on Celo Sepolia, if any, and which
  do we deploy as test tokens?
