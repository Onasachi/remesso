# Agent-to-agent: implementation plan

**Status: Phase 0 measuring; Phase 1 built and tested, not deployed (2026-10-24).** This turns
[`agent-to-agent.md`](agent-to-agent.md) into phases of work.

- That doc says what to build and why. This one says in what order, in which
  files, how each phase ships, and how we know it's done.
- It relies on the decisions at the end of that doc. A requested amount is what
  the recipient receives. A signed decline is reported to the requester. We
  build on Celo mainnet only, with no testnet.

## How we work

- **Branch.** Work happens on `feat/agent-to-agent`, and each phase goes into
  `main` as its own pull request. Phase 1's parts can go separately, so each
  fix to the live system ships as soon as it's ready.
- **Approvals.** Deploys, migrations, secrets and every mainnet transaction
  need your OK first. You run `git push` and `npm publish`.
- **Mainnet only.** We test with small amounts from our own test wallet: the
  `TESTING_*` key that `scripts/e2e-agent-test.ts` uses. Every transaction
  carries our attribution tag. Some failures can't be forced safely on mainnet,
  such as a revert after the simulation passed. Those are tested on a local
  fork (`anvil --fork-url https://forno.celo.org`).
- **Every phase:**
  - The full test list in `CLAUDE.md` passes.
  - `CLAUDE.md` is updated: deployed state, traps, invariants.
  - When an endpoint changes, so do `skills/remesso/SKILL.md`,
    `/functions/v1/agent` and the generated files
    (`scripts/build-skill-manifest.ts`, `scripts/build-plugin.sh`).
- **New public functions** get `verify_jwt = false` in `supabase/config.toml`,
  because they're open to everyone or check a signature instead. Cron-only
  functions keep the default.

## Phases at a glance

| Phase | What | Needs | Rough size |
|---|---|---|---|
| 0 | Measure and research | nothing | half a day, plus at least 24 hours of measuring in the background |
| 1 | Fix the live system | nothing | 4–5 days |
| 2 | One manifest, payments that can't be paid twice, every policy findable | 1 | 4–5 days |
| 3 | The receiving side: events, requests, webhooks, payee profiles | 0, 1, 2 | 10–12 days |
| 4 | The developer kit | 3 | 6–7 days |
| 5 | Standing orders | design any time; build after 2 and 3 | 10–12 days, plus the independent audit |
| 6 | Builder codes | 3 | 2–3 days |

Sizes are rough working days, including review and mainnet checks. Revise them
after Phase 1.

The Agents on Open Rails deadline is 2026-11-09. Phase 1 ships first either
way. Phases 0 to 2 can land before the deadline. Phase 3 is the first that
shows agent-to-agent end to end.

---

## Phase 0: measure and research

Started 2026-10-24. Nothing here changes the product.

- [ ] **Finality (measuring).** It runs on Supabase, so no machine has to stay
  awake:
  - the `measure-finality` function reads the `latest`, `safe` and `finalized`
    blocks in one batched request. It writes their numbers, hashes and times
    to `finality_samples` (migration `20261024000001`);
  - the cron `remesso-measure-finality` calls it every minute, from
    2026-10-24 19:32 UTC. A second job, `remesso-measure-finality-stop`,
    removes both at 2026-10-26 20:00 UTC;
  - `scripts/finality-report.ts` prints how far each tag ran behind (p50 to
    max, in blocks and seconds), any gaps in the sampling, and any block that
    was replaced after we saw it.

  First readings: `safe` 150–240 blocks behind the head (about 2.5–4
  minutes), `finalized` 1,300–1,390 (about 23 minutes). Celo makes a block a
  second.

  **Still to do:**
  1. From 2026-10-25 19:32 UTC, run the report.
  2. Pick how many blocks deep Phase 3 waits before calling an event final,
     and record it in `CLAUDE.md`.
  3. After the stop, drop the table and the function in a migration.
- [x] **Payee profile: no convention exists, so a `remesso` entry**
  (2026-10-24). ERC-8004 leaves payments out and allows custom service names.
  Celo's docs add no payment fields. The entry, the reader's rules and what we
  found are in step 3d of the design doc.
- [x] **npm name: `remesso-sdk`** (decided 2026-10-24). It was free on npm when
  checked that day. Nothing is reserved now: you publish it by hand in Phase 4.
