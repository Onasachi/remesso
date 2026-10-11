# Remesso

Automated recurring stablecoin remittances on **Celo**.

A sender authorises a remittance once — recipient, amount, cadence, expiry,
and a floor rate if anything is being converted. It then runs unattended. No
one holds the sender's keys, and no one can move their money outside the
envelope they signed: the contract enforces it, not our code.

Today it pays in **stablecoins** — the recipient receives USDT, USDC or USDm (formerly cUSD),
the assets MiniPay actually displays, or USA₮ — and, since 2026-10-06, in **pesos and
reais**: Ripio's wARS, wBRL and wCOP, so a remittance to Argentina, Brazil or
Colombia never has to pass through the dollar (see
[Local currencies](#local-currencies-pesos-and-reais)). The naira rails (cNGN to a wallet, or
through the cNGN API to a Nigerian bank account) are built and tested but
**switched off in the UI** pending the regulatory work described under
[Open items](#open-items). Everything about them below still holds; nothing
about them is reachable by a sender right now.

It is also a rail two **programs** can use: an agent can be paid by a mandate a
human signed, collect its own payment when it has earned it, and pay other
agents for services — see [Agent to agent](#agent-to-agent).

Three things distinguish it from a scheduled transfer script:

- **The contract is the authority.** A backend key triggers runs and can do
  nothing else — not redirect, not raise an amount, not outlive an expiry.
- **It is callable.** An agent, an app or a person can pay a cent over
  [x402](#being-callable) to move a payment forward, inside the same envelope.
- **It is a verified agent.** Registered with Self Agent ID against a real
  passport, so the thing moving money has a proof-of-human binding rather than
  being an anonymous key.

---

## Why Celo and cNGN

The original plan targeted moove.xyz. That does not work, and the reason is
structural rather than a matter of timing: Moove's entire public API is two
payment-link endpoints, and its stated design principle — repeated across their
docs and enforced in their key model — is *"no endpoint moves funds."* Money in
is programmable; money out is not. Moove Ramp is additionally first-person only,
so a third party can never trigger a recipient's payout.

Celo is a public blockchain, so there is no permission to ask. cNGN is a
Nigerian-SEC-regulated naira stablecoin that deployed to Celo in August 2026,
and its API does the thing Moove's cannot: `redeemAsset` burns cNGN and pays
naira to an arbitrary bank account.

Everything below was verified on-chain and against live docs, most recently
2026-10-06.

| | |
|---|---|
| **RemessoExecutorV4** | `0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009` — **live and in use**, verified, **unaudited** |
| RemessoExecutorV3 | `0xd2e68acd875fb1b3a98dc0d72659910b05e7e08f` — superseded 2026-09-22; its schedules remain on-chain and cannot run again |
| RemessoExecutorV2 | `0x218414aD37206fd4cFD6C47947574708DB0e95D2` — superseded |
| RemessoExecutor V1 | `0xC7eF75fC6283aB3b810fa4dE270F074C47761189` — retired, has known defects |
| ERC-8004 agent | `9879`, held by the executor `0x3c754AD31e802D5fA65487f460dED65Aba749Cd1` — the wallet that sends the agent's transactions. `9867` is the same identity held by the cold owner. Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`; metadata is a `data:` URI in the token, so it cannot be changed after the fact |
| Self Agent ID | token `191`, agent `0x5C3EBb0084233156ba51a5C2dfD42d88d5a74CA6`, registry `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944` |
| cNGN (Celo mainnet) | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` — **6 decimals** |
| USDT / USDC / USDm | `0x48065fbbe…483d5e` 6dp · `0xcebA9300f…C6f33A8B32118C` 6dp · `0x765DE8168…8B1282a` **18dp** |
| wARS / wBRL / wCOP (Ripio) | `0x0DC4F928…129D90D` · `0xD76f5Faf…E4390e0` · `0x8a1D45e1…91e2D76` — all **18dp**, allowed on V4 2026-10-06 |
| Uniswap SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` |
| cNGN/USDT pool | `0x6519d56eb0a69fc0338657784c783b169b8f7d32` — 0.01% tier |

**Schedules do not migrate.** They live in a contract's own storage, so every
V3 schedule is still there, still owned by its sender, and will never run
again: the executor asks `due_schedules` for rows authorised against the
contract it is configured with, and ids collide across deployments. A sender
re-approves the new address and re-creates; the app says so on any schedule
left behind. See [V4](#v4-what-changed).

> **Decimals.** cNGN is 6dp. Mento's unrelated `NGNm` is 18dp. Confusing them
> is a factor of 10¹².

---

## Architecture

```
Sender wallet              Supabase                        Celo
─────────────              ────────                        ────
approve(token) ──┐
createSchedule() ┴──▶ schedules ◀── pg_cron (every minute)
                          │
                          ▼
                 execute-due-runs ──▶ runnability()        ┌─ Direct: forward
                          │        ──▶ quote + liquidity   │  the funding asset
                          │        ──▶ executeRun ─────────┤
                          │                                └─ Swap: USDT → cNGN
                          ▼                                   (off in the UI)
                        runs ──▶ history ◀── Goldsky subgraph
                                                (seconds, not polls)

An agent ──▶ POST /trigger-run ──▶ 402 ──▶ signed USDC/USD₮/USA₮ ──▶ runNow()  [V4]
                                            ▲
                                    x402 facilitator settles, pays gas
```

Everything on the money path is deterministic: pg_cron decides *when*,
`runnability()` decides *whether*, and the contract decides *what*. The parts
that are not deterministic — the assistant, the identity check — sit at the
edges and cannot move a cent.

### The authorisation model

The sender signs **one on-chain transaction**, not a session key. MiniPay — the
wallet most of this audience actually uses — does not support message signing at
all, so an off-chain permission grant was never viable. An `approve` plus a
`createSchedule` call is also better: it is explicit, auditable, and revocable
by the sender without our cooperation.

What the backend's hot key can do: call `executeRun(id, minOut)`.
What it cannot do, enforced in the contract rather than in our code:

- send to any address except the one the sender fixed at creation
- move more than `amountIn`, or run more often than `interval`
- accept a rate below the sender's `minRateE6` floor
- run after `expiresAt` or past `maxRuns`
- touch a paused or cancelled schedule

The sender's ERC-20 allowance is the outermost cap. Revoking it stops
everything, immediately, with no involvement from us.

### Why bank payouts settle in two steps

`redeemAsset` returns a deposit address; cNGN is then sent there and naira is
paid out. So an `ngn_bank` run goes `pending → swapping → redeeming → paid_out`,
and only the `redemption.completed` webhook advances the last step. A run whose
swap has settled has **not** delivered cash — showing a sender "settled" at that
point is the failure mode this schema is shaped to prevent.

---

## V4: what changed

Deployed 2026-09-22, **unaudited**, and the contract the app and the executor
use. Three
additions, each *pinned into the schedule at consent* so no later owner action
can reach a remittance somebody already signed:

- **A payout asset per schedule**, from an owner allowlist. The swap rails were
  hardwired to cNGN at deployment, which made every new corridor a redeploy.
- **`runNow`** — an early send, callable by the sender or by an address they
  nominate, bounded by a number of early sends they authorise, a 60-second gap,
  and every limit they signed. Default is zero: a V4 schedule behaves exactly
  like a V3 one unless its sender opts in.
- **A commission**, in basis points, capped at `MAX_FEE_BPS = 50` in code. The
  floor is measured against the *net* amount, because a floor is a rate —
  charging it on the gross would tighten the sender's floor by the fee.

54 tests across the four contract suites. Most of the V4 ones are the same shape
twice: the owner changes a setting, and a schedule already authorised does not
move.

## Local currencies: pesos and reais

Across Latin America, sending money home usually means converting through the
dollar first, with a fee at each step. Ripio's **wFIAT** — wARS, wBRL, wCOP,
ERC-20s backed 1:1 by local currency — let a schedule skip that: the sender
funds in pesos or reais and the recipient receives exactly that, on the Direct
rail, with nothing converted.

No redeploy was needed. V4's Direct allowlist is the one owner lever that adds a
corridor without touching a signed schedule, and the owner called
`setDirectToken` for each on 2026-10-06
([wARS](https://celoscan.io/tx/0x717cc22cb23d14f0dee694703b4b67043051d5c854cba1f66178db1d715da3c9),
[wBRL](https://celoscan.io/tx/0x482172a7196f26f4e0b6a0285f305b1c10cacbeb12c7f378285998f33119a2ce),
[wCOP](https://celoscan.io/tx/0xbed93797508c95a556918ff6132ad6d44536155d50f6401a7b0b7b2aa4d60a85)).
Before that, the same schedules were rehearsed on a mainnet fork: refused with
`TokenNotAllowed` first, then 50,000 wARS delivered as 49,875 after the 25bps
commission.

**A peso is not a dollar**, and code written for three dollar stablecoins
quietly assumed it was. The backend's per-run cap was a dollar figure applied in
each token's own units — 1,000 meant 1,000 pesos — so it now scales by a
per-currency rate rounded *down*, which a stale rate or a falling peso can only
make stricter. An asset the backend does not know is refused rather than
assumed 6dp. The balance total and the unusual-schedule check count dollar
tokens only.

What a new schedule may use is read from the contract (`directTokenAllowed`),
not from our token lists — the form's picker and `/agent` both do — so a token
is never offered before the contract takes it. MiniPay shows none of the wFIAT;
the form says the recipient needs a wallet that does.

## Being callable

`trigger-run` sells one early send over **x402**. An agent POSTs a schedule id,
gets a `402` carrying the exact price, retries with a signed USDC, USD₮ or USA₮
authorisation, and one run fires ahead of its cadence. No account and no API key — the payment
is the authentication, which is why `verify_jwt = false` on that function.

The caller buys **timing and nothing else**. Destination, amount, asset, floor,
run cap and expiry were fixed when the sender signed, and `runNow` re-checks
every one on-chain. A schedule whose sender never nominated our executor is
refused with `403` before any price is quoted — nobody should pay to discover
that.

Order is **verify → run → settle**: a run that reverts charges nobody, and a
settlement that fails after a successful run is logged as our loss rather than
retried against a caller who already got what they paid for.

Proven on mainnet 2026-09-22: one request moved 0.01 USDC to the treasury and
0.1 USDT to a recipient
([run](https://celoscan.io/tx/0x630e46810088704a7d43d2cfb8d545f7c7a85ee3bde6e0658e814eeb70377e98),
[settlement](https://celoscan.io/tx/0xeabbf0556ad80a92981ce49298765e5b00d74945bbb21964a19b8d5627b7af9d)).
`scripts/x402-buy.ts` is the buyer half, if you want to try it.

> The facilitator advertises x402 **v1 under network `celo`** and **v2 under
> `eip155:42220`**. Pairing a version with the other name is rejected as
> `unsupported_scheme`, which reads like a scheme problem and is a naming one.

## Agent to agent

Remesso is a remittance rail two programs can use without a person in the
loop at the moment money moves — and without either program being trusted.

**A payer signs a mandate.** Who is paid, how much, how often, until when, and
how many payments a named counterparty may collect early. That signature is one
on-chain transaction and it is the whole of the authority anyone gets.

**The payee collects.** It calls `runNow` with its own key and its own gas, and
takes exactly one payment — the amount the payer fixed, to the address the payer
fixed, at most the number of times granted, never twice inside a minute, never
past the expiry. The payer can withdraw the grant at any moment, and revoking
the token allowance stops everything without our cooperation.

Proven on Celo mainnet, 2026-09-28. Agent A created a schedule paying agent B
0.02 USDT with the first payment an hour away, granting one early collection.
Agent B then collected while the schedule was **not due** — `runnability` said
`due: false`, `triggerability` said yes — and received 0.01995 USDT, the
commission taken at the rate pinned when A signed. Its second attempt was
refused: the grant was spent.

For an agent with no CELO for gas, `trigger-run` does the same thing for a cent
in USDC, and the facilitator pays the gas.

### Paying for services, not just being paid

The same wallet can buy. `_shared/x402-pay.ts` reads a 402, checks the price
against a per-call ceiling and a rolling daily cap, signs a USDC authorisation
and retries — every payment written to the `agent_spend` ledger before it is
signed. `rate-service` is the other end of that: live NGN rates for a tenth of
a cent, so the loop can be exercised in both directions.

Exercised the same day: Remesso's agent paid 0.001 USDC for a rate quote
(settled `0x53d4fdb3…`), and one of its schedules paid out on demand
(`0x630e4681…`). No API key, no account, no prior relationship on either side.

Connecting one takes nothing but HTTP: [docs/AGENTS.md](docs/AGENTS.md) is the
page to hand someone pointing an agent at this.

### What an agent needs

| To be paid | To pay |
|---|---|
| An address. That is all — the payer names it. | USDC, USD₮ or USA₮ on Celo. No CELO: EIP-3009 means the facilitator pays gas. |
| To collect early: a grant, plus gas — or a cent for `trigger-run`. | An x402 client. `scripts/agent-pay.ts` is ~40 lines. |
| Nothing to install, no key shared with us. | `GET /functions/v1/agent` to discover; the 402 is the quote. |

### What this is not

Per-minute granularity, not per-call streaming: `MIN_TRIGGER_GAP` is 60
seconds. And gas is the real floor — **measured on our own transactions**, not
taken from a published figure: a payment costs ~91,875 gas, which at 202 gwei
and CELO near $0.09 is about **$0.0017**, and creating a schedule is ~224,000
gas (~$0.004). So a one-cent payment loses roughly 17% to gas, and a payment of
a few cents is the honest floor. Sub-cent streaming is payment channels, and
none of this is that.

## Identity

Two separate things, both optional to the money path:

- **Senders** can verify with [Self](https://self.xyz) from the home screen: a
  Pre-KYC flow (OFAC screening, 18+) proved from a passport, zero-knowledge, no
  personal data stored. It **gates nothing** — that was a decision, not an
  omission. Making it a gate means a check in `execute-due-runs`.
- **Remesso itself** is registered as a Self Agent ID (token `191`), soulbound
  to the cold owner wallet. That is what makes the agent sybil-resistant rather
  than an anonymous key, and it is the Work-tier requirement for Celo's Agent
  Visa. Its ERC-8004 identity is agent `9879`, held by the executor — the
  wallet that actually sends the agent's transactions — with `9867` as the same
  record held by the cold owner.

MiniPay cannot open the Self app directly — its webview blocks the handoff and
falls through to the App Store, losing the request. The app therefore asks the
sender to copy the link into Chrome or Safari. Verified on device.

## The assistant layer

Two providers, neither of which can move money.

**DeepSeek** turns a sentence into a draft schedule the sender edits and signs.
**TypeSafe (Jev)** answers typed questions — a label and a probability, never
prose — and does three jobs: classifying a failure reason, flagging fields a
draft read ambiguously, and scoring how unusual a schedule is before it is
signed.

The rule that matters: **no model writes the words a sender reads about a
payment.** `classify_run` returns one of our categories and `web/lib/failures.ts`
holds the sentence. Reasons the backend writes itself are matched by regex
first; Jev is asked only about the tail, and only above 0.6 confidence.

## Attribution

Every transaction Remesso causes carries the Celo attribution suffix
(ERC-8021, code `remesso`) — the executor's runs and each wallet write a sender
signs. Celo's reward distribution reads this data and **untagged transactions
cannot be claimed retroactively**. First tagged transaction: 2026-09-22.

During the **Agents on Open Rails** hackathon (to 2026-11-09) every
transaction also carries `celo_5cd35ca55baf`, the code Loops issued to this
entry. Both ride in one Schema 0 suffix — `ATTRIBUTION_CODE` and
`NEXT_PUBLIC_ATTRIBUTION_CODE` are comma-separated — and the encoder is pinned
byte for byte to `@celo/attribution-tags`. Dropping the event code afterwards
is an env change.

## The indexer

A Goldsky instant subgraph over the executor gives the UI a run within seconds
of its block, instead of waiting for the backend write plus a 15-second poll.
It is advisory: `web/lib/history.ts` merges it with the `runs` table, and
without it the history is simply the database. See `indexer/README.md`.

## Layout

```
contracts/          Foundry. V1-V4 + 54 tests.
indexer/            Goldsky instant subgraph over the executor (see its README).
scripts/
  check-env.ts      Is .env complete and coherent? Proves the SSH key.
  x402-buy.ts       The buyer half of trigger-run: quote, sign, pay, call.
  agent-pay.ts      Remesso paying someone else's x402 service, by hand.
  e2e-agent-test.ts Local end-to-end run against a funded test wallet.
examples/           An agent paying Remesso, or signing a schedule itself.
skills/remesso/     SKILL.md — the integration guide an agent loads.
supabase/
  migrations/       Schema, RLS, pg_cron triggers.
  functions/
    _shared/        Config, cNGN client, Celo/viem, Self, Jev, x402,
                    attribution, failure classification — with tests.
    execute-due-runs/       The executor loop.
    sync-schedules/         Adopts schedules created without the app.
    trigger-run/            Paid early send over x402 (no JWT; payment is auth).
    rate-service/           Live NGN rates over x402, a tenth of a cent.
    agent/                  The public capability document.
    request-payment/        "Pay me here" — prefills a payer's form, moves nothing.
    self-verify/            Starts an identity check, reports where it stands.
    self-webhook/           Self results (Svix-signed; retries, unlike cNGN).
    ai-assist/              Draft a schedule; classify a failure; score a risk.
    cngn-webhook/           Redemption settlement (fast path).
    reconcile-redemptions/  Redemption settlement (authoritative path).
    cngn-proxy/             The frontend's only route to the cNGN API.
    balance-poller/         Funding + liquidity pre-flight warnings.
web/                Next.js sender app. MiniPay-first, wagmi + viem.
  app/api/          Server-only handlers; forward to the Edge Functions.
  lib/              Config, ABI, hooks, formatting, failure copy, allowance
                    maths, attribution, subgraph reads.
```

## Getting started

```bash
cp .env.example .env          # fill in secrets; never commit this

cd contracts
forge install                 # forge-std + openzeppelin
forge test                    # 54 passing across V1-V4

# Deploy to testnet FIRST and run a full schedule end to end there.
DEPLOYER_PRIVATE_KEY=0x... EXECUTOR_ADDRESS=0x... \
  forge script script/DeployV4.s.sol:DeployV4 --rpc-url celo_sepolia --broadcast

cd ..
supabase db push
supabase functions deploy execute-due-runs cngn-webhook reconcile-redemptions \
  cngn-proxy balance-poller ai-assist self-verify self-webhook trigger-run
supabase secrets set --env-file .env.functions
```

`.env.functions`, not `.env`: Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`
and `SUPABASE_SERVICE_ROLE_KEY` itself and rejects them as reserved, failing the
whole command. `TESTING_*` is excluded too — those hold a funded wallet key used
only by the local e2e script, and shipping a spendable key into a deployed
environment for no reason is how blast radius grows quietly.

```bash
grep -vE '^(SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY)|TESTING_)' .env \
  | grep -E '^[A-Z0-9_]+=' > .env.functions
```

Everything optional degrades to silence rather than an error. Without
`DEEPSEEK_API_KEY` there is no draft-from-a-sentence; without
`TYPESAFE_API_KEY` failures are still classified by rules; without `SELF_*`
the verify card never appears; without `X402_*` paid triggering answers 503;
without `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL` the history is the database alone.
`scripts/check-env.ts` says which of these you have.

Set the cron vault secrets once, so the service-role key never sits in a cron
definition in plain text:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>',        'service_role_key');
```

Point the cNGN dashboard's webhook URL at
`https://<ref>.supabase.co/functions/v1/cngn-webhook` and set the signing
secret to `CNGN_WEBHOOK_SECRET`. Configure the test URL and verify against
sandbox transactions before touching the live one.

**Enable anonymous sign-in** before the frontend will work at all: Supabase
Dashboard -> Authentication -> Sign In / Providers -> Anonymous sign-ins. It is
off by default, and `ensureSender()` calls `signInAnonymously()` on every wallet
connection — MiniPay cannot sign messages, so SIWE is not available to this
audience. Without it every request fails with
`422 anonymous_provider_disabled`, which surfaces as a frontend that silently
shows no schedules.

Then the sender app:

```bash
cd web
cp .env.local.example .env.local   # public config only; no cNGN secrets here
npm install
npm run dev
```

`web/.env.local` holds nothing sensitive by design. The cNGN API key, AES key
and Ed25519 private key exist only as Supabase secrets, reachable through the
`cngn-proxy` Edge Function — the docs are explicit that they must never reach
client-side code, and cNGN whitelists by IP, so one egress point is also the
only arrangement that can be whitelisted at all.

---

## Liquidity: the live constraint

There is exactly **one** cNGN venue on Celo — the Uniswap V3 pool above. It
holds roughly 118M cNGN and 95k USDT. Measured via QuoterV2 on 2026-09-07:

| Trade | Slippage |
|---|---|
| $100 | 0.005% |
| $1,000 | 0.055% |
| $2,500 | 0.14% |
| $5,000 | 0.27% |
| $10,000 | 0.55% |

Re-measured via QuoterV2 on 2026-09-14: the pool held 93,611 USDT and 119.6M
cNGN, and spot was ₦1,369.28/USDT. `liquidityIsHealthy` aborts above 150bps,
which this pool does not reach until roughly $27–30k.

Spot was ₦1,368/USDT, sitting sensibly between the official NFEM rate (₦1,329)
and the parallel market (₦1,395–1,410).

For remittance-sized transfers this is effectively free. Two consequences are
baked into the code:

1. `LIMITS.maxRunAmountUsdt` caps a single run well below the point where
   slippage bites, and `liquidityIsHealthy()` aborts a run the pool cannot fill
   cheaply rather than executing it at any price.
2. **About 76% of all cNGN on Celo sits in that one pool.** One LP withdrawal
   removes the entire swap route. Treat the swap as a replaceable component:
   Textile FX (OTC, 78 onboarded Nigerian firms) is the venue for size, and
   minting cNGN directly through ASC is the endgame. Do not let the Uniswap call
   leak beyond `_shared/celo.ts`.

---

## The cNGN integration

Implemented against the published spec at `docs.cngn.co`, not against
assumptions. Four properties of that API drive the code:

**Requests are encrypted, responses are sealed.** POST and PUT bodies go out as
`{content, iv}` — AES-256-CBC under a key derived by SHA-256'ing the dashboard
encryption key. Every *successful* response comes back as
`{status, message, data}` where `data` is a base64 libsodium `crypto_box`
sealed to your Ed25519 public key: `nonce(24) || ciphertext || ephemeral pk(32)`.
It is an opaque string on the wire, so reading a field off it without opening it
first silently yields `undefined`.

`supabase/functions/_shared/cngn.test.ts` verifies both directions against the
docs' own reference implementations — our AES ciphertext is byte-identical to
what Node's `createCipheriv` produces, and the tests play the role of the cNGN
server, sealing payloads to a freshly generated `ssh-keygen` key and requiring
the client to open them. Run it with:

```bash
deno test --allow-env --allow-read --allow-write --allow-run --allow-net \
  supabase/functions/_shared/cngn.test.ts
```

**The rate limit is 20 requests per 60 seconds per API key, and breaching it
blocks the key for another 60 seconds.** That makes the limiter in `cngn.ts` a
correctness feature rather than politeness: one burst of bank-list lookups from
a signup page would otherwise strand an in-flight redemption. Banks and networks
are cached for six hours in the Edge Function and again for twelve in the Next
route handler, which is what the docs advise.

**Webhooks are delivered exactly once.** *"Deliveries are sent once, with a
10-second timeout, and are not automatically retried."* A 500 from us — a cold
start, a deploy landing mid-delivery — loses the event permanently and leaves a
run stuck in `redeeming` while the recipient has in fact been paid. So
`cngn-webhook` persists and acknowledges before doing any work, and
`reconcile-redemptions` polls `/transactions` every ten minutes for anything
still open. The webhook is the fast path; the transactions API is the authority.

**Only four endpoints are on the money path**, and they are deliberately split
by who can reach them:

| | Reachable from | Notes |
|---|---|---|
| `GET /banks` | `cngn-proxy` (signed-in senders) | Cached hard; ~900 rows |
| `POST /account/verify` | `cngn-proxy` (signed-in senders) | At onboarding only, never at payout |
| `POST /redeemAsset` | `execute-due-runs` only | Requires the "Redeem" permission |
| `GET /transactions` | `reconcile-redemptions` only | Settlement of record |

Note the path is `/account/verify`, not `/verifyAccountDetails` — an earlier
draft of this repo had the latter, which does not exist.

---

## Getting cNGN credentials

Everything below comes from the merchant dashboard, and **each environment has
its own complete set**. A `cngn_test_` key with a live encryption key fails; so
does a live key against the SSH key you uploaded for test.

1. **Onboard as a merchant.** Sandbox access needs an account. Live keys are
   issued only after KYB completes: business documents, identity verification
   for account owners, and the onboarding fee. This gates the entire live path,
   so start it early — it is not a same-day step.

2. **API key and encryption key.** Dashboard → **Settings → API Key**. Both are
   already generated; reveal with the eye icon and copy with the clipboard icon.
   The prefix picks the environment (`cngn_test_…` / `cngn_live_…`); the base
   URL is the same either way.
   → `CNGN_API_KEY`, `CNGN_ENCRYPTION_KEY`

3. **Ed25519 keypair — you generate this, not cNGN.**

   ```bash
   ssh-keygen -t ed25519 -C "api@remesso" -f cngn_api_key
   ```

   Paste `cngn_api_key.pub` into the **SSH public key** field on the same tab.
   Keep the private half. Without it every request fails with
   `No Test SSH Key found`, and nothing the API returns is readable.
   → `CNGN_SSH_PRIVATE_KEY` (the private half; escaped `\n` is fine)

   **Take the default of no passphrase.** cNGN's guide offers one, but the
   executor runs unattended and has nothing to prompt with — a passphrase
   encrypts the key body and the private key cannot be loaded at all. If you
   already set one, strip it; the public key is unchanged, so the dashboard
   needs no update:

   ```bash
   ssh-keygen -p -N "" -f cngn_api_key
   ```

   The four ways this goes wrong — passphrase, the `.pub` file pasted instead
   of the private half, an RSA key, and a truncated paste — each fail with a
   message naming the actual problem rather than a generic parse error. They
   are covered in `cngn.test.ts`, because the failure they'd otherwise produce
   is an unexplained key mismatch hours later.

4. **Permissions.** An organisation admin grants these per key. Remesso needs
   **Redeem**. Without it `redeemAsset` returns `{"status": false, "message":
   "Permission denied"}` — note that shape: the HTTP status is not the whole
   story, which is why the client checks both.

5. **IP whitelist.** Dashboard security settings. See below — this is the part
   that does not have a clean answer yet.

6. **Webhook signing secret.** Dashboard → webhooks. Set the URL to
   `https://<ref>.supabase.co/functions/v1/cngn-webhook` and subscribe to
   `redemption.completed` and `transaction.failed` at minimum.
   → `CNGN_WEBHOOK_SECRET`

```bash
# Prove the credentials before wiring anything up. /balance needs no request
# encryption, so a 200 here means the key, the IP and the SSH key are all good.
curl -s -X GET "https://api.cngn.co/v1/api/balance" \
  -H "Authorization: Bearer $CNGN_API_KEY"
```

The `data` field of that response will be an unreadable base64 string. That is
correct — it is sealed to your public key.

### cNGN egress: the IP whitelist problem

cNGN checks the source IP of every request against a dashboard whitelist and
answers `403 IP address not whitelisted` regardless of credentials. Supabase
Edge Functions run on a large, dynamic pool of addresses, so **there is nothing
stable to whitelist.** This is a deployment blocker for the live environment,
not a code problem, and it has three possible answers:

**cNGN confirmed 2026-09-10: static IP only, no CIDR.** That settles it — there
is no arrangement under which Supabase's rotating egress can be whitelisted, so
cNGN traffic has to leave from one fixed address.

1. **A fixed-IP forward proxy — the recommended path.** Set
   `CNGN_EGRESS_PROXY_URL` and `cngn.ts` routes every cNGN call through it,
   throwing a clear error rather than silently going direct if the runtime
   cannot. Verified 2026-09-10 that the Supabase Edge Runtime
   (supabase-edge-runtime-1.76.0, Deno 2.1.4) does expose
   `Deno.createHttpClient` and accepts a proxy config, so this works without
   moving anything. A small VPS running tinyproxy, a Fly.io machine with a
   dedicated IPv4, or a managed static-IP proxy all satisfy it.
2. Move the cNGN-touching functions onto a host that has a static egress IP.

The 403 was reproduced directly: `GET /balance` with the live key returns
`{"status":403,"message":"IP address not whitelisted"}`, and an empty IP Access
List blocks everything rather than allowing everything.

---

## Open items

- **Regulatory posture — unresolved, and the reason the naira rails are off.**
  `redeemAsset` puts Remesso in the business of instructing naira payouts to
  third parties. That is a money-transmission question and it needs a Nigerian
  fintech lawyer before it goes near real senders. Until then the product ships
  **stablecoin-only** (`NEXT_PUBLIC_ENABLE_CNGN_RAILS` is not `"1"`), which
  needs no payout partner, no cNGN API and no licence answer. Nothing is
  deleted: the contract keeps all three rails and existing schedules of any
  kind still render.
- **V4 is unaudited.** It is deployed and was exercised once on mainnet, but no
  audit has been run, and it holds spending authority the moment a sender
  approves it. Audit before migrating anyone.
- **The V3 → V4 migration is half done.** The app and the executor are on V4 as
  of 2026-09-22; the schedules authorised against V3 are not, and cannot be —
  each sender must approve the new address and re-create.
- ~~**BANK PAYOUTS CANNOT WORK ON THE DEPLOYED CONTRACT.**~~ **Fixed in V2 and
  deployed in V3.** The original defect, found in the 2026-09-14 review: cNGN
  only burns when `isExternalSenderWhitelisted(msg.sender)`, and a Uniswap swap
  makes the **pool** the transferor, so a bank run would debit the sender, emit
  `RunExecuted`, pass both slippage guards and never pay naira. V2 onwards swaps
  to itself and forwards with an explicit `safeTransfer`, making one
  whitelistable address the sender-of-record. **cNGN must still whitelist the
  live executor address** before a transfer from it will burn — and a new
  deployment is a new sender-of-record, so V4 needs its own whitelisting.
- **Redemption-address stability — unanswered by cNGN.** `redeemAsset` returns
  a deposit address *per redemption*, while the contract fixes `destination` at
  authorisation. Two guards exist: `execute-due-runs` compares the address cNGN
  returns against the on-chain destination and aborts *before spending gas* if
  they differ, and the UI hides bank payouts entirely. If it does rotate, the
  envelope needs a sender-approved allowlist rather than one address.
- **cNGN account is not verified.** ₦100,000 plus KYB, and `redeemAsset` does
  not work until it completes.
- **The IP whitelist needs a fixed-IP proxy standing up.** cNGN will not
  whitelist a CIDR, and Supabase egresses from the whole AWS `eu-central-1`
  pool — measured: 8 consecutive calls, 8 distinct IPs.
- **Sender identity is a claim, not a proof.** MiniPay does not support message
  signing, so SIWE is unavailable and the app binds a wallet to an anonymous
  Supabase session. This does not weaken the money path — the contract checks
  `msg.sender`, and nothing in the database can move funds. Since 2026-09-24 the
  claim is last-writer-wins (`claim_sender`), which grants a view of a schedule
  list and never the ability to move money. Self verification proves a
  *human*, not wallet ownership; it does not close this.
- **The `remesso` attribution code is not yet credited** on Celo's dashboard.
  Tagging works regardless; crediting is a registry step with the Celo team.
- Recipient notifications — one seam left in `balance-poller`.
