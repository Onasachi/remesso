# CLAUDE.md

Recurring stablecoin remittances on Celo, settling in cNGN. A sender authorises
once on-chain; a backend hot key can then trigger runs, but only inside the
envelope the sender signed.

Read `README.md` for the why. This file is what you need to not break it.

## Commands

```bash
# contracts — 96 tests across V1–V5 and RemessoAgentAllowance, all must pass
cd contracts && forge test

# Self webhook signatures — verifies our Svix check against the svix library
deno test --allow-env supabase/functions/_shared/self.test.ts

# failure classifier — pins the rules to the strings the executor writes
deno test --allow-env supabase/functions/_shared/failures.test.ts

# run receipts — a run counts only from a successful receipt with its RunExecuted
deno test supabase/functions/_shared/receipt.test.ts

# stale-run recovery — what a pass does with a run a dead invocation left in flight
deno test supabase/functions/_shared/recovery.test.ts

# signed declines — the EIP-712 message request-payment checks before a decline
deno test --allow-env supabase/functions/_shared/request-decline.test.ts

# the money path on a mainnet fork. Both need `anvil --fork-url https://forno.celo.org
# --port 8546`; the e2e one also needs a local Supabase (`supabase start -x studio,
# imgproxy,realtime,storage-api,logflare,vector,edge-runtime,mailpit,supavisor,postgres-meta`).
# They sign with the real executor key and refuse anything but anvil and localhost.
deno run --allow-env --allow-read --allow-write --allow-net scripts/fork-forced-revert.ts
deno run --allow-all scripts/fork-e2e-runs.ts

# cNGN crypto — verifies our AES/Ed25519 against the docs' reference impls
deno test --allow-env --allow-read --allow-write --allow-run --allow-net --allow-sys \
  supabase/functions/_shared/cngn.test.ts

# x402 builder-code — pins our 402 declaration to @x402/extensions' own output
deno test --allow-env --allow-read --allow-net supabase/functions/_shared/x402.test.ts

# pre-flight agent — what it tells a sender about an upcoming payment, and how urgently
deno test supabase/functions/_shared/preflight.test.ts

# mirror status — a pause is a pause, not "completed"
deno test supabase/functions/_shared/schedule-status.test.ts

# history merge — how the chain is allowed ahead of the `runs` table in the UI
deno test --unstable-sloppy-imports web/lib/history.test.ts

# review-screen amounts — small fees must not round to 0.00
deno test --allow-env --unstable-sloppy-imports web/lib/format.test.ts

# approval size — one approval covers every transfer the contract will run
deno test --allow-env --unstable-sloppy-imports web/lib/allowance.test.ts

# phone numbers — E.164 normalisation and masking for MiniPay recipients
(cd web && deno test --unstable-sloppy-imports lib/phone.test.ts)   # from web/: needs its node_modules

# policy scan — every agent policy, newest first, so none drops off a Stop list
(cd web && deno test --unstable-sloppy-imports lib/policies.test.ts)   # from web/: needs its node_modules

# skill manifests — regenerate from the live 402, or --check for drift
deno run --allow-net --allow-write --allow-read scripts/build-skill-manifest.ts

# deployment manifest — regenerate from /agent and the chain, or --check for drift;
# then hold every hand-typed copy of the deployment to it (offline)
deno run --allow-net --allow-read --allow-write --allow-env scripts/build-deployments.ts
deno test --allow-env --allow-read --unstable-sloppy-imports scripts/deployments.test.ts

# the plugin wallet on a mainnet fork: a payment retried with its key pays once, a
# wallet on the wrong chain refuses to sign. Needs `anvil --fork-url https://forno.celo.org
# --port 8546` and `anvil --chain-id 1337 --port 8547`.
deno run --allow-all scripts/fork-wallet-pay.ts

# the receiving side (Phase 3): payment events, request binding, webhooks
deno test supabase/functions/_shared/events.test.ts              # cursor, reorg, logs into rows
deno test --allow-env supabase/functions/_shared/request-binding.test.ts   # what may answer a request
deno test --allow-env supabase/functions/_shared/standard-webhooks.test.ts # sign/verify vs svix
deno test --allow-env supabase/functions/_shared/webhook-actions.test.ts
deno test --allow-env supabase/functions/_shared/safe-fetch.test.ts        # SAFE_FETCH_NETWORK=1 + --allow-net: live pinned test
deno test supabase/functions/deliver-webhooks/plan.test.ts
(cd web && deno test --allow-env --allow-net --allow-read --unstable-sloppy-imports lib/fee.test.ts lib/payee-profile.test.ts lib/safe-fetch.test.ts)
# end to end against a local Supabase (and, for the last, the fork on :8546):
deno run --allow-all scripts/receiving-e2e.ts       # real index-events/payment-events/request-payment, read-only mainnet
deno run --allow-all scripts/webhooks-local-e2e.ts  # subscribe, deliver, retry, rotate, replay
deno run --allow-all scripts/fork-agent-to-agent.ts # inbox, pay with request_id, bind by memo, paid

# Claude plugin and the npm package — plugin/ and packages/remesso-wallet/ are
# assembled from skills/ and mcp/; edit those, then rebuild (after
# `cd mcp && npm run build` if the server changed). --check fails on drift.
# Publishing remesso-wallet to npm is done by hand: cd packages/remesso-wallet && npm publish
scripts/build-plugin.sh --check
claude plugin validate plugin --strict

# is .env complete and coherent? proves the SSH key by round-tripping it
deno run --allow-env --allow-read --allow-net scripts/check-env.ts

