# Agent-to-agent: implementation plan

**Status: Phase 0 measuring; Phases 1 to 3 built, tested and deployed; Phase 4 built and tested, not shipped (2026-10-25).** This turns
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

**Built and tested 2026-10-24. Backend deployed 2026-10-25:** steps 1 and 2 of
"Ship Phase 1". The web app ships with the merge.

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
- [x] `skills/remesso/SKILL.md` no longer says a policy has a total. Plugin and
  wallet 0.4.0 carry the change, with Phase 2's (0.3.3 and 0.3.2 were never
  published).
- [ ] `web/app/terms/page.tsx:120` still says a policy has "a total". It's
  legal text, so it waits for your decision.

### Ship Phase 1

In this order: the functions need the migrations, and the web app needs the
functions.

1. `supabase db push`: the executor lease and the request inbox.
   **Done 2026-10-25.**
2. `supabase functions deploy execute-due-runs trigger-run request-payment ai-assist`.
   `ai-assist` is included because it classifies failures into the new
   categories. **Done 2026-10-25.**
   - Both ran from a worktree at `4658b8f`, the end of Phase 2. A plain push
     from the branch would have applied Phase 3's migrations too, and the
     branch's `request-payment` needs Phase 3's columns. Phase 3's deploy
     ships the newer `request-payment`.
   - Checked live afterwards:
     - a pass of `execute-due-runs` returned `recovered: []`;
     - `ai-assist` classified both new reasons by rule;
     - the lease was exclusive, recorded its nonce floor and refused `anon`
       (on a dummy address, deleted after);
     - a request made through `request-payment` was readable by the deployed
       app's `payment_requests_for`, then deleted.
3. Merge to `main`, so Vercel deploys the web app.
4. Publish `remesso-wallet` by hand: `cd packages/remesso-wallet && npm publish`.
   Publish only the newest build, 0.5.0, which carries Phases 2 and 3 as well.
5. Run `scripts/check-past-runs.ts --write`, with your OK, to fix the 18
   amounts.

**Done when:** everything under "Done when" in step 1 of the design doc holds,
and no stuck rows are left.

## Phase 2: one manifest, payments that can't be paid twice, every policy findable

**Built and tested 2026-10-25. Not deployed yet:** see "Ship Phase 2". It ships
after Phase 1.

### 2.1 One deployment manifest

- [x] **The manifest**, `deployments/celo-mainnet.json`, holds:
  - the chain;
  - the contracts: V5 with its executor and the `CURRENT_EXECUTOR` sentinel,
    the allowance contract, and the ERC-8004 registry;
  - the eight tokens: address, decimals, currency, whether V5 takes them, and
    their gas adapter;
  - the public functions and the app.
- [x] **Generated, not typed.** `scripts/build-deployments.ts` reads `/agent`
  and the chain:
  - the code at each contract, and V5's executor;
  - `decimals()` and `directTokenAllowed` for each token;
  - the gas adapters, from Celo's FeeCurrencyDirectory.

  `--check` exits 1 on drift.
- [x] **A drift test**, `scripts/deployments.test.ts`, which runs offline:
  - it holds the backend's and the web app's config (imported) and both MCP
    servers (parsed) to the manifest;
  - a failure names the file and the constant that drifted;
  - 5 of 5 pass, and no copy disagrees with the chain today;
  - not compared yet: `_shared/x402.ts`, `scripts/erc8004-v5.ts` and
    `docs/erc8004/registration.json`. Values that come only from the
    environment have no copy to compare.

### 2.2 The right chain, and separate caches

- [x] **The local wallet checks the chain** before it signs. `eth_chainId`
  must be 42220, or `pay`, `pay_x402` and `wallet` refuse.
- [x] **Its state is keyed by chain and contract.** `config.json` holds one
  section per deployment, `scannedTo` included, and an old file migrates on
  first run.

### 2.3 Payments that can't be paid twice

- [x] **The local wallet:**
  - `pay` takes `idempotency_key` and `allow_repeat`.
  - Each payment is simulated, signed, then written to
    `~/.remesso-agent/payments.json` (0600) with its hash, nonce and signed
    bytes. Only then is it broadcast.
  - The same key returns what became of the first payment: confirmed,
    reverted, or still pending.
  - A record that never left the machine is sent with its own bytes. One whose
    nonce another payment took is paid fresh, once.
  - Without a key, an identical payment in the last 10 minutes is refused
    unless `allow_repeat` is passed. The check reads the local record and the
    chain's `Paid` events.
  - Payments run one at a time, so two in parallel can't take one nonce.
  - No receipt within 45 seconds answers "pending" instead of failing.