- [x] **Stuck runs today: none.** At 2026-10-24 19:28 UTC no run of any age was
  `pending`, `swapping` or `redeeming`. All 274 rows were `skipped` (244) or
  `delivered` (30). Phase 1's recovery is a safeguard, with nothing to clean up
  yet.

**Done when:** the finality depth, the profile format and the npm name are
written down.

## Phase 1: fix the live system

These are the problems in step 1 of the design doc. No contract change.

**Built and tested 2026-10-24. Not deployed yet:** see "Ship Phase 1".

### 1.1 Runs record what happened on-chain

- [x] **Check every receipt.** `_shared/celo.ts` replaces `executeRun` and
  `runNow` with three steps:
  - `signRun` simulates, then signs, so the hash and the nonce are known
    before anything is sent;
  - `broadcast` sends it;
  - `confirmRun` asks `_shared/receipt.ts`, which accepts a run only when the
    receipt succeeded and holds this contract's `RunExecuted` for this
    schedule.

  `receipt.test.ts` pins it to V5's first real run and to a real reverted
  `executeRun` from a mainnet fork.
- [x] **Record runs from the receipt in `execute-due-runs`.**
  - The hash is written to the row before the broadcast, which goes further
    than the plan: a run that can't be written down isn't sent.
  - `amount_out` comes from `RunExecuted.amountOut`.
  - A reverted receipt marks the run failed, keeping its block and gas.
  - With no receipt within 45 seconds, the row is left `swapping` for the
    recovery pass instead of guessed at.
  - The schedule's next date comes from the event, and its status is read at
    the run's block. A failed read there no longer turns a delivered run into
    a failed one.
- [x] **`trigger-run` stops reporting reverted runs as sent.**
  - A reverted receipt is the existing 409, "you were charged but the run did
    not go through", now with the hash.
  - With no receipt within 30 seconds it answers 504, with the hash to check.
- [x] **Two new failure categories**, in `_shared/failures.ts` and
  `web/lib/failures.ts`, pinned by `failures.test.ts`:
  - `reverted`: sent and rejected on-chain;
  - `interrupted`: abandoned before sending, or sent and never mined.
- [x] **Check past runs.** `scripts/check-past-runs.ts` reads only, unless
  given `--write`. The dry run on 2026-10-24 found:
  - all 30 runs recorded as sent succeeded on-chain;
  - the 18 V4 and V5 runs recorded the amount sent, not the amount after the
    fee;
  - the 12 earlier runs, from contracts that charged no fee, are right.

  `--write` fixes the 18 at ship time.

### 1.2 Stuck runs and nonces

- [x] **Recover stuck runs.** Each `execute-due-runs` pass first looks at up
  to 5 `pending` or `swapping` rows older than 10 minutes:
  - **A row with a hash** is settled from its receipt. A hash the chain still
    doesn't know after three tries fails as never mined.
  - **A row without a hash** was never sent by today's code. For a row from
    before this change, it looks for our own `executeRun` of that schedule
    since the row was written. That costs one read when nothing has run since,
    otherwise one log window of 5,000 blocks. It doesn't compare run counts,
    because an early send through `trigger-run` writes no row.
  - The decision is `_shared/recovery.ts`, a pure function, tested by
    `recovery.test.ts`.
  - `redeeming` rows stay with `reconcile-redemptions`.
- [x] **One sender at a time for the executor key.** Migration
  `20261024000002_executor_lease.sql` and `_shared/lease.ts`:
  - one lease row per executor key, taken and released through RPCs, with an
    expiry;
  - held from fetching the nonce until the receipt, not only until the
    broadcast, so the next sender always fetches its nonce after the last
    transaction was mined;
  - the row keeps the last nonce a holder saw mined, and the next sender signs
    at least one past it, in case a lagging node answers with the old count;
  - `trigger-run` takes it before settling the payment, so a busy key is a 503
    before anyone is charged;
  - the cron waits 300ms between runs, so a waiting early send gets its turn.

  Tested on a local Supabase:
  - only one holder at a time, and the holder can extend it;
  - it expires, and only the holder can release it;
  - the nonce floor never goes down;
  - anonymous and signed-in callers are refused;
  - exactly one winner in 8 simultaneous attempts.