deno check supabase/functions/*/index.ts
cd web && npx tsc --noEmit && npx next build && npm start   # localhost:3000

# deploy
supabase functions deploy execute-due-runs cngn-webhook reconcile-redemptions \
  cngn-proxy balance-poller self-verify self-webhook confirm-schedule
supabase secrets set --env-file .env.functions
```

`.env.functions` — not `.env`. Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`
and `SUPABASE_SERVICE_ROLE_KEY` itself and rejects them as reserved, failing the
whole command. Regenerate it with:

```bash
grep -vE '^(SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY)|TESTING_|YOUR_AGENT_VAULT_)' .env \
  | grep -E '^[A-Z0-9_]+=' > .env.functions
```

`YOUR_AGENT_VAULT_API_KEY` is excluded too. It is the Agent Vault (Self agent
card payments) key for the Claude Code MCP server in `~/.claude.json`, and no
Edge Function uses it.

`TESTING_*` is excluded deliberately. Those hold a funded wallet key used only by
`scripts/e2e-agent-test.ts`, which runs locally — no Edge Function reads them,
and shipping a spendable key into a deployed environment for no reason is how
blast radius grows quietly.

## Deployed state — Celo mainnet (42220)

| | |
|---|---|
| `RemessoExecutorV5` | `0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8` — **deployed 2026-10-16** (tx `0x95a9ddcc…6a07`, block 80,268,721), verified. V4 plus the fixes from the 2026-10-16 solidity-auditor scans: an early send moves a run instead of adding one, `CURRENT_EXECUTOR` (address(1)) as trigger, no third-party trigger on the swap rails, commission rounded up, floor checked on the net amount. Allowlists copied from V4 by `contracts/script/setup-v5.sh` and checked equal on-chain. **No person has audited it.** |
| `RemessoAgentAllowance` | `0xA6351fAeEb097698289586C4D6188530300DB209` — **deployed 2026-10-19** (tx `0x0b80f355…dc1e`, block 80,467,202), verified. Spending limits a person grants their AI agent's key: one token, a cap per payment and per day, an expiry, an optional recipient allowlist. No owner, no admin. Used by the Claude plugin's MCP wallet (`mcp/`) and set up at `/agent-wallet`. **No person has audited it.** |
| `RemessoExecutorV4` | `0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009` — live 2026-09-22 to the V5 cutover. Its schedules stay on-chain and stop running once the executor is pointed at V5. Its early send adds a payment on an uncapped schedule: do not grant triggers on it. |
| `RemessoExecutorV3` | `0xd2e68acd875fb1b3a98dc0d72659910b05e7e08f` — superseded 2026-09-22. Schedules created against it still exist on-chain and can never run again: the executor is scoped to one contract. |
| `RemessoExecutorV2` | `0x218414aD37206fd4cFD6C47947574708DB0e95D2` — superseded 2026-09-17 |
| `RemessoExecutor` V1 | `0xC7eF75fC6283aB3b810fa4dE270F074C47761189` — retired 2026-09-15, schedule #1 cancelled, allowance revoked. Has the defects listed below; do not point anything at it. |
| owner (V5) | `0xc998739EEF304d39771901c0d379215a7C1AA15e` — cold, deploy and allowlist only |
| executor (V5, hot) | `0xA351d65c15b8a342B6ECbC7f2B9eFE62B17cdb21` — cron key, gas only |
| treasury (V5) | `0x2dA4cd408bd8051385B5Dd113F8beD56E4F9F134` — commission |
| owner (V1–V4) | `0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2` — cold. Still owns V1–V4, ERC-8004 #9867, Self Agent ID 191, and is `X402_PAY_TO`. |
| executor (V1–V4) | `0x3c754AD31e802D5fA65487f460dED65Aba749Cd1` — still the executor on V1–V4, which have no live schedules. |
| **retired** | `0xe1a0F916e859624D4edbadA23E4382D327EAf626` — **private key was exposed in a session log. Do not reuse.** |
| Supabase | `engaboljiqudghvzmebq` |
| Goldsky subgraph | `remesso-celo-celo/1.0.1`, tag `prod`, project `project_cmub9zi745rtc01ts1xx66zy6` — indexes V5 from block 80,268,721 (deployed 2026-10-16). The app reads `…/subgraphs/remesso-celo-celo/prod/gn`. The older `remesso-celo/1.0.0` indexed V3 only. Instant subgraph from the ABI, `indexer/`. |

Keys: the V5 owner key is `DEPLOYER_PRIVATE_KEY` in `contracts/.env` and the V5
executor key is `EXECUTOR_PRIVATE_KEY` in the root `.env` (both git-ignored).
`~/.remesso/keys/{owner,executor}.json` hold the V1–V4 owner and executor;
`~/.ssh/cngn_api_key` the cNGN key.
The contract is immutable: a fix means redeploying and every sender
re-authorising. Owner can `setExecutor`, `setPoolFee`, `pause`, `rescueToken` —
nothing else, and it cannot redirect a payment.

## Traps

These each cost real time to find. None are visible from the code alone.

1. **cNGN is 6dp.** Mento's unrelated `NGNm` is 18dp. Confusing them is 10¹².

2. **cNGN seals responses.** Requests are AES-256-CBC `{content, iv}`; every
   successful response is `{status, message, data}` where `data` is a base64
   libsodium `crypto_box` sealed to our Ed25519 key. Reading a field off it
   without opening it first yields `undefined` silently. `cngn.test.ts` proves
   both directions against the docs' own reference implementations.

3. **cNGN webhooks fire exactly once**, 10s timeout, no retry. A 500 loses the
   event permanently. `GET /transactions` is the settlement of record;
   `reconcile-redemptions` is what makes the webhook optional rather than
   load-bearing. Never make correctness depend on a delivery arriving.
   Configured 2026-09-14 (live endpoint, `redemption.completed` and
   `transaction.failed`). The signing secret is **generated by cNGN** in the
   dashboard — it is not a value you choose.

4. **The endpoint is `POST /account/verify`.** `/verifyAccountDetails` does not
   exist. `/withdraw/verify/{ref}` takes withdrawal refs only — a redemption's
   `RD-` ref returns "Transaction not found".

5. **`verify_jwt = false` only on `cngn-webhook` and `self-webhook`**
   (`supabase/config.toml`). cNGN sends an HMAC and Self a Svix signature, not a
   Supabase JWT; at the default every delivery is refused at the edge before
   our code runs. Do not "fix" this.

6. **cNGN rate limit is 20 req/60s per key**, and breaching it blocks the key
   for another 60s. The limiter in `cngn.ts` is **per-isolate** — each Edge
   Function invocation gets its own, so it cannot see a concurrent function's
   requests. Budgets are kept safe by keeping per-invocation counts small, not
   by coordination. Moving it to Postgres is the fix if throughput grows.

7. **Never `source` the `.env`.** Values contain spaces, `\n` escapes and URLs;
   sourcing it in zsh echoes secrets back as "command not found". Parse it
   (`grep '^KEY=' .env | cut -d= -f2-`).

8. **`re.sub` interprets backslashes in the replacement string.** Writing the
   SSH key back with `\n` escapes turns them into real newlines. Use a lambda.

## Project setup that is not in code

- **Anonymous sign-in must be enabled** in the Supabase dashboard (Authentication
  -> Sign In / Providers). Off by default. `ensureSender()` depends on it, so
  without it the entire frontend is inert: `422 anonymous_provider_disabled`.
- **`CNGN_EGRESS_PROXY_URL`** points at a tinyproxy box whose IP is whitelisted
  with cNGN. Rebuild it with `infra/setup-cngn-proxy.sh`, then whitelist the new
  address — cNGN takes static IPs only, no CIDR.

## Two rails

`Direct` forwards the funding asset itself — sender funds USDT, USDC, USDm (formerly cUSD) or USA₮ and
the recipient receives that same asset. No swap, no floor, no pool. USA₮
(`0xD2ab…F771`, 6dp) was allowed on V4 on 2026-10-11 (`0xf3292694…9e5a`). This exists
because **MiniPay displays only USDm, USDC and USDT**: a recipient paid
in cNGN sees nothing and cannot add a custom token.

The swap rails (`Wallet`, `BankRedemption`) still convert to cNGN and remain the
path for bank payouts, where no wallet is involved.

**Both are off as of 2026-09-20, and off in the backend too as of 2026-09-28.**
Naira is what carries the open regulatory question and the unverified cNGN
account; without it the product needs no payout partner and no
money-transmission answer.

Two flags, because hiding a form is not refusing a payment:

| | |
|---|---|
| `NEXT_PUBLIC_ENABLE_CNGN_RAILS` | frontend. A sender can only authorise a stablecoin payout. |
| `ENABLE_CNGN_RAILS` | backend (`_shared/rails.ts`). `execute-due-runs` skips a due cNGN schedule before it writes a `runs` row, and `trigger-run` answers 403 before quoting a price. |

Both default to off, so a deploy that forgets one fails toward the rail that
needs no payout partner. **The contract is not involved and cannot be** — it is
immutable, has all three rails compiled in, and `pause()` is its only lever,
which stops every rail at once. The two callers are the only things that can
decline. Set both flags to `"1"` (plus `NEXT_PUBLIC_CNGN_REDEMPTION_ADDRESS`
for bank payouts) to bring naira back.

**Naira cash-out without a naira rail — linked 2026-10-14.** Textile's app turns
USDT on Celo into naira in a Nigerian bank: swap to cNGN, then "Withdraw NGN",
paid out by Noblocks (₦0.9996/cNGN when checked). `web/lib/textile.ts` builds
`app.textilecredit.com/s/swap?sell=USDT&buy=cNGN&chainId=42220`. The send form
and the schedule page link it for USDT payouts, outside MiniPay only. The
recipient does it on Textile with their own wallet. Like Ripio, it is a link,
so Remesso instructs no naira payout and both flags stay off. Only USDT:
USDC, USDm and USA₮ show "No supported swap pairs" there. Without `chainId`
the app opens on BNB Smart Chain. On the web home screen cNGN always has a tile, with
"Get cNGN" (Textile swap USDT→cNGN) and "Withdraw to bank"
(`app.textilecredit.com/s/sell?chainId=42220`, Textile's Withdraw NGN).

**Recipients cash out to their own bank, never to a sender's choice of
account (Textile, 2026-10-15, `docs/textile-ramp-answers.md`).** Busha and
Noblocks require the bank account to belong to the customer selling, Celo has
no Ramp API provider (Noblocks there is an iframe in Textile's app), and USDT
must be swapped to cNGN first. So a sender paying naira straight into someone
else's bank account is not available through Textile, and it is not on the
roadmap. Keep the link-out: the recipient receives tokens and withdraws them
themselves.

**cNGN on the Direct rail (2026-10-14).** cNGN is in both `DIRECT_TOKENS`
lists: the recipient receives cNGN, with no swap, no redemption and no bank.
The rail flags gate payout *types*, not tokens, so they do not stop it and
stay off. The backend cap counts 1,300 cNGN per dollar (rounded down). V4's
allowlist took it on 2026-10-14 (`0x68ad32f6…3296`, cold owner, tagged). The
first `directTokenAllowed` read right after still said false: forno lag, true
at the tx block. Redeployed `execute-due-runs`, `sync-schedules`,
`trigger-run`, `preflight` and `agent`; `/agent` lists cNGN among assets. First
cNGN runs, 2026-10-14: schedule #11, 2 × 1,500 cNGN, each split 1,496.25 to
the recipient and 3.75 fee (`0x90423b80…8bd0`, `0xb8051faa…fce9`).

Nothing is deleted: existing schedules of any kind still render, and a skipped
schedule simply stays due rather than accruing failed runs. As of 2026-09-28
all six V4 schedules are `Direct`/USDT, so nothing is currently refused.

**Decimals are not uniform.** USDT, USDC and USA₮ are 6dp, USDm (formerly cUSD) is 18dp, cNGN is 6dp —
all verified on-chain. `lib/config.ts` holds the map; never hardcode 6.

## Ripio wFIAT on the Direct rail — live 2026-10-06

wARS, wBRL and wCOP (Ripio, 18dp, upgradeable proxies) were allowed on V4 with
`setDirectToken` from the cold owner on 2026-10-06 — no redeploy, since the
Direct allowlist is the owner's one lever that adds a corridor. They are the
three wFIAT Celo's x402 facilitator lists. Sender funds in pesos or reais, the
recipient receives the same token; nothing converts.

**A peso is not a dollar**, and these used to assume it was:
- the backend per-run cap (`LIMITS.maxRunAmountUsdt`) is scaled per token by
  `unitsPerUsd` in `_shared/config.ts` — rough rates rounded DOWN, so staleness
  and peso depreciation only make the cap stricter. An asset missing from that
  table is refused, never assumed 6dp;
- the home balance total and the unusual-schedule check count `currency: "USD"`
  tokens only.

**Getting pesos in and out is Ripio's hosted ramp**, not an integration:
`web/lib/ripio.ts` builds `ramp.ripio.com` links (country, chain 42220, token,
optional amount and address) and the send form shows "buy" and "cash out" for
any wFIAT. No credentials — Ripio's B2B API needs a company KYB. Their note
says `/offramp`; that 308s to `/off-ramp`, which is what we link.

What a NEW schedule may use is read from the contract (`directTokenAllowed`),
not from our token lists: the form's picker and `/agent` both do this, so
nothing is offered before the contract takes it. MiniPay shows none of the
wFIAT; the form warns the recipient needs another wallet.

## MiniPay: recipients are phone numbers — live 2026-10-11

MiniPay's listing rules forbid typing or pasting an address ("no arbitrary
withdrawals") and forbid SHOWING one, truncated forms included. So inside
MiniPay the send form asks for the recipient's phone number, and the browser
keeps every address feature (paste, copy, all seven tokens) outside it.

- `POST /api/resolve-phone` (Vercel route, Node runtime — `@celo/identity`
  pulls web3 1.x, which does not load under Deno) normalises to E.164
  (`web/lib/phone.ts`, libphonenumber-js; a local "0706…" is read in the country
  the sender picked — 245 of them, last pick remembered — never a guessed one), asks ODIS PnP for the
  obfuscated identifier, and reads `FederatedAttestations.lookupAttestations`
  trusting **only MiniPay's issuer `0x7888…7FBc`**. Newest attestation wins.
- The address goes back to the browser (the wallet must sign it into
  `createSchedule`) and is never rendered. Only `recipients.phone_masked`
  (`+234 706 ••• 1245`) is stored; the full number is stored and logged nowhere.
- Metered BEFORE ODIS by `note_phone_lookup()` — 20 per session per day.
  Each lookup spends paid quota and answers "whose wallet is this number".
- The schedule still pins one address. A recipient who moves their number to
  a new MiniPay wallet keeps receiving at the old one; the form says so.
- Inside MiniPay only USDT/USDC/USDm/USA₮ are offered (`miniPayVisible`) — its
  rules forbid any other token there. USA₮ joined on 2026-10-13, on the
  evidence of MiniPay's own Manual deposit screen ("Supported tokens: USDT,
  USDC, USDm, USAT"); MiniPay's developer docs still listed three that day.
  The app is what a recipient sees, so it is what we follow.
- **"Choose from contacts" comes first**: `minipay_requestContact` opens
  MiniPay's own picker and returns `{name, address}` — MiniPay resolves the
  wallet, so no number leaves the phone and no ODIS quota is spent. Its docs
  say nothing about cancel or old versions; any failure falls back to typing.
  Nothing is stored for it but the recipient's name.
- The "say it" box takes a number too ("Send 20 USDT to +234 … every month").
  `findPhone` cuts it out in the browser and the model sees `[recipient]`:
  **a phone number is never sent to DeepSeek.** The field then looks it up
  once (`phoneAutoFind`), never per keystroke — a number is valid E.164
  several digits before it is finished, and each lookup is paid.

**Quota is prepaid and runs out silently into a 503.** Key
`ODIS_QUOTA_PRIVATE_KEY` (Vercel, server-only; `~/.remesso/keys/odis.json`,
`0x7D44d82dB13EfF00ba7152A1a05611E692E50b4f`) — not the executor, not the
agent-spend key. Topped up 2026-10-11: 0.1998 USDm into `OdisPayments`
(`0xAE6B…D0CB`, `payInCUSD`, USDm only) bought **199 lookups — 0.001 USDm
each**. Check with `getPnpQuotaStatus`; top up by swapping USDT -> USDm (1bps
pool) and paying again. Gas at ~200 gwei: budget ~0.1 CELO for the four txs.

## Self identity verification — optional, gates nothing

A sender can verify with Self (self.xyz) from the home screen: a Pre-KYC flow
(OFAC, 18+) scanned from a passport in the Self app. Results land in
`identity_verifications` and show as a badge. **No payment path reads it** —
this was a deliberate choice (2026-09-19), not an omission. Making it a gate
means a check in `execute-due-runs`, since the hot key is the only thing that
triggers runs.

- Hand-rolled client in `_shared/self.ts`, not `@selfxyz/enterprise-sdk`: the
  SDK is Node-only and loads `@selfxyz/core` at import for a verifier we never
  call.
- `self-verify` polls Self's session API for status; the webhook is not
  load-bearing for that. It **is** the only source of the nullifier, so without
  `SELF_WEBHOOK_SECRET` one passport can verify any number of senders.
- Self webhooks retry (Svix), unlike cNGN's. So `self-webhook` does its work
  before answering and returns 500 to get a redelivery.
- It proves a human, not wallet ownership. MiniPay still cannot sign.
- A `sk_test_` key verifies the Self app's mock passports; the badge says so.
- **MiniPay cannot open the Self app** (tested on iOS, 2026-09-19). Self's
  handoff switches to `proofofpassport://…` and falls back to the App Store
  after 1s; MiniPay's webview blocks the switch, so the request is lost and
  Self opens with nothing to approve (its "Deferred linking" screen).
  `window.open` does not get past it either. What works: copy the link, open
  it in Chrome or Safari, approve, return to MiniPay. `IdentityCard` does
  exactly that inside MiniPay. Do not "fix" it back to a direct button.
- Self's redirect after approval lands in the browser, not MiniPay — that is
  what `/verified` is for. Landing back inside MiniPay would need MiniPay's
  `link.minipay.xyz/browse` deeplink, which MiniPay provisions on request.
- First real verification: 2026-09-19, live key, Nigerian passport. Only
  `ofac`, `minimumAge`, `excludedCountries` were disclosed — no PII.

## The assistant layer — advisory, and structurally so

Two providers, two jobs. Neither can move money: the contract is the authority,
and `execute-due-runs` reads none of this.

- **DeepSeek** (`_shared/llm.ts`) still drafts a schedule from a sentence. It
  generates text, so it is confined to a draft the sender edits and signs.
- **TypeSafe / Jev** (`_shared/typesafe.ts`) answers typed questions — a label
  and a probability distribution, never prose. Used for three things:
  classifying a failure reason (`_shared/failures.ts`), flagging fields a
  draft read ambiguously, and scoring how unusual a schedule is before it is
  signed.

**No model writes the words a sender reads about a payment.** `explain_run` was
exactly that and is gone; `classify_run` returns one of our categories and
`web/lib/failures.ts` holds the sentences. Adding a category means editing both.

**Rules before the model.** Every reason the backend writes itself is matched by
regex in `failures.ts`; Jev is asked only about the tail (contract reverts, RPC
errors, unseen cNGN messages) and only above 0.6 confidence. `failures.test.ts`
pins those rules to the exact strings `execute-due-runs` and `cngn-webhook`
emit — reword a failure there and the test fails.

**`TYPESAFE_API_KEY` is optional.** Without it: rules-only classification
(which covers every known reason), no doubt flags, no unusual line. Every
error path returns `null`, so an outage is silence rather than a broken screen.

Measured against the live API 2026-09-20, which is what the thresholds are set
from:

| Judgment | Confidence seen | Threshold |
|---|---|---|
| failure category (13 options) | 0.44–0.93 | 0.6 |
| frequency / payout rail / amount stated | 0.98–1.00 | 0.8 |
| unusual schedule (4 levels) | 0.96–0.99 | score 1.5 + conf 0.5 |

Latency 0.4–1.9s warm; the first call of a session once took past 4s, hence an
8s default and 5s where a sender is watching. A 13-option Choice is far less
certain than a 3-option one — do not reuse the 0.6 bar for a narrower question.

**Reverts are matched in code, not judged.** `InsufficientOutput`,
`transferFrom failed`, `RunCapReached` and friends are in `RULES`: asked live,
Jev read "transferFrom failed" as a network error at 0.63, which would have
told a sender to wait for a retry instead of allowing payments again.

## Attribution (ERC-8021)

Every transaction Remesso causes carries the `remesso` tag — and, for the
Agents on Open Rails hackathon (deadline 2026-11-09), the code Loops issued,
`celo_5cd35ca55baf`. `ATTRIBUTION_CODE` / `NEXT_PUBLIC_ATTRIBUTION_CODE` are
comma-separated; both codes ride in one Schema 0 suffix. The Vercel variable
must carry both too — verified in the live bundle 2026-10-06. Drop the event
code after judging by editing the env, nothing else: the executor's runs
(`_shared/attribution.ts`, spread into `simulateContract`) and every wallet
write a sender signs (`web/lib/tx.ts` → `txOverrides()`, which already rode on
all of them). The suffix sits after the calldata and the EVM discards it, so
execution is unchanged.

It matters because Celo's reward distribution reads this data and **untagged
transactions can never be claimed retroactively**. Backend and frontend share
one code deliberately — a hostname-derived code would change when the app moves
off ngrok and split the history. Crediting `remesso` on the dashboard is a
registry step with the Celo team; the tagging works regardless.

The backend encodes the suffix itself rather than importing
`@celo/attribution-tags` (Deno blocked the fresh version, and this sits in the
path of every remittance). `attribution.test.ts` pins the bytes to the SDK's
own output — one wrong byte and the indexer sees nothing, silently.

## V4/V5 and paid triggering

`RemessoExecutorV5` at `0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8` (verified,
no human audit) is what the app creates against and the executor runs from the
2026-10-16 cutover; V4 (`0x288b…6009`) before it, since 2026-09-22. V5 has V4's
ABI and storage, so everything below holds for both, except:

- **An early send moves a run, it does not add one.** V4 restarted the cadence
  from the early send, so on a schedule with no run cap each paid trigger was
  one MORE payment. V5 uses up the next slot; a trigger on a run that is
  already due costs no early send.
- **A grant to Remesso is `CURRENT_EXECUTOR`, address(1)**, resolved to the
  executor at call time. V5 refuses the executor's literal address as a
  trigger. The app writes the sentinel (`web/lib/config.ts`); `/agent`
  advertises it as `chain.trigger`.
- **On the swap rails only the sender or the executor may trigger.**
- Commission rounds UP; the degenerate-floor check uses the net amount;
  `setMinRate` refuses Direct; a first run after the expiry is refused.

**Schedules do not migrate.** They live in a contract's own storage, so every
V3 schedule is still on-chain, still owned by its sender, and will never run
again — `due_schedules` takes the executor address and only returns rows
authorised against it. Ids collide across deployments (each numbers from 1), so
that filter is what stops V4 being asked about a V3 id and running a different
sender's schedule. The UI says so on any schedule whose `executor_address` is
not the current one, and a sender re-approves and re-creates to carry on.

What it adds, all pinned at consent so no owner action reaches a signed
schedule: a payout asset per schedule from an allowlist, a commission (25bps,
`MAX_FEE_BPS` 50 in code), and `runNow` — an early send, bounded by an
allowance of triggers the sender sets, a 60s gap, and every limit they signed.
The floor is measured on the NET amount: a floor is a rate, and charging it on
the gross would tighten it by the fee.

**x402 v2 on the wire, v1 still accepted.** Measured 2026-10-01: the official
`@x402/fetch` 2.28.0, built exactly as Celo's guide documents, refused us with
*"No client registered for x402 version: 1"*. Every agent reaching for the
standard SDK — the obvious move — could not pay us at all, and only our own
hand-written client could, which is why nothing surfaced it.

v2 is not a renamed v1. **The price list travels in a `PAYMENT-REQUIRED`
header** as base64 JSON and the body is read only when that header is absent;
the payment comes back in `PAYMENT-SIGNATURE`, the receipt in
`PAYMENT-RESPONSE`. The requirements object drops `resource`, `description`,
`mimeType` and `outputSchema` into one `resource` object on the envelope and
renames `maxAmountRequired` to `amount`. So one response serves both versions:
v2 in the header, v1 in the body, each client finding its own.

`accepted` in a v2 payload echoes the chosen requirements, which is how the
seller learns the currency — but it is the PAYER's copy. `match()` uses it only
to select which of OUR advertised entries to verify against; a payload claiming
`amount: "1"` selects nothing or selects an entry whose real price we then use.
The echo selects, it never instructs.

**Our tag cannot ride on an x402 settlement we did not submit.** The
facilitator sends `transferWithAuthorization`, so only it can append ERC-8021.
The route is the `builder-code` extension: our v2 402 declares
`extensions["builder-code"].info` (`a: remesso`, `s: [celo_5cd35ca55baf]`),
the client echoes it, and the facilitator writes a Schema 2 tag. Celo DevRel,
2026-10-07: their facilitator does not write it yet (x402-rs/x402-rs#99), it is
v2-only, and USDC/USD₮/USA₮ first. Until then settlements are untagged and the
hackathon credits x402 volume **by `payTo`** — `X402_PAY_TO`, the cold owner
`0xcDEA…3Ae2`, not the executor. `x402-pay.ts` (us paying) speaks v1, which has
no extensions, so our purchases cannot carry `s` until it moves to v2.

**Two currencies, one price.** `_shared/x402.ts` holds `ASSETS` — USDC and
USA₮ — and a 402 offers both; the same `maxAmountRequired` is correct for each
only because both are 6dp. x402 **v1's payload carries no asset**, so the
seller cannot tell from `X-PAYMENT` which one the payer signed for:
`verifyAny()` tries the candidates in order and settlement must reuse the entry
that verified. Adding an 18dp asset (Ripio's wARS and friends) means pricing
per asset AND `assetTransferMethod: "permit2"`, which is a different code path.
USA₮'s domain is `Tether America USD` v1 — not the symbol — and its 18dp fee
adapter `0x0357EE22…80C4` reports the same `symbol()`, so match on address.

**Verified 2026-10-11 with the official client, as a stranger's agent would
pay:** `@x402/fetch` + `@x402/evm` 2.28.0, `registerExactEvmScheme`, default
spend controls (USA₮ is within them — no opt-in needed), a selector choosing
the USA₮ entry. `rate-service` answered 200; Celo's facilitator
(`0x0d74…FB48`) settled 0.001 USA₮ to `0xcDEA…3Ae2` in `0x5780ab21…d38d`,
87,489 gas, untagged as DevRel said. Our own test payment — not volume.

**`latam-rate` (0.001) and `latam-route` (0.002), live 2026-10-11**, sell
peso/real pricing and routing. Both read two independent sources side by side
(`_shared/latam.ts`): Textile's public ticker feed (the one `rate-service`
reads) and the Uniswap USDT pools on Celo — wARS 1bps `0x5D8e…2391`, wBRL
1bps `0x01c3…` (~88k wBRL: 1.2% impact at $5k, so the route switches venue).
wCOP has neither and is answered as "none on Celo". Ripio is links only.
Both run through `_shared/x402-serve.ts` (400 before price, answer RELEASED only
after settlement — computed first so "unavailable" charges nobody); **its description must be Latin-1** — it rides in the base64
PAYMENT-REQUIRED header and `btoa` throws on "→", which made every paid call
a 500 locally before it was caught.

`trigger-run` sells one early send over x402 — an agent pays $0.01 USDC, one
run fires ahead of cadence. The caller buys timing and nothing else. Order is
verify -> simulate -> settle -> run (since 2026-10-16; it was verify -> run ->
settle, and an unsettled signature can be replayed or cancelled, so one payment
bought any number of runs). Settling spends the payer's EIP-3009 nonce
on-chain; the simulation keeps "a run that would revert charges nobody". A run
that simulated cleanly and then reverted after settlement is logged loudly and
the payer told they were charged. It also applies the backend's own per-run
cap, $1 minimum and token table (`runAmountProblem`), and prices a swap run
from a live quote, never the sender's floor.
`verify_jwt = false`: the payment is the authentication, and callers have no
Supabase JWT. It answers 403 before quoting a price for any schedule whose
sender did not nominate this executor, and for any schedule paying out in cNGN
while `ENABLE_CNGN_RAILS` is off — nobody should pay to learn either. The rail
is read from `getSchedule()` on-chain, not from the mirror: a payer is about to
spend money on that answer.

**Reads lag.** The 403/402 decision reads the chain; just after a state change
forno can still answer from a block behind. Seen on 2026-09-22 right after a
cancel. It self-corrects within seconds.

## Agent identity

Registered with Self Agent ID on 2026-09-22, from a real passport:

| | |
|---|---|
| agent id | `191` |
| agent address | `0x5C3EBb0084233156ba51a5C2dfD42d88d5a74CA6` |
| human owner | `0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2` (the V1–V4 cold owner) |
| registry | `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944` — soulbound, `ownerOf(191)` confirms |
| ERC-8004 | agent `9867`, registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, registered 2026-09-28, metadata refreshed 2026-10-01 (`0x86e49771…dc77`) and for V5 on 2026-10-16 (`0x28d3eb9d…f3b6`) — owned by the V1–V4 cold owner |
| ERC-8004 (agent wallet) | agent `9879`, same registry and metadata as 9867, registered 2026-10-06 FROM the then-executor (`0x3c754AD3…49Cd1`, tx `0xc806f21d…bad5`) — the hackathon wants the identity held by the wallet that sends the agent's transactions. Moved to the V5 executor `0xA351…cdb21` on 2026-10-16 by `scripts/erc8004-v5.ts`: transfer `0xa8e717d6…0c3c`, `agentWallet` re-set by that wallet's EIP-712 signature `0xaa0bda8b…1b34` (the registry clears it on any transfer), metadata `0x15a8dec9…c3e4`. |

The ERC-8004 metadata is a `data:` URI embedded in the token, not a link to a
host we control: what is registered cannot be quietly rewritten later. Changing
it means `setAgentURI` and a transaction anyone can see — ~1.02M gas, about two
cents, signed by whichever key holds that token (#9867: the V1–V4 cold owner;
#9879: the V5 executor). The current document is `docs/erc8004/registration.json`
and `scripts/erc8004-v5.ts` writes it to both; it names the contract, so every
redeploy needs it again.

**It goes stale silently, and it is believed.** By 2026-10-01 it still
advertised x402 v1, `network: "celo"` and USDC alone, so an agent discovering
us correctly — by reading the registry, which is the behaviour we want — would
build a client we refuse. Rebuilt from the live `/agent` document rather than
hand-typed, so the two cannot drift apart again without it showing. The prices
in it (0.001, 0.01) are the only values that can go stale without a code
change: reprice and this needs the same transaction again.

It proves a unique human stands behind the agent and discloses nothing about
them: the returned credentials are empty bytes, and the OFAC flags are false.
That is the sybil-resistance layer the Celo Agent Visa Work tier asks for.

The agent address is an identity, not a key that moves money. Runs are still
signed by the executor (`0xA351…cdb21` on V5) and bounded by the contract.

## Agents: being paid, and paying

**`skills/remesso-x402/`** is the paid-services skill on its own: SKILL.md, a
tested `scripts/pay.mjs` (official v2 client, **USA₮ by default** — the
hackathon's USA₮ track; a wallet holding none is stopped before signing and
told to pass `--asset USDC|USDT` — asset by address, `--max` cap refused
before signing) and `manifest.json`. **Never hand-edit the
manifests** — `scripts/build-skill-manifest.ts` writes them from the live 402
and `/agent`; `--check` exits 1 on drift. `skills/manifest.json` indexes both
skills; `skills/manifest.schema.json` is the format (ours — Agent Skills
itself defines only SKILL.md frontmatter). `/skills/<path>` on the app 307s to
the repo files, allowlisted.

`skills/remesso/SKILL.md` is the integration guide an agent loads instead of
being sent a brief — the same arrangement Celo uses for `x402.celo.org/skill.md`.
It carries prices and addresses, so it has the same obligation as the ERC-8004
entry: **a skill that describes a version we no longer serve is worse than no
skill**, because it will be believed. Re-read it whenever the wire format,
prices or allowlists change.

Three pieces, all live.

**A payer can grant a program the right to collect.** `createSchedule` takes a
`trigger` address and a count; the holder calls `runNow` and brings ONE payment
forward — same recipient, same amount, at most once a minute, never past the
expiry, revocable with `setTrigger(id, 0, 0)`. Closed by default in the UI, and
the grant is read from chain, never mirrored: an authority's only honest source
is the contract that enforces it.

**`/functions/v1/agent`** is the capability document — identity (Self Agent ID
191), chain, the executor's trigger address, the paid service and its price,
and what it refuses. Public and unauthenticated on purpose: an agent nobody can
read about is an agent nobody can call.

**Four ways to hand over a receiving address**, because an agent that wants to
be PAID previously had no move at all — its operator read hex down a phone.
`POST /functions/v1/request-payment` (free, unauthenticated) writes a
`payment_requests` row that surfaces on the payer's home screen and returns a
prefill link; `/schedules/new?to=…&amount=…&every=…` fills the form directly
(`web/lib/payLink.ts` validates every parameter and drops the rest); the
address can simply be told; and the schedule screen shows the recipient with a
copy button — never when it is the sender's own wallet, which MiniPay's rules
forbid showing.

**None of it can create a schedule.** A request prefills a form: there is no
column in `payment_requests` that moves money and no code path from a row to
`createSchedule`. The form announces that a link filled it in, because a
silently prefilled recipient is how a link becomes a trick. Rows are advisory,
capped at 10 live per payer, and readable by anyone who names the address —
they are inbound requests to be paid, which is what an invoice is.

Since 2026-10-24 (`20261024000003_request_inbox.sql`):
- **Live** means pending and under 30 days old. The inbox and the cap use the
  one definition, `payment_request_live()`.
- **The cap is checked and applied in one locked call**,
  `create_payment_request`.
- **Hiding a request in the app is per session**, and changes nothing for
  anyone else. An anonymous session's wallet is a claim, not a proof, and
  anyone who named the address could see the ids.
- **Only the payer's own EIP-712 signature declines a request for everyone**:
  `action: "decline"` on `request-payment`, defined in
  `_shared/request-decline.ts`.
- `dismiss_payment_request` survives only as a per-session hide for the app
  deployed before then.

**`_shared/x402-pay.ts`** is the other direction — Remesso paying somebody
else's x402 service. Two ceilings (per call, and rolling 24h from the
`agent_spend` ledger), and the row is written BEFORE the signature: a row with
no payment is a question, a payment with no row is money nobody can account
for. `AGENT_SPEND_PRIVATE_KEY` is deliberately NOT the executor key — one key
that both moves senders' money and spends ours is one compromise with two blast
radii. `scripts/agent-pay.ts` drives it by hand.

**`sync-schedules` adopts schedules created without the app.**
`execute-due-runs` takes its work from `due_schedules` — Postgres — which held
only what the app created. `examples/create-schedule.ts` lets an agent be the
payer, and schedule #7 (2026-09-30, agent-created) proved the consequence: the
mandate was real, the allowance was real, `trigger-run` moved it, and the cron
had never heard of it. A valid schedule that silently never runs.

It scans by id — `nextScheduleId()` for the bound, the mirrored ids for what is
known, `getSchedule` for the difference — rather than indexing
`ScheduleCreated`. No checkpoint, no block range, no reorg to unwind, and right
up to a few hundred schedules; past that, index the event. **Not from the
subgraph**, which an invariant keeps out of the money path.

Every `*/5`, because this is discovery rather than payment. It skips what it
cannot run (cancelled, expired, a cNGN rail while the rails are off, an
interval under the table's 300s floor) rather than writing rows the executor
re-derives its way out of every tick.

It needed `senders.auth_user_id` to become nullable: a sender can now be a
wallet and nothing else. Such a row is invisible under RLS — every policy
compares to `auth.uid()` — until that wallet opens the app, when `claim_sender`
adopts it and the chain-discovered schedules follow it in.

Limits worth knowing before promising anything: `MIN_TRIGGER_GAP` is 60s, so
this is per-minute granularity rather than per-call streaming, and gas sets the
floor. Measured on our own transactions 2026-09-28, not taken from a published
figure: a run is ~91,875 gas, an x402 settlement ~85,842 in USDC and ~87,500 in USA₮ (the
first USA₮ payment to a fresh recipient measured 104,692 — a cold balance slot,
not the steady-state cost; do not quote that one), and createSchedule
~224,396 — at 202 gwei with CELO near $0.09 that is ~$0.0017, ~$0.0016 and
~$0.004. A one-cent payment therefore loses ~17% to gas. Re-measure before
quoting; the number moves with the gas price and with CELO.

## The Claude connector — links, never keys (2026-10-20)

`web/app/mcp/route.ts` is a remote MCP server for Claude's hosted apps (web,
desktop, iOS, Android): `https://remesso.xyz/mcp`, added once as
a custom connector on claude.ai. Stateless Streamable HTTP, one JSON-RPC
message per POST, answered as JSON (`lib/mcp/protocol.ts`, no MCP SDK).