- [x] **The hosted connector's `agent_pay`.** Decided: no table and no Privy
  metadata.
  - The key goes to Privy as its idempotency key, scoped to the person's
    wallet. Privy answers a repeat of the same request, for 24 hours, with the
    first result.
  - A retry the simulation refuses first checks for the first attempt's
    `Paid` event.
  - The 10-minute rule without a key reads `Paid` events.
  - It isn't tested end to end, because that needs Privy and real
    transactions.
- [x] **Memos are measured in bytes** in both servers. Over 32 is refused,
  not cut.
- [x] **Agents are told.** Both tool descriptions and the wallet skill say to
  key every payment and never retry without the key.
- [x] **Tested on a fork** with the real server over stdio
  (`scripts/fork-wallet-pay.ts`). All 15 checks passed:
  - the state file migrates;
  - a keyed payment pays once, and its retry reports the first;
  - a reused key for a different payment is refused;
  - a repeat without a key is refused, and `allow_repeat` pays it;
  - a 34-byte memo is refused;
  - a timed-out payment, one that died before broadcast, and one whose nonce
    was taken each pay exactly once;
  - a wallet on another chain refuses to sign.

### 2.4 Every policy findable

- [x] **Every policy is scanned**, newest first, one multicall per 250 ids
  (`web/lib/policies.ts`, tested by `policies.test.ts`). The setup screen and
  the hosted connector both use it. On mainnet it reads all six policies in
  one call.
- [x] **The subgraph is ready to index policies.** `indexer/goldsky.json` adds
  the allowance contract from block 80,467,202, as subgraph `1.1.0`. Nothing
  reads it yet, because the full scan is exact at today's size.

### Ship Phase 2

After Phase 1, because the branch carries both.

1. Merge to `main`, for the web app and the hosted connector (Vercel). This
   also ships Phase 1's web changes, so Phase 1's migrations must be pushed
   first.
2. Publish `remesso-wallet` by hand. If Phase 3 ships with it, publish 0.5.0
   only: 0.3.2 and 0.4.0 were never published.
3. Deploy subgraph `1.1.0` and tag it `prod` (`indexer/README.md`). This can
   wait until something reads policies from it.

**Done when:** everything under "Done when" in step 2 of the design doc holds.

## Phase 3: the receiving side

**Built and tested 2026-10-25. Backend deployed 2026-10-25:** steps 1, 2 and 5
of "Ship Phase 3". The web app and the hosted connector ship with the merge.

### 3.1 Payment events from the chain

- [x] **A migration**, `20261025000001_payment_events.sql`:
  - `payment_events`, keyed by chain, tx hash and log index;
  - each row holds the payer, recipient, agent, token, amount after the fee,
    memo (and as text), run number, early send, block number, block hash, block
    time, `final` and `removed`;
  - `seq` moves on every change, so one cursor sees new events, finality and
    rollbacks;
  - `chain_cursors`, seeded at each contract's deployment block;
  - `record_payment_events` writes a batch and moves the cursor only from where
    it was;
  - `rollback_payment_events` marks events above a block removed, and refuses
    to reach a final one;
  - the cron `remesso-index-events`, every minute.
- [x] **`index-events`:**
  - it checks the cursor's block hash, and on a reorg rolls back to the
    finalized block. A changed block at or below finality halts it for a
    person;
  - it reads windows of 5,000 blocks, at most 10 per contract per pass. The
    window's last block is checked before and after the read;
  - it adds the token, the policy's owner and block times. A missing fact
    refuses the batch rather than recording a blank;
  - an event is final at or below the RPC's `finalized` block. Over the first
    12.5 hours of Phase 0 that ran a median 23 minutes behind the head, 31 at
    most, and no block was ever replaced;
  - the pure parts are `_shared/events.ts`, tested by `events.test.ts` (11).
- [x] **`payment-events`**, public: events by address and role, after a `seq`
  cursor. Amounts travel as exact strings.
- [x] **The hosted connector stops scanning.** It finds policies through
  `payment-events` (`PolicyCreated` by agent). It still scans the ids newer
  than the newest one reported, because the indexer lags by up to a minute.
- [x] **The manifest moves to the backend.** `_shared/deployments.ts` reads
  `_shared/celo-mainnet.json`, a second copy that `build-deployments.ts` writes
  and `--check`s, because a deploy bundles only `supabase/functions`.