- [x] **The money path, end to end.** `scripts/fork-e2e-runs.ts` runs the real
  `execute-due-runs` against a mainnet fork and a local Supabase. All 19
  checks passed:
  - a due run is delivered and recorded at the amount after the fee;
  - a run that reverts after it was signed is recorded as failed;
  - an invocation killed after broadcasting is settled by the next pass;
  - an invocation killed before sending is failed as abandoned, and the
    schedule runs again.

  `scripts/fork-forced-revert.ts` checks the same signing and recovery code
  on its own. `trigger-run` wasn't run end to end, because its x402 payment
  settles through Celo's facilitator, which a fork can't reach. Its revert
  answer uses the same `confirmRun` and the same receipt check.

### 1.3 The request inbox

- [x] **A migration**, `20261024000003_request_inbox.sql`:
  - `payment_request_hides` stores hides. `payment_requests_for` leaves out
    what the caller's session hid, and `hide_payment_request` writes only for
    `auth.uid()`;
  - `dismiss_payment_request` stays for the app that's live now, but it only
    hides for the caller. Drop it once no deployed app calls it;
  - `declined` is allowed, written only by the service role after a signature
    check;
  - `payment_request_live()` is the one definition of a live request, used by
    both the inbox and the limit;
  - `create_payment_request(...)` locks on the payer, counts and inserts, all
    in one call.
- [x] **`request-payment`** inserts through `create_payment_request`. It also
  takes `action: "decline"`:
  - the payer signs EIP-712 data over the request id, the action and an expiry
    no more than a day ahead (`_shared/request-decline.ts`);
  - it's checked with `verifyTypedData`, so smart accounts work too;
  - the GET description documents the typed data.
- [x] **The app hides instead of dismissing**
  (`web/components/PaymentRequests.tsx`), and says the person asking isn't
  told.
- [x] **Tests.** `request-decline.test.ts` has 8 tests. On a local Supabase:
  - one session's hide hides nothing for another;
  - requests older than 30 days don't count toward the limit;
  - a decline frees a slot;
  - of two requests sent together when 9 are live, one is refused.
- **Known limit:** hiding doesn't free a slot. A payer who can't sign, in
  MiniPay, can have their 10 slots held by spam for up to 30 days. The design
  accepts this, and the 429 says what frees a slot.

### 1.4 Say what a budget really is

- [x] The setup screen calls the field "Add to the shared total". It shows the
  current shared total and says every agent limit on that token draws from it.
- [x] `skills/remesso/SKILL.md` no longer says a policy has a total. Plugin
  0.3.3 and wallet 0.3.2 carry the change.
- [ ] `web/app/terms/page.tsx:120` still says a policy has "a total". It's
  legal text, so it waits for your decision.

### Ship Phase 1

In this order: the functions need the migrations, and the web app needs the
functions.

1. `supabase db push`: the executor lease and the request inbox.
2. `supabase functions deploy execute-due-runs trigger-run request-payment ai-assist`.
   `ai-assist` is included because it classifies failures into the new
   categories.
3. Merge to `main`, so Vercel deploys the web app.
4. Publish `remesso-wallet` 0.3.2 by hand:
   `cd packages/remesso-wallet && npm publish`.
5. Run `scripts/check-past-runs.ts --write`, with your OK, to fix the 18
   amounts.

**Done when:** everything under "Done when" in step 1 of the design doc holds,
and no stuck rows are left.

## Phase 2: one manifest, payments that can't be paid twice, every policy findable

### 2.1 One deployment manifest

- [ ] **The manifest.** `deployments/celo-mainnet.json` holds a version, the
  chain id, the contracts (V5, the allowance contract, the ERC-8004 registry),
  the tokens (address, symbol, decimals, currency) and the function URLs.
- [ ] **Generated, not typed.** `scripts/build-deployments.ts` writes it from
  the live `/agent` document and on-chain reads (`directTokenAllowed`,
  `decimals()`), with `--check` for drift.
- [ ] **A drift test.**
  - It compares the constants in `web/lib/config.ts`,
    `supabase/functions/_shared/config.ts`, `mcp/src/server.mjs` and
    `web/lib/mcp/` with the manifest.
  - New code, such as the SDK and the event indexer, reads the manifest
    directly.
  - Old code moves over as it's touched.

### 2.2 The right chain, and separate caches

