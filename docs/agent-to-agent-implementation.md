# Agent-to-agent: implementation plan

**Status: Phase 0 under way (started 2026-10-24).** This turns
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
- [ ] **Payee profile convention.** Read the ERC-8004 registration format and
  Celo's agent docs. Write the result into the design doc: follow an existing
  convention, or define a `remesso` entry.
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

### 1.1 Runs record what happened on-chain

- [ ] **Check every receipt.**
  - Split `executeRun` and `runNow` in `supabase/functions/_shared/celo.ts`
    (lines 343 and 129) into a send, which returns the hash, and a confirm.
  - The confirm requires `status === "success"` and a `RunExecuted` log from
    this contract for this schedule id.
  - A new pure helper, `_shared/receipt.ts`, decodes that log.
    `receipt.test.ts` pins it to a real V5 receipt and to a reverted one.
- [ ] **Record runs from the receipt in `execute-due-runs`.**
  - Write `tx_hash` on the run row as soon as the transaction is sent, before
    waiting.
  - Record `amount_out` from `RunExecuted.amountOut`, which is after the fee,
    instead of from the quote (`index.ts:242` and `:335`).
  - Mark a run failed when its receipt reverted.
- [ ] **`trigger-run` stops reporting reverted runs as sent.** It treats a
  reverted receipt like a thrown error: the existing 409, "you were charged but
  the run did not go through". It never answers `ok: true` for one
  (`index.ts:212`).
- [ ] **A new failure reason.** Add it to `_shared/failures.ts` and its
  sentence to `web/lib/failures.ts`. `failures.test.ts` pins the exact strings,
  so extend it too.
- [ ] **Check past runs.** A script, run read-only first:
  - It confirms that every `delivered` run's receipt succeeded.
  - It rewrites Direct runs' `amount_out` to the net amount from their
    `RunExecuted` event.
  - The history screen already shows the net amount when it reads the subgraph
    (`web/lib/history.ts:46`), so today the two sources disagree.

### 1.2 Stuck runs and nonces

- [ ] **Recover stuck runs.** At the start of each `execute-due-runs` pass,
  check `pending` and `swapping` rows older than 10 minutes:
  - A row with a `tx_hash` is settled from its receipt.
  - A row without one is checked for a `RunExecuted` of its schedule since the
    row was written. forno answers `getLogs` over 5,000 blocks, about 83
    minutes. For an older row, compare the schedule's on-chain run count with
    its delivered rows.
  - The row is then settled, or failed as "abandoned before sending".
  - The decision is a pure function with tests, the way `preflight.ts` works.
  - `redeeming` rows stay with `reconcile-redemptions`.
- [ ] **One sender at a time for the executor key.**
  - A lease row in Postgres, taken and released through RPCs, with an expiry.
  - Both `execute-due-runs` and `trigger-run` hold it from fetching the nonce
    to broadcasting.
  - A session advisory lock won't work here, because supabase-js calls don't
    keep one database session between requests.

### 1.3 The request inbox

- [ ] **A migration:**
  - `payment_request_hides` (request id, session user).
    `payment_requests_for` leaves out what the caller's session hid.
    `hide_payment_request` replaces `dismiss_payment_request` and writes only
    for `auth.uid()`.
  - `declined` becomes an allowed status. Only the service role writes it,
    after checking a signature.
  - One definition of a live request, pending and under 30 days old, used by
    both the inbox and the limit.
  - `create_payment_request(...)` takes a transaction lock on the payer
    (`pg_advisory_xact_lock`), counts live requests and inserts, all in one
    call.
- [ ] **`request-payment` changes.**
  - It inserts through `create_payment_request`.
  - A new decline action checks an EIP-712 signature from the payer (ERC-1271
    for smart accounts) over the request id, the action and an expiry.
- [ ] **The app hides instead of dismissing**
  (`web/components/PaymentRequests.tsx`).
- [ ] **Tests.** Deno tests for the validation and the signed message. Run the
  migration on a local Supabase before `supabase db push`.

### 1.4 Say what a budget really is

- [ ] The setup screen (`web/app/agent-wallet/page.tsx:226`) shows "Most in
  total" as what it is. It's one approval shared by every policy on that token,
  so also show how much other policies already count on.
- [ ] `skills/remesso/SKILL.md:30` says a policy has "a total". Correct it,
  then rebuild the plugin (`scripts/build-plugin.sh`).

### Ship Phase 1

1. `supabase db push` (requests, the executor lease).
2. `supabase functions deploy execute-due-runs trigger-run request-payment`.
3. Merge to `main` for the web app (Vercel).
4. Republish `remesso-wallet` by hand, since it ships the skill.
5. Run the past-runs script: a dry run first, then the rewrite with your OK.

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

- [ ] **Document the entry.** The `remesso` entry from Phase 0 goes in
  `docs/AGENTS.md`.
- [ ] **`find_agent` reads the profile** in both servers (`mcp/src/server.mjs`,
  `web/lib/mcp/tools.ts`).
  - It reads the agent's URI (`data:`, `https:` or `ipfs:`) through
    `safe-fetch`, and returns the profile.
  - The address still comes only from `getAgentWallet`.
- [ ] **Our own registration.** `docs/erc8004/registration.json` lists the new
  services. `scripts/erc8004-v5.ts` writes it to #9867 and #9879: two mainnet
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