### 3.2 Request tracking

- [x] **A migration**, `20261025000002_request_tracking.sql`. Each request
  gains:
  - its `reference`, the id without dashes;
  - the states `accepted` and `accepted_with_changes`;
  - its answer: a V5 schedule or a policy payment's transaction;
  - the signed terms.

  A schedule or a payment answers one request at most.
- [x] **The binding rules**, in `_shared/request-binding.ts` (7 tests):
  - evidence binds only if it is from the wallet asked, pays the address that
    asked, and was made after the request;
  - the terms decide only between accepted and accepted with changes;
  - amounts are compared with what the recipient receives.
- [x] **`request-payment` gains `list`, `status` and `answer`.** `decline`
  also takes an agent with a live policy from the payer. `status` gives the
  request's state, its payer, and each payment's transaction.
- [x] **Policy payments bind through the memo**, after every indexer pass.
- [x] **Payment states follow `payment_events`:** `paid` with transactions,
  `scheduled`, or `failed` with the executor's own reason.
- [x] **Gross-up.**
  - `web/lib/fee.ts` (5 tests): `grossFor` is the smallest gross whose net
    covers the request. 5 USDT asked is 5.012532 sent.
  - The form shows what they receive and what you send, and signs the gross.
    Its fee line now rounds up, as V5 does.
- [x] **The app reports what answered a request.** `payLink.ts` takes `req=`,
  and `confirm-schedule` binds the new schedule to it. The binding's outcome
  comes back in the answer, never as an error.
- [x] **Inbox tools.**
  - The plugin wallet gets `payment_requests` and `decline_request`. Its
    `pay` gains `request_id`: the reference goes in the memo, the request is
    the default idempotency key, and a request sent to another wallet is
    refused.
  - The hosted connector gets `agent_payment_requests` and `request_id` on
    `agent_pay`.
  - **Not built: a hosted decline.** The Privy policy allows only `pay()`, so
    the hosted agent can't sign typed data.

### 3.3 Webhooks

- [x] **A migration**, `20261025000003_webhooks.sql`:
  - subscriptions, with their secrets in Vault;
  - nonces;
  - deliveries, unique per event, block hash and message type;
  - service-role RPCs, and the cron `remesso-deliver-webhooks`.
- [x] **`webhooks`**, public:
  - subscribe, rotate, revoke and replay, each signed by the address (EIP-712,
    with ERC-1271 for smart accounts);
  - the order of checks is shape, unspent nonce, signature, then the nonce is
    spent atomically;
  - an endpoint must echo a challenge before it receives anything;
  - at most 5 live subscriptions per address.
- [x] **`deliver-webhooks`:**
  - it sends `payment.received`, `payment.finalized` and `payment.removed`,
    the last only to receivers that heard about the event;
  - deliveries use Standard Webhooks headers, and the id stays the same across
    retries;
  - it backs off at 1m, 5m, 30m, 2h and 6h, then every 6h. After 24 hours a
    delivery fails and can be replayed;
  - after a rotation, it signs with both secrets for 24 hours.
- [x] **`_shared/safe-fetch.ts`:**
  - HTTPS only, no redirects;
  - every resolved address must be public: IPv4 and IPv6, including mapped,
    NAT64, Teredo and 6to4 forms;
  - it connects to the address it checked, writing HTTP/1.1 over
    `Deno.connect` and `Deno.startTls`. That's verified in Deno and inside the
    Supabase Edge Runtime, but not yet on the hosted platform. If `startTls` is
    missing there, it falls back to `fetch` after the check, which leaves a
    DNS-rebinding window an egress proxy would close.
- [x] **A reusable signature check.** `_shared/standard-webhooks.ts` signs and
  verifies, tested against `svix` and `standardwebhooks`. `self.ts` uses it.
- [x] **Tests:**
  - standard-webhooks 8, webhook-actions 5, safe-fetch 9, plan 7;
  - `scripts/webhooks-local-e2e.ts` passes 24 of 24 on a local Supabase.

### 3.4 Payee profiles

- [x] **`docs/AGENTS.md`** gains "Telling payers what you accept": the
  `remesso` entry, the reader's rules and an example.
- [x] **`find_agent` reads the profile** in both servers. It parses `data:`,
  `https:` and `ipfs:` URIs through a Node safe-fetch that connects to the
  checked address (`web/lib/safe-fetch.ts`, and a copy in `mcp/src/`). The
  address still comes only from `getAgentWallet`. On mainnet, #9879 reads as
  "no remesso entry", as intended.