- [ ] **Check the chain.** At startup, the local MCP wallet checks that
  `eth_chainId` is 42220, and refuses to sign otherwise. Its RPC can be
  overridden with `REMESSO_RPC_URL`, so today nothing guarantees it.
- [ ] **Key the cache by contract.**
  - Key `~/.remesso-agent/config.json` by chain and allowance contract, and
    migrate the current file on first run.
  - That includes `scannedTo`, how far the wallet has scanned for policies
    (`mcp/src/server.mjs:171`).
  - Without this, Phase 5's contract would be scanned from the old contract's
    position, because its ids restart at 1.

### 2.3 Payments that can't be paid twice

- [ ] **An idempotency key.** The local MCP wallet's `pay` takes an
  `idempotency_key`.
  - `~/.remesso-agent/payments.json` (0600) maps each key to its hash and
    outcome.
  - The hash is saved before waiting for the receipt.
  - The same key returns the first result.
- [ ] **No key, no quick repeat.** Without a key, the wallet refuses a payment
  identical to one in the last 10 minutes (same policy, recipient, amount and
  memo), unless the agent passes `allow_repeat`. That catches the usual
  timeout-and-retry.
- [ ] **Reconcile before anything else.** For an uncertain outcome, check the
  saved hash first. Then look for a `Paid` event for this policy and recipient
  (both are indexed) with the same amount and memo in the last 5,000 blocks.
- [ ] **The same rules in the hosted connector's `agent_pay`.** It has no
  database today, by design: sign-in state lives in Privy metadata
  (`web/lib/oauth/sessions.ts`). Decide where its keys live: Privy metadata for
  the last few, or a table behind a server-only key.
- [ ] **Memos are measured in bytes.** Both servers cut the memo at 32
  characters and then encode it as UTF-8 (`mcp/src/server.mjs:306`,
  `web/lib/mcp/hosted.ts:399`). An accented letter or an emoji makes it longer
  than `bytes32`, and `pay` fails with an encoding error. Check the length in
  bytes and refuse with a clear message. Don't cut it: a cut reference no
  longer matches its request.
- [ ] **Tell agents.** Both tool descriptions say never to retry a payment
  without its key.

### 2.4 Every policy findable

- [ ] **Scan every policy.**
  - Replace two windows with a full scan in multicall batches: the newest 200
    on the setup screen (`web/app/agent-wallet/page.tsx:40`) and the newest
    1,000 in the hosted connector (`web/lib/mcp/hosted.ts:193`).
  - Phase 3's event table replaces the connector's scan later.
  - The local wallet already scans everything from where it last stopped.
- [ ] **Index policies.** Add the allowance contract to the Goldsky subgraph
  (`indexer/`), so the screens can list a person's policies by owner.

### Ship Phase 2

1. Merge to `main` for the web app and the hosted connector (Vercel).
2. Rebuild the plugin, and republish `remesso-wallet` by hand.
3. Redeploy the subgraph with the allowance contract.

**Done when:** everything under "Done when" in step 2 of the design doc holds.

## Phase 3: the receiving side

### 3.1 Payment events from the chain

- [ ] **A migration.**
  - `payment_events`, whose primary key is chain id, tx hash and log index.
  - It holds the contract, the kind, the schedule or policy id, from, to,
    token, amount and memo.
  - It also holds the run number, whether it was an early send, the block
    number, the block hash and whether the event is final.
  - `chain_cursors` holds a block number and its hash for each contract.
- [ ] **`record_payment_events(...)`**, an RPC that inserts a batch and moves
  the cursor in one transaction.
- [ ] **`index-events`**, a cron function that runs every minute (pg_cron, like
  the others):
  - It checks the cursor's block hash against the chain, and rolls back on a
    reorg.
  - It reads `RunExecuted`, `RunTriggered` and `ScheduleCreated` from V5. From
    the allowance contract it reads `Paid`, `PolicyCreated` and
    `PolicyRevoked`. It reads up to the depth Phase 0 chose.
  - It adds the token from `getSchedule` or `policy`, then records the batch.
  - The reorg decision is a pure function with tests.
- [ ] **`payment-events`**, a public function: free reads of events by address,
  after a cursor.
- [ ] **The hosted connector stops scanning.** It finds policies through
  `payment-events`, using `PolicyCreated` by agent.

### 3.2 Request tracking