- **Authless and keyless, by decision.** It reads the chain and builds
  `/schedules/new` prefill links; the person signs in their own wallet. A
  hosted agent key would be custody of every user's caps, so it is not here.
  Passkey smart accounts are the next step, not a server key.
- **Links need a wallet's own browser.** The site is injected-only
  (`lib/wagmi.ts`), and a link tapped in the Claude app opens Safari or
  Chrome, which has no wallet. `prepare_payment` therefore adds MetaMask and
  Trust Wallet deep links. MiniPay has no public open-this-page link
  (`link.minipay.xyz/browse` is provisioned on request).
- **It refuses what would never run:** under `minRunUnits` ($1), over $1,000
  equivalent (mirrors `LIMITS.maxRunAmountUsdt`'s default; change both), or
  more payments than fit in 364 days, because the form caps the end date there
  and the contract caps a schedule at a year. Token acceptance is read from
  `directTokenAllowed`, never from a list.
- Pay once = a one-payment schedule; the form starts schedules immediately by
  default, so it is paid within a minute of signing.
- **Its icon in the Claude apps comes from Google, not from us.** claude.ai
  draws a custom connector with Google's favicon for the URL's last two labels
  and ignores `serverInfo.icons` (anthropics/claude-ai-mcp#152, open, checked
  2026-10-22). That is why the connector moved to `remesso.xyz` on 2026-10-22:
  at `remesso.crackedstudios.xyz` it showed crackedstudios.xyz's green mark.
  Google must have indexed remesso.xyz's favicon first, and
  `https://www.google.com/s2/favicons?domain=remesso.xyz&sz=64` shows what
  Claude will. We send the brand mark in `serverIcons` too, for clients that
  read it.
- **The connector URL is a host that answers, never one that redirects.**
  OAuth's protected-resource `resource` is built from the request's origin,
  and a client checks it against the URL it was given. So `remesso.xyz` must
  serve the app itself (in Vercel, www redirects to the apex, not the reverse).
  `remesso.crackedstudios.xyz` serves the same deployment and stays up:
  MiniPay, connectors added before the move and the Edge Functions'
  `WEB_ORIGIN` still use it. Never redirect it.

## The hosted agent — hands-free from the Claude app (2026-10-20)

Option A, user-owned. Each signed-in person **owns** an agent wallet in Privy.
Remesso is one of its signers, limited by an override policy to `pay()` on
RemessoAgentAllowance, on Celo, with value 0. Money moves only from the
person's own wallet, within the caps they signed there. Off unless
`HOSTED_AGENT_ENABLED=1`; invite-only while `HOSTED_AGENT_EMAILS` lists
addresses. A legal answer is still owed before it opens to everyone.

- **Measured (signing only):** as a signer, Remesso could not change signers
  or export the key. The person's own sign-in removed Remesso, after which
  Remesso could not sign. Adding Remesso back after a Stop needs the person's
  sign-in again (`connectAgent`). `/agent/stop` is the person's Stop.
- **Privy trusts our Supabase sign-in (custom auth).** Supabase signs ES256
  (JWKS `…/auth/v1/.well-known/jwks.json`). The Privy dashboard has
  server-side JWT auth with claim `sub`, aud `authenticated` and iss
  `https://engaboljiqudghvzmebq.supabase.co/auth/v1`. A person is found with
  `getByCustomAuthID(<supabase user id>)`.
- **The limit:** Remesso runs the sign-in, so in principle it could mint a
  session and act as the owner. The fully non-custodial step is a credential
  only the person holds (a passkey via Privy's own login).
- **Sign-in is our own OAuth server** (`lib/oauth/*`, `app/oauth/authorize`,
  `app/api/oauth/*`), lazy: link tools stay open, and a hosted tool called
  without a token gets a 401 with `WWW-Authenticate` *before* any tool runs.
  A 200 with an error inside never makes Claude show its Connect card.
  Claude identifies itself with its CIMD URL, allowlisted to claude.ai and
  claude.com.
- **People sign in with a Supabase email code**, not Privy's React login,
  which adds 181 packages to the MiniPay app and needs `--legacy-peer-deps`.
  Mail goes through Resend (`noreply@crackedstudios.xyz`). Both Supabase
  templates must carry `{{ .Token }}`, or the email has a link and no code.
- **No table, and no stored sign-in.** Codes and access tokens are HS256 JWTs
  (`OAUTH_SECRET`). Claude's refresh token is our own JWT, rotated, with the
  current id kept in the person's Privy custom metadata
  (`lib/oauth/sessions.ts`); a replay ends the session. The person's Supabase
  token is used once, at Allow, and never kept.
- **Privy signs only standard tx types**, so agents pay gas in CELO.
  `GAS_TANK_PRIVATE_KEY` (a hot key that only funds agents) tops them up;
  without it the person is asked to send CELO. Remesso's P-256 key
  (`PRIVY_AUTHORIZATION_KEY`; `~/.remesso/keys/privy-authorization.json`) is
  the signer quorum's key (`PRIVY_SIGNER_QUORUM_ID`).

**A payment retried with its key pays once (2026-10-25).** An agent whose
tool call times out tries again, and `pay()` checks nothing about repeats, so
that was a second payment inside every cap. Both agent wallets now take an
`idempotency_key`; without one, an identical payment in the last ten minutes is
refused unless `allow_repeat` is passed.

- **The plugin wallet** (`mcp/src/server.mjs`) signs first and writes the hash,
  nonce and signed bytes to `~/.remesso-agent/payments.json` (0600) before
  broadcasting.
  - A retry reconciles from that record: confirmed, reverted or pending.
  - A record that never left the machine goes out with its own bytes. One whose
    nonce was taken is paid fresh.
- **The hosted connector** passes the key to Privy as its idempotency key,
  scoped to the person's wallet. Privy repeats the first answer for 24 hours,
  so nothing of ours stores keys.
- **Memos are counted in bytes.** A 17-letter memo of accented letters is 34
  bytes and is refused, not cut.
- **The plugin wallet refuses to sign unless its RPC answers chain 42220.** Its
  state is keyed by chain and contract, so the next allowance contract starts
  its own scan.

## The pre-flight agent — advice before a payment, never the payment

`preflight` (cron `remesso-preflight`, every 30 min) first records the ARS and
BRL pool rates in `rate_snapshots`. It records them on every pass, so a day-old
reading exists before any peso payment comes into view. It then looks at each
active V4 schedule due within 26h and reads balance and allowance on-chain
(`walletPosition`). For wFIAT it compares the rate with its own reading from
20–30h earlier. Then
`_shared/preflight.ts` decides which `schedule_notices` to open, refresh or
resolve. It closes its own notices once the problem is gone or the schedule
is cancelled on-chain.

- **Rules, no model.** `decide()` is pure and pinned by `preflight.test.ts`;
  `web/lib/notices.ts` holds every sentence, the same split as failures.
- **It cannot move money.** It calls no `executeRun`, sets no allowance, and
  changes no schedule. `execute-due-runs` reads none of its tables.
- **No rate claim without a reading of its own from a day ago.** The first day
  after deploy it says nothing about rates. That is correct, not a bug.
- **It does not buy from `latam-rate`**, though it reads the same sources:
  paying our own x402 endpoint would put circular volume on `payTo`.
- `?dry=1` observes and decides, writes nothing; `&hours=N` widens the window
  in a dry run only. On 2026-10-13 a dry run found #8 (wARS) cancelled on-chain
  while its row still said `active`. The chain wins, as it should.

## The receiving side — payment events, requests, webhooks (2026-10-25)

Built in Phase 3 of `docs/agent-to-agent-implementation.md`, not deployed as
of 2026-10-25.

**`payment_events`, read from the chain by `index-events`.** It runs every
minute and covers V5's runs and schedules plus the allowance contract's
payments and policies, so early sends by named triggers and agents' policy
payments are covered too. Neither passes through our functions.
- **One row per log.** The cursor moves with its batch in one call, and only
  from where it was.
- **`final` means at or below the RPC's `finalized` block.** Phase 0's first
  12.5 hours measured that at a median 23 minutes behind the head, 31 at most,
  with no block replaced at any level. The 24-hour report is
  `scripts/finality-report.ts`.
- **A reorg under the cursor rolls back to the finalized block.** Events above
  it are marked `removed`, never deleted. A changed block at or below
  finality halts the indexer for a person.
- **`seq` moves on every change,** so `payment-events?after=` and the webhook
  worker miss nothing.
- **A missing fact refuses the batch.** That covers a run's token, a policy's
  owner and a block's time. A blank row kept forever is worse than a minute's
  wait.
- **The first passes backfill from the deployment blocks:** about an hour.

**Requests have states, and accepted is not paid.**
- `pending`, `accepted`, `accepted_with_changes`, `declined`, `expired`.
- A payment is `paid` only with a transaction from `payment_events`.
- Evidence binds only if it's from the wallet asked, pays the address that
  asked, and was made after the request (`_shared/request-binding.ts`).
- A V5 schedule answers through `request-payment`'s `answer` action or
  `confirm-schedule` (`req=` in a pay link). A policy payment answers by
  carrying the request's 32-character `reference` in its memo.
- A requested amount is what the recipient receives. The form signs
  `grossFor` of it (`web/lib/fee.ts`), and the fee rounds up as V5's does.

**Webhooks.**
- Subscribing is signed by the receiving address (EIP-712). The endpoint must
  echo a challenge first.
- Deliveries are Standard Webhooks: `payment.received`, `payment.finalized`,
  `payment.removed`, with the same `webhook-id` on every retry for 24 hours.
- `_shared/safe-fetch.ts` connects to the address it checked (HTTP/1.1 over
  `Deno.connect` and `startTls`). That's verified in the Edge Runtime, not yet
  on the hosted platform. If `startTls` is missing there, it falls back to a
  re-checked `fetch`, which leaves a DNS-rebinding window.
- `webhooks` has no rate limit beyond signatures and nonces.

**The hosted connector can't decline a request.** Its Privy policy allows only
`pay()`, so it can't sign typed data. The plugin wallet can: request-payment
accepts a decline signed by an agent with a live policy from the payer.

## Invariants — do not break

- **`delivered` is not `paid_out`.** For a bank payout, the swap settling means
  cNGN reached the redemption address, not that anyone has naira. Only
  `redemption.completed` (or a `success` from `/transactions`) means that. The
  UI must never render an `ngn_bank` run's `delivered` as a finished state.
- **The contract is the authority; the database mirrors it.** Anything that
  tells a sender a run will go through reads `runnability()` on-chain.
- **A run is what its receipt says.**
  - `delivered` needs a successful receipt holding this contract's
    `RunExecuted` for the schedule (`_shared/receipt.ts`).
  - `amount_out` is that event's `amountOut`: after the commission on the
    Direct rail, never the quote.
  - viem returns a reverted receipt without throwing. Until 2026-10-24 nothing
    checked it, so a reverted run could read as delivered, at the amount sent.
  - `scripts/check-past-runs.ts` audits the recorded runs against their
    receipts.
- **Every send from the executor key holds the executor lease and saves its
  hash first.**
  - `execute-due-runs` and `trigger-run` both sign with that key. Each holds
    `_shared/lease.ts` from fetching the nonce until the receipt.
  - The hash goes on the run row before the broadcast, so a dead invocation
    leaves a hash, never an unrecorded payment. Each pass starts by settling
    such rows from the chain (`_shared/recovery.ts`).
  - Anything new that signs with the executor key must do the same, or two
    sends pick one nonce.
- **The Goldsky subgraph is read by the UI only.** `useHistory` lets a
  `RunExecuted` event settle a row on screen seconds before the backend
  writes the receipt, and a bank run it settles is `redeeming`, never
  `delivered`. `execute-due-runs` does not read it; a stale or dead subgraph
  is a slower history, not a wrong one. Without
  `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL` the history is the database alone.
- **`destination` is immutable per schedule.** `execute-due-runs` aborts before
  spending gas if cNGN returns an address that doesn't match it.
- **No cNGN credential reaches the browser.** The frontend talks to route
  handlers, which forward to the `cngn-proxy` Edge Function. That is also the
  only arrangement with a single egress IP to whitelist.
- Keep the Uniswap call inside `_shared/celo.ts`. ~76% of Celo's cNGN sits in
  one pool; the swap venue is a replaceable component.

## V1 (retired) had these defects — V2 fixes all of them

`RemessoExecutor` at `0xC7eF75fC…1189` is V1 and immutable. A 7/12-agent
security review on 2026-09-14 found, verified on mainnet:

1. **Bank payouts can never pay out.** cNGN burns only when the transferor is
   on its external-sender whitelist; a Uniswap swap makes the POOL the
   transferor, and it is not whitelisted. Silent, total.
2. **`destination` is checked only against `address(0)`**, but SwapRouter02
   treats `address(1)`/`address(2)` as sentinels — `address(2)` parks the payout
   in the router where `sweepToken` is permissionless.
3. **The floor is write-once**, with no setter and no mandatory expiry, so it
   decays against NGN and permits sandwiching down to it.
4. **`runnability()` omits `paused()`** — mitigated in the backend, which now
   calls `paused()` directly before any redemption is opened.
5. `minRateE6` unvalidated (floor can truncate to 0), `poolFee` mutable
   mid-flight, `interval` unbounded, `renounceOwnership` one-step.

`RemessoExecutorV2.sol` fixes all of the above with regression tests
(`RemessoExecutorV2.t.sol`, 10/10). **It is not deployed.** Deploying means
every sender re-authorising, so it is a deliberate decision, not a default.

## Open blockers

- **Regulatory — blocking for launch.** Instructing naira payouts to third
  parties is a money-transmission question. Needs a Nigerian fintech lawyer.
- **cNGN account is not verified.** ₦100,000 + KYB, required before
  `redeemAsset` works at all.
- **IP whitelist.** cNGN confirmed 2026-09-10: **static IP only, no CIDR.**
  Supabase egresses from the whole AWS `eu-central-1` pool (measured: 8 calls,
  8 IPs), so it cannot be whitelisted. Stand up a fixed-IP forward proxy and set
  `CNGN_EGRESS_PROXY_URL` — verified the Edge Runtime exposes
  `Deno.createHttpClient` with a proxy config, so nothing needs relocating.
  BlockRadar makes IP whitelisting opt-in and remains a live alternative, but
  confirm cNGN-on-Celo is in its NGN corridor first.
- **Redemption address stability.** Unanswered by cNGN. If it rotates per
  redemption, `ngn_bank` needs a sender-approved allowlist, not one address.
- ~~Celo support~~ **Resolved 2026-09-10:** cNGN confirmed Celo redemption is
  supported; their docs' network list is an abbreviated example.
- **Sender identity is a claim, not a proof.** MiniPay cannot sign messages, so
  SIWE is unavailable and wallets bind to an anonymous Supabase session. The
  money path is unaffected — the contract checks `msg.sender`. Since 2026-09-24
  the claim is **last-writer-wins** (`claim_sender`): a new origin or cleared
  storage means a new anonymous user, and first-come-and-permanent left the app
  with no sender row and a "sign in" message naming a screen that does not
  exist. Re-claiming grants a view of a schedule list, never the ability to
  move money. **That was not true until 2026-10-16**: RLS let the claimed
  session write `status` (pause a victim's cadence), `onchain_id` (squat ids so
  real schedules never mirrored) and recipients' bank fields. Migration
  `20261016000001` makes those service-role only; the app now asks
  `confirm-schedule`, which reads them from the chain. Still open: a bank
  payout's account details are a claim — bind them to something the sender
  signs before the naira rails come back.
- The contract is **live on mainnet and unaudited.** Schedules have run since 2026-09-22 — all
  ours so far (the first wARS run: schedule #8, 2026-10-11, `0x4eaf6976…9cdc`).

## Conventions

**Icons are a self-hosted subset of Material Symbols Rounded**
(`web/public/fonts/material-symbols-rounded.woff2`, about 43 KB, through
`components/Icon.tsx`). It holds only the glyphs the app uses. A name missing
from the subset renders as its letters ("arrow_back"). To add one, re-fetch the
subset with the full list:
`https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,300..500,0..1,0&icon_names=<comma list>`
(send a browser User-Agent to get woff2), then save the woff2 it points to over
the file. Tokens are grouped for people by `lib/regions.ts` (Dollars, LatAm,
Nigeria), derived from `currency`. The design lives in Claude Design project
`933d153d-0c34-44ad-864c-f7b9842415a5` ("Remesso Minimal").

Comments explain *why*, especially where the code looks odd — those are usually
load-bearing. Match the density already there; don't strip it.

Wallet payouts touch no cNGN API, so they are testable today and independent of
every blocker above. That is the shortest path to proving the loop.