- [x] **Our registration** (`docs/erc8004/registration.json`) gains
  `registrations` for both ids, `active`, `x402Support`, and the
  payment-events and webhooks services. It has no payee entry. Writing it
  on-chain is a ship step.

### 3.5 Tell agents what changed

- [x] `/functions/v1/agent` describes knowing you were paid, the request
  actions, and the new services. `/.well-known/agent.json` lists the new
  endpoints.
- [x] `skills/remesso/SKILL.md` and the wallet skill cover requests, events,
  webhooks and the payee entry. The plugin and wallet are 0.5.0.
- [x] Regenerate the skill manifests after deploying: they're read from the
  live `/agent`. Checked 2026-10-25: both were already current.

### Tested end to end

- **`scripts/receiving-e2e.ts`**, 19 checks. It runs the real `index-events`,
  `payment-events` and `request-payment` against a local Supabase and
  read-only mainnet:
  - the backfill records V5 schedule #1's 0.9975 USA₮ run exactly;
  - a request bound to it reads paid;
  - an older or reused schedule is refused;
  - a memo binds;
  - a staged reorg marks a not-final event removed.
- **`scripts/fork-agent-to-agent.ts`**, 7 checks. On a mainnet fork, with the
  real wallet:
  - a request reaches the agent's inbox;
  - the agent pays it, and declines another under its human's policy;
  - the indexer binds the payment by its memo;
  - the requester sees it paid;
  - a retry pays nothing.

### Ship Phase 3

After Phases 1 and 2.

1. `supabase db push`, which includes the `index-events` and
   `deliver-webhooks` crons. Then right away,
   `supabase functions deploy index-events payment-events webhooks deliver-webhooks request-payment confirm-schedule agent`.
   The crons call functions that don't exist until then. **Done 2026-10-25.**
2. The first passes backfill from the deployment blocks. **Done 2026-10-25, in
   15 minutes:** 50,000 blocks per contract per pass, then 19 blocks behind the
   head. Checked live afterwards:
   - every log both contracts had emitted, up to block 81,030,401, matched a
     recorded event: 1 schedule and 1 run on V5, and 6 policies, 7 payments
     and 2 revocations on the allowance contract;
   - schedule #1's run reads 997,500 units, the net. Its `runs` row says the
     gross, one of the 18 amounts step 5 of "Ship Phase 1" fixes;
   - `payment-events`, `request-payment`'s `status` and `list`, `webhooks`,
     `deliver-webhooks`, `confirm-schedule` and `/agent` answered as built. A
     test request was deleted after;
   - still open: whether the hosted platform has `Deno.startTls`. Nothing
     reports which transport ran.
3. Merge to `main`, for the web app and the hosted connector.
4. Publish `remesso-wallet` 0.5.0 by hand. It carries Phases 1 and 2 too.
5. Regenerate the skill manifests from the live `/agent`. **Nothing to do on
   2026-10-25:** `--check` found both current.
6. Update the ERC-8004 metadata (`scripts/erc8004-v5.ts --send`): two mainnet
   transactions, about two cents each, with your OK.

**Done when:** everything under "Done when" in step 3 of the design doc holds.

## Phase 4: the developer kit

**Built and tested 2026-10-25, on `feat/developer-kit`. Not shipped yet:** see
"Ship Phase 4".

- [x] **The package name:** `remesso-sdk`, from Phase 0.
- [x] **`packages/remesso-sdk/`** (TypeScript, viem, ESM, Node 20+) covers:
  - schedules: create (with `amount` or `receive`, optionally answering a
    request), read, status, list, cancel, pause and trigger grants;
  - agent payments through a policy, at most once per idempotency key, and
    policies: find, read, create, revoke, allowlist;
  - requests: create, status, the inbox, answer, a signed decline, paying one
    by its reference, and waiting until it is paid;
  - payment events, pulled or watched;
  - webhooks: signed subscribe, rotate, revoke and replay, a fetch-style
    handler, and verification;
  - agent lookup with the payee profile, and pay links.

  `remesso-sdk/node` adds a payment store on disk, the safe fetch for remote
  registration files, and an adapter for `http.createServer`.
- [x] **Nothing about the deployment is typed by hand.** `scripts/build-sdk.ts`
  writes the deployment from the manifest, the ABIs from `indexer/abis/`, and
  exact copies of the webhook, decline, fee, payee-profile and safe-fetch code.
  `--check` fails on drift.