- [ ] **A migration adds:**
  - the request's reference;
  - its state (`pending`, `accepted`, `accepted_with_changes`, `declined`,
    `expired`);
  - a payment state per request (`scheduled`, `paid`, `failed`);
  - the bound schedule id and executor address, or the tx hash;
  - the terms actually signed.
- [ ] **`request-payment` gains `status` and `answer` actions.** `answer` binds
  a schedule only when all of these hold:
  - its sender, destination, token and amount match;
  - it was created after the request, going by its `ScheduleCreated` row;
  - it doesn't already answer another request.
- [ ] **Policy payments bind through the memo.** `index-events` matches a
  `Paid` memo to a live request from that policy's owner to that recipient.
- [ ] **Payment states follow `payment_events`.** Each `RunExecuted` of a bound
  schedule becomes a `paid` entry.
- [ ] **Gross-up.** An amount that comes from the payee, in a request or a pay
  link, is what they receive.
  - `grossFor(net, feeBps)` in `web/lib/` returns the smallest amount whose
    net is at least the request, after V5's rounded-up fee
    (`Math.mulDiv(..., Math.Rounding.Ceil)`). Test it like `format.test.ts`.
  - The form shows both amounts: what they receive and what you send.
  - Pay links already out there now cost their payers 0.25% more.
- [ ] **The app reports what answered a request.** `web/lib/payLink.ts`
  accepts `req=`. The form reports the schedule to `confirm-schedule`, which
  runs the same binding.
- [ ] **Inbox tools.** Add `payment_requests` and `decline_request` to the
  local MCP wallet and the hosted connector. `pay` and `agent_pay` take a
  `request_id` and put it in the memo.

### 3.3 Webhooks

- [ ] **A migration:**
  - `webhook_subscriptions`: address, URL, its secret in Supabase Vault, state,
    verified at.
  - `webhook_nonces`, so a signed request can't be replayed.
  - `webhook_deliveries`: unique on event and subscription, with attempts, the
    next attempt and the last error.
- [ ] **`webhooks`**, a public function to subscribe, rotate, revoke and
  replay.
  - Each call is signed with EIP-712 over the recipient, URL, chain, action,
    nonce and expiry (ERC-1271 for smart accounts).
  - A new endpoint must echo a challenge before it receives any payment.
- [ ] **`deliver-webhooks`**, a cron worker that runs every minute:
  - It sends Standard Webhooks headers.
  - The id stays the same on every retry. The timestamp and signature are new
    on each attempt.
  - It retries with backoff for 24 hours. After that, the delivery is marked
    failed and can be replayed.
- [ ] **`_shared/safe-fetch.ts`**, tested with a table of addresses:
  - HTTPS only, with no redirects.
  - Resolve the name, then refuse private, loopback and link-local addresses,
    in IPv4 and IPv6.
  - Connect to the address that was checked. If the runtime can't pin it, send
    deliveries through an egress proxy that enforces the same rules.
- [ ] **A reusable signature check.** Export the check in `_shared/self.ts` in
  a form the SDK can reuse.

### 3.4 Payee profiles

- [ ] **Document the entry.** The `remesso` entry (step 3d of the design doc)
  goes in `docs/AGENTS.md`, with the reader's rules.
- [ ] **`find_agent` reads the profile** in both servers (`mcp/src/server.mjs`,
  `web/lib/mcp/tools.ts`).
  - It reads the agent's URI (`data:`, `https:` or `ipfs:`) through
    `safe-fetch`, and returns the profile.
  - It parses the raw JSON. agent0-ts would drop the entry's fields.
  - The address still comes only from `getAgentWallet`.
- [ ] **Our own registration.** `docs/erc8004/registration.json`:
  - lists the new services;
  - adds the spec fields it lacks: `registrations` (both ids), `active: true`
    and `x402Support: true`. agent0-ts reads the file today as inactive and
    without x402;
  - gets no payee entry. #9879's wallet is the executor's hot key (3d).

  `scripts/erc8004-v5.ts` writes it to #9867 and #9879: two mainnet
  transactions, about two cents each, with your OK.

### 3.5 Tell agents what changed

- [ ] `/functions/v1/agent`, `/.well-known/agent.json` and
  `skills/remesso/SKILL.md` describe requests, events and webhooks.
  Regenerate the manifests and the plugin.

### Ship Phase 3

