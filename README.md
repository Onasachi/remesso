# Remesso

**Send money home on a schedule, in the currency your family spends — signed
once, carried out by an agent on Celo.**

[App](https://remesso.crackedstudios.xyz) ·
[Demo video](https://youtu.be/AD8JhgAlb9c) ·
[Agent document](https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent) ·
[Hackathon write-up](docs/submission.md)

Families split across borders pay each other on a rhythm: rent every month,
school fees every term, a parent's allowance every week. Remesso turns that
into one decision. The sender signs a mandate once — who, how much, how often,
until when — and Remesso's agent pays it on Celo mainnet from then on, without
asking again and without ever holding the money.

- **Eight currencies.** USDT, USDC, USDm and USA₮, which MiniPay shows; Ripio's
  wARS, wBRL and wCOP for Argentina, Brazil and Colombia; and cNGN for Nigeria.
  The recipient receives exactly the token sent. Nothing is converted.
- **Built for MiniPay.** Inside MiniPay the recipient is a contact or a phone
  number, never an address.
- **The contract is the authority.** The agent can only do what was signed, and
  nobody can redirect, resize or extend a payment.
- **Agents can use it too.** Four paid services over x402, a published skill
  that pays in USA₮ by default, and mandates one program can sign for another.

---

## How it works

1. **The sender signs once.** Two transactions in their own wallet: `approve`
   the token, then `createSchedule` on `RemessoExecutorV4` with the recipient,
   amount, interval, number of payments and expiry.
2. **The agent finds it.** Every 5 minutes `sync-schedules` scans the contract
   for new schedules, including ones created by a script or another agent
   rather than the app.
3. **The agent checks ahead.** Every 30 minutes the pre-flight agent looks at
   each payment due in the next day. It checks the sender's balance, their
   allowance and, for pesos and reais, the exchange rate, and posts a notice in
   the app with the fix attached before a payment would be skipped.
4. **The agent pays.** Every minute `execute-due-runs` takes the due schedules,
   asks the contract `runnability()` (due, funded, approved), and the agent
   wallet calls `executeRun`.
5. **The contract moves the money** straight from the sender's wallet to the
   recipient, less a 0.25% fee fixed at signing, and the app shows the receipt.

```
Sender wallet            Supabase (Edge Functions + pg_cron)        Celo
─────────────            ───────────────────────────────────        ────
approve + createSchedule ───────────────────────────────────▶ RemessoExecutorV4
                         sync-schedules      every 5 min  ◀── nextScheduleId / getSchedule
                         preflight           every 30 min ◀── balance, allowance, pool rate
                           └─▶ notice in the app, with its fix
                         execute-due-runs    every minute ──▶ runnability() ─▶ executeRun()
                           └─▶ runs ─▶ history ◀── Goldsky subgraph (seconds, not polls)

Another agent ─▶ POST /trigger-run ─▶ 402 ─▶ signed USA₮/USDC/USD₮ ─▶ runNow()
                                        Celo's x402 facilitator settles and pays the gas
```

**What the agent's key can do:** call `executeRun` and `runNow`. **What it
cannot do**, enforced by the contract rather than by our code: pay anyone but
the recipient fixed at signing, send more than the amount, run more often than
the interval or past the expiry or the payment count, or touch a paused or
cancelled schedule. The sender's token allowance is the outer limit, and
revoking it stops everything at once without our involvement.

Signing is a transaction, not a message, on purpose: MiniPay cannot sign
messages, so an off-chain permission was never an option for this audience. A
transaction is also explicit, visible on-chain, and revocable by the sender
alone.

---

## Currencies

All on Celo mainnet. The contract's own allowlist (`directTokenAllowed`)
decides what a new schedule may use, and the app, the agent document and the
skill read that allowlist rather than a list of ours.

| Token | Currency | Decimals | In MiniPay | On the web | Get it / cash out |
|---|---|---|---|---|---|
| **USDT** | US dollar | 6 | ✅ | ✅ | MiniPay's Add money |
| **USDC** | US dollar | 6 | ✅ | ✅ | MiniPay's Add money |
| **USDm** (formerly cUSD) | US dollar | 18 | ✅ | ✅ | MiniPay's Add money |
| **USA₮** | US dollar | 6 | ✅ | ✅ | MiniPay's Add money |
| **wARS** (Ripio) | Argentine peso | 18 | — | ✅ | Ripio ramp |
| **wBRL** (Ripio) | Brazilian real | 18 | — | ✅ | Ripio ramp |
| **wCOP** (Ripio) | Colombian peso | 18 | — | ✅ | Ripio ramp |
| **cNGN** | Nigerian naira | 6 | — | ✅ | Textile: swap USDT→cNGN, Withdraw NGN to a bank |

Every schedule uses the **Direct** rail: the recipient gets the token the
sender funds with. A peso schedule pays pesos and a cNGN schedule pays cNGN.

**Decimals are not uniform.** USDm and the Ripio tokens are 18dp; USDT, USDC,
USA₮ and cNGN are 6dp. `web/lib/config.ts` and
`supabase/functions/_shared/config.ts` hold the map, and the backend refuses a
token it does not know rather than guess its decimals.

**A peso is not a dollar.** The backend's per-payment safety cap is scaled per
currency, rounded so it only ever gets stricter. Balance totals and the
"unusual schedule" check count dollar tokens only.

**Ramps are links, not integrations.** Ripio's hosted ramp buys and cashes out
pesos and reais from a local bank account, and its links carry the wallet:
the sender's to buy, the recipient's to cash out. Textile swaps USDT into cNGN
and withdraws cNGN to a Nigerian bank through Noblocks (about ₦1 per cNGN).
Textile takes no wallet in a link, so the app says which wallet to connect
there. Either way the person does it on that site, and Remesso never sees the
bank side. For a Nigerian recipient paid in USDT, the app links Textile's
USDT→cNGN→bank cash-out.

---

## MiniPay

Remesso is built to MiniPay's Mini App rules.

- **It connects by itself.** MiniPay is detected and the wallet connects with
  no button.
- **Recipients are contacts or phone numbers, never addresses.** "Choose from
  contacts" opens MiniPay's own picker (`minipay_requestContact`), so no number
  leaves the phone. A typed number is resolved on our server through **ODIS**
  and **FederatedAttestations**, trusting only MiniPay's issuer. A picker covers
  245 countries, and the last choice is remembered. Only a masked number is
  stored (`+234 706 ••• 1245`). Lookups are paid and metered at 20 per session
  per day.
- **No address is ever shown** inside MiniPay, truncated or not.
- **MiniPay's tokens only:** USDT, USDC, USDm and USA₮.
- **"Or just say it."** "Send 20 USDT to +234 803 … every month" fills the form.
  The phone number is cut out in the browser, so the language model only ever
  sees `[recipient]`.

Remesso is tested in MiniPay's developer mode and is not yet a listed Mini App.

---

## The agent

| | |
|---|---|
| Agent wallet (sends every payment) | `0x3c754AD31e802D5fA65487f460dED65Aba749Cd1` |
| ERC-8004 identity, held by the agent wallet | agent **9879** (registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) |
| ERC-8004 identity, held by the owner | agent 9867 |
| Proof of a human behind it | Self Agent ID **191**, soulbound, from a passport proof |
| Capabilities (free, machine-readable) | `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` |
| Agent card | https://remesso.crackedstudios.xyz/.well-known/agent.json |

**Paying a due schedule is deliberately mechanical:** the contract decides
whether it may go. The judgement sits before that, in the **pre-flight
agent** (`supabase/functions/preflight`):

- **Observe.** It reads the sender's balance and allowance on-chain. For wARS
  and wBRL it also reads the Uniswap pool rate and compares it with its own
  reading from a day earlier.
- **Decide.** It works out whether the next payment will be skipped and why,
  whether the one after will be, and whether a peso payment's dollar value has
  moved by 3% (info) or 8% (warning). A shortfall becomes urgent inside six
  hours.
- **Act.** It posts a notice in the sender's app that says by how much the
  payment falls short, with "Add money" or "Allow payments again" attached.
- **Verify.** It checks again on every pass and closes its own notice once the
  problem is fixed or the schedule is cancelled.

Its rules are a pure function pinned by tests (`_shared/preflight.ts`). The
words a sender reads are written in code, not by a model, and it never touches
the money path.

**Attribution.** Every transaction Remesso causes carries an ERC-8021 suffix
with `remesso` and the hackathon code `celo_5cd35ca55baf`: each payment the
agent sends and each transaction a sender signs in the app. The encoder is
pinned byte for byte to `@celo/attribution-tags`.

---

## For other agents

### Paid services over x402

Sold through **Celo's facilitator** (`https://api.x402.celo.org`). The payer
signs a token authorisation and the facilitator submits it and pays the gas,
so **the payer needs no CELO**.

| Service | Endpoint (`/functions/v1/…`) | Price | What it does |
|---|---|---|---|
| `naira-rate` | `rate-service` | 0.001 | Live USDT/NGN and USDC/NGN: bid, ask and last |
| `latam-rate` | `latam-rate` | 0.001 | USD→wARS and USD→wBRL from two on-chain sources side by side (Textile's maker quotes and the Uniswap pool at your size), flagged when they disagree by more than 1% |
| `latam-route` | `latam-route` | 0.002 | How to deliver pesos or reais: the token, the dollars needed, the best venue at that size, and Ripio and Remesso links |
| `trigger-run` | `trigger-run` | 0.01 | Brings one payment of a schedule forward, only if its sender allowed early sends |

- **Currencies:** USA₮, USDC and USD₮, at the same price in each.
- **Paid to:** `0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2`, the same on every
  service.
- **x402 v2 on the wire, v1 still accepted.** The price list travels in the
  `PAYMENT-REQUIRED` header, the payment in `PAYMENT-SIGNATURE` and the receipt
  in `PAYMENT-RESPONSE`. Verified with the official `@x402/fetch` and
  `@x402/evm` 2.28.0 paying in USA₮ at default settings.
- **Nobody pays for a failure.** A request that cannot succeed is refused
  before a price is quoted, and the order is verify → run → settle, so a
  payment that reverts charges nothing.
- Rates are built on **Textile FX's** live maker quotes, cross-checked against
  the Uniswap pools on Celo.

### Skills

```bash
npx skills add crackedstudio/Remesso --skill remesso-x402   # pay the services above (USA₮ by default)
npx skills add crackedstudio/Remesso --skill remesso        # schedules, being paid, the contract
```

`remesso-x402` ships a ready-to-run payer (`scripts/pay.mjs`) and a
`manifest.json` generated from the live 402 responses, never typed by hand
(`scripts/build-skill-manifest.ts --check` fails on drift). It stops before
signing if the wallet holds no USA₮, and refuses any quote above `--max`.

### Mandates between programs

An agent can be the payer, the payee, or both.

- **A payer signs a mandate**: who, how much, how often, until when, and
  optionally how many payments a named address may collect early.
- **The payee collects** with `runNow`: one payment at a time, the amount and
  recipient the payer fixed, never twice inside a minute, never past the
  expiry. The payer can withdraw the grant at any moment.
- **An agent asks to be paid** with `POST /functions/v1/request-payment`
  (free). The request appears on the payer's home screen as a prefilled form;
  it can never create a payment by itself. `/schedules/new?to=…&amount=…`
  links work the same way.
- **Schedules created outside the app** are found within five minutes and paid
  like any other.

[docs/AGENTS.md](docs/AGENTS.md) is the page to hand someone connecting an
agent.

---

## Deployed on Celo mainnet

| | |
|---|---|
| **RemessoExecutorV4** | `0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009`, live since 2026-09-22, verified, **unaudited** |
| Owner (cold) | `0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2`. It can pause, set the fee within the coded cap, and add tokens to the allowlist. It cannot touch a signed schedule. |
| Agent / executor (hot) | `0x3c754AD31e802D5fA65487f460dED65Aba749Cd1`, which pays gas only |
| Earlier versions | V3 `0xd2e68acd…7e08f`, V2 `0x218414aD…DB0e95D2`, V1 `0xC7eF75fC…1189`, all superseded. Schedules do not migrate between contracts. |
| Tokens | USDT `0x48065fbB…483D5e` · USDC `0xcebA9300…32118C` · USDm `0x765DE816…B1282a` · USA₮ `0xD2ab3C9A…67F771` · wARS `0x0DC4F928…29D90D` · wBRL `0xD76f5Faf…4390e0` · wCOP `0x8a1D45e1…91e2D76` · cNGN `0xF6829D73…271a4f` |

What V4 adds over V3, each fixed in the schedule at signing so no later owner
action can reach it:

- **A payout token per schedule**, from the owner's allowlist. New currencies
  are added with `setDirectToken` and need no redeploy.
- **`runNow`**, an early send, bounded by a number of early sends the sender
  grants and by every limit they signed.
- **A commission** of 25 bps, with `MAX_FEE_BPS` capped at 50 in code.

Proof on mainnet, all from our own test wallets: the first peso payment
(`0x4eaf6976…9cdc`), the first cNGN payments (`0x90423b80…8bd0`,
`0xb8051faa…fce9`), x402 payments in USA₮ through the official SDK and through
the skill, and an agent collecting early on a mandate another agent signed.
[docs/submission.md](docs/submission.md) lists each transaction.

---

## Repository

```
contracts/          Foundry: RemessoExecutor V1–V4, 54 tests.
indexer/            Goldsky subgraph over the executor, read by the UI only.
skills/             remesso and remesso-x402, plus the manifest index and schema.
examples/           An agent paying Remesso, or creating a schedule itself.
scripts/            check-env, x402-buy, agent-pay, e2e-agent-test, build-skill-manifest.
docs/               submission, AGENTS, invite kit, screenshots, cNGN bank payouts.
supabase/
  migrations/       Schema, row-level security, pg_cron jobs.
  functions/
    _shared/                Config, Celo/viem, x402, attribution, pre-flight rules,
                            failure classification, Self, cNGN client, with tests.
    execute-due-runs/       Pays due schedules (every minute).
    sync-schedules/         Adopts schedules created outside the app (every 5 min).
    preflight/              The pre-flight agent (every 30 min).
    trigger-run/            Paid early send over x402.
    rate-service/           naira-rate over x402.
    latam-rate/, latam-route/   Peso and real pricing and routing over x402.
    agent/                  The public capability document.
    request-payment/        "Pay me here": prefills a payer's form.
    ai-assist/              Drafts a schedule from a sentence; scores and classifies.
    self-verify/, self-webhook/   Optional identity check with Self.
    cngn-proxy/, cngn-webhook/, reconcile-redemptions/, balance-poller/
                            The naira bank-payout rail (off; see docs/cngn-bank-payouts.md).
web/                Next.js 14 app, MiniPay-first, wagmi + viem.
  app/api/          Server-only routes (phone lookup, cNGN proxy, agent card).
  components/       Screens and shared UI; icons are a self-hosted Material Symbols subset.
  lib/              Config, hooks, formatting, phone, regions, ramp links, x402.
```

---

## Running it

```bash
cp .env.example .env                       # secrets; never commit
deno run --allow-env --allow-read --allow-net scripts/check-env.ts   # what is set, what is missing

cd contracts && forge install && forge test   # 54 passing

cd ..
supabase db push
supabase functions deploy execute-due-runs sync-schedules preflight trigger-run \
  rate-service latam-rate latam-route agent request-payment ai-assist self-verify self-webhook
grep -vE '^(SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY)|TESTING_)' .env \
  | grep -E '^[A-Z0-9_]+=' > .env.functions
supabase secrets set --env-file .env.functions

cd web && cp .env.local.example .env.local && npm install && npm run dev   # localhost:3000
```

- **`.env.functions`, not `.env`.** Supabase rejects the three keys it injects
  itself, and `TESTING_*` holds a funded test key that must never reach a
  deployed function.
- **Enable anonymous sign-in** in the Supabase dashboard (Authentication →
  Sign In / Providers). MiniPay cannot sign messages, so wallets are bound to an
  anonymous session. Without it the app shows nothing
  (`422 anonymous_provider_disabled`).
- **Optional parts fail quietly.** Without `DEEPSEEK_API_KEY` there is no
  "say it"; without `TYPESAFE_API_KEY` failures are classified by rules alone;
  without `SELF_*` there is no identity check; without `ODIS_QUOTA_PRIVATE_KEY`
  phone lookups answer 503; without `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL` the
  history comes from the database alone.
- **`NEXT_PUBLIC_TEST_INTERVALS=1`** adds a five-minute cadence for testing.

Tests:

```bash
cd contracts && forge test
deno test --allow-env supabase/functions/_shared/preflight.test.ts
deno test --allow-env supabase/functions/_shared/failures.test.ts
deno test --allow-env --allow-read --allow-net supabase/functions/_shared/x402.test.ts
deno test --allow-env --unstable-sloppy-imports web/lib/format.test.ts
deno test --unstable-sloppy-imports web/lib/history.test.ts
(cd web && deno test --unstable-sloppy-imports lib/phone.test.ts)
```

`CLAUDE.md` has the full command list and the traps that are not visible from
the code.

---

## Limits and open items

- **V4 is unaudited.** It is live and has paid real schedules, all from our own
  test wallets. Get an audit before inviting real senders at volume.
- **Naira bank payouts are off.** Paying a bank account directly through the
  cNGN API is built but switched off. Instructing payouts to someone else's
  bank account is a money-transmission question for a Nigerian lawyer, and the
  cNGN merchant account still needs KYB. cNGN as a token is live, and
  recipients cash it out themselves on Textile.
  [docs/cngn-bank-payouts.md](docs/cngn-bank-payouts.md) has the rest.
- **Not yet a listed Mini App.** Ordinary MiniPay users cannot open Remesso
  until MiniPay approves it.
- **Gas sets the floor.** A payment costs about 92,000 gas, roughly $0.002 at
  current prices, so a one-cent payment loses about 17% to gas. Early sends are
  limited to once a minute. This is scheduled payment, not streaming.
- **Sender identity is a claim, not a proof.** MiniPay cannot sign messages,
  so a wallet is bound to an anonymous session, and switching wallets moves the
  binding. It shows a schedule list and never moves money: the contract checks
  the signer for everything that does.
- **Schedules do not migrate.** Schedules on V3 and earlier remain on-chain but
  will not run, and a sender must re-create them on V4.