- [x] **The executor's limits are published, and refused before signing.**
  - `/agent` gains `limits.perRun`, from a new `runLimits` that
    `config.test.ts` pins to `runAmountProblem`.
  - The manifest carries each token's bounds, V5's `feeBps`, and the
    `payment-events` and `webhooks` URLs.
  - The SDK refuses a schedule outside the bounds, since one would be valid
    on-chain and never run.
  - `examples/create-schedule.ts` and the skill now say a transfer is at least
    a dollar's worth.
- [x] **`request-payment`'s link carries `req=`.** The inbox already added it.
  Without it, a payer who paid from a shared link left the request
  unanswered.
- [x] **Tests:**
  - 17 unit tests, with recorded mainnet receipts and a recorded
    payment-events page. Every signed request is checked with the backend's
    own files.
  - `scripts/fork-sdk.ts`, 23 checks on a mainnet fork:
    - limits refused before signing;
    - exact approvals added on top of existing ones;
    - the gross-up;
    - a payment retried with its key paying once, including one whose
      broadcast was lost;
    - revocation, and the wrong chain.
  - The packed tarball, installed in an empty project: it type-checks under
    `NodeNext` and `bundler`, and its live reads work.
  - `scripts/e2e-sdk.ts`, the whole loop on mainnet with the test wallet, is a
    dry run unless `--send`.
- [x] **The first mainnet run (2026-10-25) paid correctly.**
  - **What worked:**
    - a webhook subscribed through a quick tunnel;
    - a request whose link carried `req=`;
    - a schedule that sent 1.002507 USDT so 1 USDT arrived;
    - its signed `payment.received` 444 seconds after the run started;
    - a policy created with gas paid in USDT, 0.0055 USDT for two
      transactions, which a fork can't run;
    - an agent payment retried with its key and paid once (one `Paid` event
      on-chain), and its webhook.
  - **Five checks failed, every one on a stale read straight after a write**
    (see CLAUDE.md, "Reads lag"):
    - the request's answer got "hasn't been seen on-chain yet", and so read
      unpaid. Answered again a few minutes later, it read accepted and paid;
    - the receiver's revoke read its new policy as empty, so it found no
      token to pay gas with;
    - two of the script's checks read balances from a node a block behind.
  - **Fixed:**
    - the SDK retries an answer while the backend says it's unseen, and
      waits for something it just created;
    - `scheduleEvidence` asks the chain a few times. This also fixes the
      app's `req=` flow, which binds at the same moment;
    - the script counts events and nonces.
  - Covered by two new unit tests and the fork test. A clean re-run needs
    about 0.8 USDT more in the test wallet.
- [x] **`web/app/developers/page.tsx`**, next to `/claude`:
  - a six-step quickstart, from `npm install` to a payment and its webhook;
  - getting paid by request, and agent payments;
  - what it costs, and the warning that the contracts are unaudited.

  The page's snippets are the README's, byte for byte, and type-check against
  the SDK. `docs/AGENTS.md` gains "Using the SDK", the README and the agent
  card link the page, and the skill mentions the SDK.
- [x] **Two example agents**, each the whole loop:
  - `examples/freelancer-agent.ts` asks a client for wARS every month, serves
    the webhook and writes a receipt per payment, marked final when it is.
  - `examples/family-allowance-agent.ts`: the child asks for cNGN every week
    and is told of each payment with Textile's cash-out link. The parent's
    agent lists the request and answers it, after a yes on the terminal.

### Ship Phase 4

1. `supabase functions deploy agent request-payment`, with your OK. **Done
   2026-10-25:** `/agent` publishes the limits and the developer links, and
   the request link carries `req=`.
2. `build-deployments.ts --check` against what is live. **Done 2026-10-25:**
   both copies match the deployment, and the skill manifests and the SDK's
   generated files are current.
3. Run `scripts/e2e-sdk.ts --send`. **First run 2026-10-25:** it paid
   correctly, and five checks failed on stale reads (above), now fixed.
   Then:
   - `supabase functions deploy request-payment confirm-schedule`, with your
     OK, for the binding retry;
   - fund the test wallet and run it again.
4. Publish `remesso-sdk` 0.1.0 by hand: `cd packages/remesso-sdk && npm publish`.
5. Merge to `main`, for `/developers`, the agent card and the docs.
6. Publish `remesso-wallet` 0.5.0 if it isn't out yet: it carries the skill
   change too.
7. Follow `/developers` alone from an empty folder, and time it.

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