1. `supabase db push`, including the pg_cron schedules for `index-events` and
   `deliver-webhooks`.
2. `supabase functions deploy index-events payment-events webhooks
   deliver-webhooks request-payment confirm-schedule agent`.
3. Merge to `main` for the web app and the hosted connector.
4. Republish `remesso-wallet` by hand.
5. Update the ERC-8004 metadata, with your OK.

**Done when:** everything under "Done when" in step 3 of the design doc holds.

## Phase 4: the developer kit

- [ ] **The package name** comes from Phase 0.
- [ ] **`packages/remesso-sdk/`** (TypeScript, viem, ESM) covers:
  - schedules;
  - policy payments with idempotency keys;
  - agent lookup and payee profiles;
  - requests, the event pull and webhook verification;
  - links.

  Networks come from the manifest, with `--check` for drift.
- [ ] **Tests.** Unit tests with recorded receipts and events.
  `scripts/e2e-sdk.ts` runs the whole loop on mainnet with the test wallet and
  small amounts.
- [ ] **`web/app/developers/page.tsx`**, next to `/claude`:
  - a quickstart;
  - what it costs: gas, the fee, and the $1 minimum for a schedule;
  - the warning that the contracts are unaudited.

  Also update `docs/AGENTS.md`, and link the page from the README.
- [ ] **Two example agents:**
  - `examples/freelancer-agent.ts` asks a client for wARS every month, waits
    for the webhook and issues a receipt.
  - `examples/family-allowance-agent.ts` pays cNGN every week and links
    Textile for cashing out.

### Ship Phase 4

1. Publish the SDK by hand.
2. Merge to `main` for the developer page.

**Done when:** everything under "Done when" in step 4 of the design doc holds.

## Phase 5: standing orders

- [ ] **Design review.** Confirm or change the proposed answers in step 5 of
  the design doc, and write the result into the contract's NatSpec.
- [ ] **The contract and its tests.** `contracts/src/RemessoAgentAllowanceV2.sol`
  and `contracts/test/RemessoAgentAllowanceV2.t.sol`. Beyond unit tests, write
  fuzz and invariant tests that:
  - the total is never exceeded;
  - a reference is never paid twice;
  - a revoke stops every order;
  - the caps hold across one-off payments and orders together;
  - an order runs only when due.
- [ ] **Internal review.** Run the solidity-auditor scans we ran on V5 on
  2026-10-16, fix what they find, and run them again.
- [ ] **Independent audit.** Publish the report in `docs/`.
- [ ] **Deploy.** Deploy and verify on Celo mainnet, with your OK. Add the
  contract to the manifest, `index-events`, the subgraph and `CLAUDE.md`.
- [ ] **Clients.** The setup screen, the local MCP wallet and the hosted
  connector create, list and cancel orders, with policy ids keyed by contract
  (2.2).
- [ ] **Running orders.** A pass that runs due orders, holding the executor
  lease from 1.2.
- [ ] **Mainnet test.** Create one policy, then an order on a short interval so
  it runs several times, then cancel it. Then leave a monthly order running.

### Ship Phase 5

1. Deploy the contract, with your OK.
2. Deploy the functions that changed, and merge to `main` for the web app.
3. Republish `remesso-wallet` by hand.

**Done when:** everything under "Done when" in step 5 of the design doc holds.

## Phase 6: builder codes

- [ ] **Parse and build codes.** `_shared/attribution.ts` gains two functions.
  Tests pin both to the attribution SDK's bytes.
  - `parseSuffix(input)` reads Schema 0 from the end: marker, schema, length,
    codes.
  - `suffixFor(codes)` builds a suffix from a list of codes.
- [ ] **Read the integrator's codes.** When `index-events` records a
  `ScheduleCreated`, it reads the input of the transaction that created the
  schedule.
  - It keeps only valid codes: format checked, at most three, ours dropped.
  - It stores them by schedule (executor address and on-chain id).
- [ ] **Carry them on every run.** `execute-due-runs` and `trigger-run` append
  them after our own codes.
- [ ] **Explain it.** The developer page says how an integrator gets the
  credit.

### Ship Phase 6

1. `supabase db push`.
2. `supabase functions deploy index-events execute-due-runs trigger-run`.
3. Merge to `main` for the developer page.

**Done when:** everything under "Done when" in step 6 of the design doc holds.
