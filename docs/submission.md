# Remesso

**Send money home on a schedule, in the currency your family spends — signed once, carried out by an agent on Celo.**

Live on Celo mainnet · App: https://remesso.crackedstudios.xyz · Demo video: https://youtu.be/AD8JhgAlb9c · Repo: https://github.com/crackedstudio/Remesso

---

## Hackathon tracks

Agents on Open Rails (Loops House × Celo) — Remesso is entered in two tracks:

| Track | Bounties | Why Remesso fits |
|---|---|---|
| **Stable Agents: LatAm** (Ripio × Celo) | 1st and 2nd place | Remittances to Argentina, Brazil and Colombia paid in Ripio's **wARS, wBRL and wCOP** by an agent on Celo mainnet — no conversion through dollars — with Ripio's ramp to buy and cash out, and two paid services, `latam-rate` and `latam-route`, that price and route peso and real payments. |
| **Open Corridors: USA₮ with x402** | 1st and 2nd place | Four services sold over **x402** through Celo's facilitator, priced in **USA₮** (also USDC and USD₮), a published agent skill that **pays in USA₮ by default**, and USA₮ as a schedule currency — in a browser wallet and in MiniPay. |

## The problem

Families split across borders pay each other on a rhythm — school fees every
term, rent every month, a parent's allowance every week. Today that is a chore
repeated by hand, and for Argentina, Brazil or Colombia it usually means
converting through dollars and paying a spread at each step. Automating it
normally means handing a company custody of the money or a card on file.

## What Remesso is

A sender signs **one on-chain mandate**: who gets paid, how much, how often and
until when. From then on **Remesso's agent** carries it out on Celo mainnet —
every week or every month — without asking again.

The agent can only do what was signed. The mandate lives in our contract,
`RemessoExecutorV5` (`0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8`, verified),
and **nobody — not the agent, not us, not the contract owner — can redirect,
resize or extend a payment**. The sender can pause, resume or cancel at any
time from their wallet. Money never sits with us: each payment moves straight
from the sender's wallet to the recipient's, through an allowance the sender
grants and can revoke.

How a payment happens:

1. The sender approves the token and calls `createSchedule` — two transactions
   in their own wallet.
2. Every 5 minutes, `sync-schedules` finds new schedules on-chain, including
   ones created outside the app (by a script or another agent).
3. Every minute, `execute-due-runs` checks which schedules are due, reads
   `runnability()` on-chain (due, funded, approved), and the agent wallet
   calls `executeRun`.
4. The contract moves the amount — minus a 0.25% fee, fixed at signing — to the
   recipient, and the app shows the receipt.

## The agent

| | |
|---|---|
| Agent wallet (sends every payment) | `0xA351d65c15b8a342B6ECbC7f2B9eFE62B17cdb21` |
| ERC-8004 identity held by the agent wallet | agent **#9879** (registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) |
| ERC-8004 identity held by the owner | agent #9867 |
| Proof of a human behind it | Self Agent ID **#191** — soulbound, zero-knowledge passport proof |
| Capabilities (machine-readable, free) | `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` |
| Agent card | https://remesso.crackedstudios.xyz/.well-known/agent.json |

### What the agent decides — the pre-flight check

Sending a payment that is due is the deterministic part, and should be: the
contract decides whether it may go. The judgement is in what comes before it.
Every 30 minutes, for each payment due in the next day, the agent runs a loop:

1. **Observe**: it reads from Celo mainnet the sender's balance of the payout
   token and how much they have allowed Remesso to move. For a peso or real
   payment it also reads the live Uniswap rate and compares it with its own
   reading from a day earlier.
2. **Decide**: it works out whether this payment will be skipped and why (no
   money, or no permission), whether the payment after it will be, and whether
   a peso payment's dollar value has moved by 3% (info) or 8% (warning). A
   shortfall becomes urgent inside six hours.
3. **Act**: it posts a notice in the sender's app that says by how much the
   payment falls short, with the fix attached: "Add money" in MiniPay, or
   "Allow payments again".
4. **Verify**: on every later pass it checks again and closes its own notice
   once the sender has fixed the problem, or when the schedule is cancelled
   on-chain.

The result is that a payment gets fixed before it is due, rather than failing
and being explained afterwards. The agent advises and never touches the money
path. The decision rules are a pure function pinned by tests
(`supabase/functions/_shared/preflight.ts`), and the words a sender reads are
written in code, not by a model. It reads rates from the same sources as our
paid `latam-rate` service, but does not buy from its own x402 endpoint: paying
ourselves would put circular volume on our own `payTo`.

Every transaction Remesso causes — each payment the agent sends and each
transaction a sender signs in the app — carries an ERC-8021 attribution suffix
with both `remesso` and our hackathon code `celo_5cd35ca55baf`, pinned
byte-for-byte to `@celo/attribution-tags` by a test.

---

## Tokens we support

All on Celo mainnet. The contract's own allowlist decides what a new schedule
may use; the app and the agent document read that allowlist rather than a list
of ours, so nothing is offered before the contract accepts it.

| Token | Currency | Address | Decimals | In MiniPay | In a browser wallet | x402 |
|---|---|---|---|---|---|---|
| **USD₮** (USDT) | US dollar | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 | ✅ | ✅ | ✅ |
| **USDC** | US dollar | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | 6 | ✅ | ✅ | ✅ |
| **USDm** (formerly cUSD) | US dollar | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | 18 | ✅ | ✅ | — |
| **USA₮** | US dollar | `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771` | 6 | ✅ | ✅ | ✅ (default) |
| **wARS** (Ripio) | Argentine peso | `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` | 18 | — | ✅ | — |
| **wBRL** (Ripio) | Brazilian real | `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` | 18 | — | ✅ | — |
| **wCOP** (Ripio) | Colombian peso | `0x8a1D45e102e886510e891d2Ec656a708991e2D76` | 18 | — | ✅ | — |
| **cNGN** | Nigerian naira | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` | 6 | — | ✅ | — |

Schedules use the **Direct** rail: the recipient receives exactly the token the
sender funds with. No swap, no conversion, no price risk. A peso schedule pays
pesos; a USA₮ schedule pays USA₮.

**A peso is not a dollar**, and code written for dollar stablecoins assumed it
was. We scaled the backend's per-payment safety cap per currency (rounded so
it only ever gets stricter), count only dollar tokens in balance totals and in
the unusual-payment check, and made the backend refuse any token it does not
know rather than guess its decimals.

---

## MiniPay integration

Remesso runs inside MiniPay as a Mini App, built to MiniPay's own rules.

- **Connects by itself.** MiniPay is detected and the wallet connects
  automatically — no connect button, no wallet picker.
- **Pay a contact.** "Choose from contacts" opens **MiniPay's own contact
  picker** (`minipay_requestContact`). MiniPay matches the contact to their
  MiniPay wallet on the device, so no phone number ever reaches us, and the
  contact's name fills "Who is this for?".
- **Or type a phone number — never an address.** MiniPay forbids typing,
  pasting or displaying wallet addresses, so inside MiniPay the recipient is a
  phone number. A **country picker with all 245 countries** (Nigeria, Ghana,
  Kenya, South Africa, Uganda, Tanzania, Cameroon and Ethiopia first; the last
  choice remembered) lets people type numbers the local way — `0706 765 1245`
  in Nigeria becomes `+234 706 765 1245`. No country is ever guessed.
- **Phone → wallet through Celo's identity layer.** Our server resolves the
  number with **ODIS** and **FederatedAttestations**, trusting only MiniPay's
  own attestation issuer (`0x7888…7FBc`), so a number maps to the MiniPay
  account its owner registered. Only a masked number is stored
  (`+234 706 ••• 1245`); the full number is stored and logged nowhere. Lookups
  are metered at 20 per user per day, because each one is paid and reveals
  whose wallet a number is. If a number has no MiniPay account, the form offers
  a WhatsApp invite instead.
- **No address on screen, anywhere.** Inside MiniPay a recipient is shown by
  name or masked number — never an address, truncated or not.
- **MiniPay's tokens only.** Inside MiniPay we offer exactly the four MiniPay
  supports — USDT, USDC, USDm and **USA₮** (added the day MiniPay's own
  deposit screen listed it) — and call USDm by MiniPay's name for it.
- **The assistant understands numbers too.** "Send 20 USDT to +234 803 123
  4567 every month" fills the whole form. The phone number is cut out in the
  browser before the sentence goes to the language model — the model sees
  `[recipient]`, never a person's number — and then looked up exactly as if
  typed.

Status: built and tested through MiniPay's developer mode. Remesso is not yet a
listed Mini App, so ordinary MiniPay users cannot open it until MiniPay
approves it; that submission is our next step.

## Web integration

In any browser with a Celo wallet (MetaMask, Valora, Rabby…), Remesso offers
everything MiniPay's rules leave out.

- **All eight tokens**, including USA₮, cNGN and Ripio's pesos and reais. The landing
  page tells visitors so, with the list read live from the contract.
- **Ripio on- and off-ramp.** Choosing wARS, wBRL or wCOP shows "Buy it with
  Ripio" (from a local bank account) and "Cash out at Ripio", prefilled with
  country, Celo, token and wallet. We also bought wARS on Celo itself, through
  Uniswap's 0.01% USDT/wARS pool.
- **Naira cash-out, linked.** For a USDT payment, the form and the schedule
  page show a Nigerian recipient how to get naira into their bank account on
  Textile: swap USDT to cNGN on Celo, then Withdraw NGN (paid out by Noblocks).
  It is a link, as with Ripio. The recipient does it from their own wallet,
  and Remesso never instructs a bank payout. A schedule can also pay in **cNGN**
  directly. The home screen has "Get cNGN" (swap USDT on Textile) and
  "Withdraw to bank" (Textile's Withdraw NGN).
- **Wallet addresses**, typed or pasted, with a copy button on each schedule.
- **Pay links.** `/schedules/new?to=…&amount=…&token=…&every=…` opens a
  prefilled form; the form says a link filled it in, and the sender still
  reviews and signs every field. Our invite links are built this way.
- **Payment requests.** Anyone — a person or an agent — can ask to be paid on a
  schedule (`POST /functions/v1/request-payment`, free); the request appears on
  the payer's home screen as a prefilled form. It can never create a payment.
- **"Or just say it".** Describe the payment in a sentence and the form fills
  in. Every field is shown for review before signing; ambiguous readings are
  flagged, and an unusual schedule (amount, rhythm, new recipient) gets a
  warning before it is signed.
- **Schedule pages** with the next payment countdown, pause, resume and cancel,
  the full payment history, and — when the sender allows it — who may send a
  payment early.
- **Optional identity check** with Self (passport, 18+, sanctions list) shown as
  a badge; it never gates a payment.

---

## x402 integration

Remesso sells four services to other agents over **x402**, through **Celo's
facilitator** (`https://api.x402.celo.org`). The paying agent signs a token
authorisation; the facilitator submits it and pays the gas, so **the payer needs
no CELO**.

| Service | Endpoint | Price | What it does |
|---|---|---|---|
| `naira-rate` | `POST /functions/v1/rate-service` | 0.001 | Live USDT/NGN and USDC/NGN — bid, ask, last; mid and spread only when both sides are quoted (never invented) |
| `latam-rate` | `POST /functions/v1/latam-rate` | 0.001 | USD-to-wARS and USD-to-wBRL from two independent on-chain sources side by side — Textile's RFQ makers and the Uniswap pool on Celo at your size, with price impact — flagged when they disagree by more than 1%. wCOP: "no on-chain market on Celo", never priced from elsewhere |
| `latam-route` | `POST /functions/v1/latam-route` | 0.002 | How to deliver pesos or reais: the token, the dollars it takes and the best venue at that size, Ripio's buy and cash-out links and a prefilled Remesso schedule link. Moves nothing |
| `trigger-run` | `POST /functions/v1/trigger-run` | 0.01 | Brings one payment of a schedule forward, only if its sender allowed early sends |

- **Currencies:** USDC, USD₮ and **USA₮**, at the same price in each (all 6dp).
- **Paid to (payTo):** `0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2` — the same
  on every service and every currency, confirmed from the live 402s.
- **How x402 activity is credited.** Attribution tags are not yet supported on
  x402 settlements, so the hackathon credits x402 by this payTo address. It is
  the owner of the earlier contracts; since V5 the 0.25% schedule commission
  goes to a separate treasury (`0x2dA4…F134`), so every payment into payTo is
  an x402 settlement — the ones Celo's facilitator (`0x0d74D5Ce…FB48`) submits
  as `transferWithAuthorization`. Every one to date is our own test (listed under
  Proof on mainnet).
- **x402 v2 on the wire**, v1 still accepted: the price list rides in the
  `PAYMENT-REQUIRED` header, the payment in `PAYMENT-SIGNATURE`, the receipt in
  `PAYMENT-RESPONSE`. We moved to v2 after measuring that the official
  `@x402/fetch` refused v1 sellers — every agent using the standard SDK could
  not have paid us.
- **Built on Textile's quotes.** `naira-rate`, `latam-rate` and `latam-route`
  read Textile FX's live maker quotes (`api.textilecredit.com/tickers`), and the
  pre-flight agent falls back to them when the Uniswap pool cannot answer. So we
  can honestly say Remesso is built on Textile's quotes. We use them as prices,
  never as a payment route. Every answer sets Textile beside the Uniswap pool,
  because a maker can stop quoting one side and Textile has no wCOP pair.
- **The LatAm services read the market, not a table.** On live data, 20,000
  ARS costs about $12.48 of USDT through the Uniswap pool; at $5,000 the wBRL
  pool loses 1.2% to price impact, so `latam-route` picks Textile's makers
  instead and `latam-rate` flags the split. Ripio is linked, not integrated —
  its public ramp, no partnership implied.
- **Nobody pays for a failure.** `trigger-run` checks the schedule on-chain and
  answers 403 *before quoting a price* if the call could not succeed. The order
  is verify → simulate → settle → run: a run that would revert charges nothing
  (409), and settling before the run means one payment buys exactly one run.
- **Builder code, ready for when tags arrive.** Every 402 already declares the
  x402 `builder-code` extension (`{"a":"remesso","s":["celo_5cd35ca55baf"]}`),
  verified identical to `@x402/extensions`, so settlements will carry our tag
  once Celo's facilitator supports it. Until then, payTo is what counts.
- **Verified with the official client.** `@x402/fetch` + `@x402/evm` 2.28.0 at
  default settings paid our endpoint in USA₮ on mainnet — USA₮ is inside the
  SDK's default spend controls on Celo, so agents need no extra configuration.

## Agent skills

Two skills, installable by any agent with one command:

```bash
npx skills add crackedstudio/Remesso --skill remesso-x402   # pay our x402 services
npx skills add crackedstudio/Remesso --skill remesso        # schedules, being paid, the contract
```

**`remesso-x402` pays in USA₮ by default.** It installs:

- `SKILL.md` — the services, payment terms, a code sample and the mistakes that
  cost money on Celo (fee adapters that share a token's symbol, EIP-712 names
  that are not the symbol, v2 headers).
- `scripts/pay.mjs` — a ready-to-run payer on the official x402 client:

  ```bash
  npm i @x402/fetch@2.28.0 @x402/evm@2.28.0 viem
  PAYER_KEY=0x… node scripts/pay.mjs --service naira-rate            # pays in USA₮
  PAYER_KEY=0x… node scripts/pay.mjs --service latam-rate --body '{"usd":250}'
  PAYER_KEY=0x… node scripts/pay.mjs --service latam-route --body '{"country":"AR","amount":20000}'
  PAYER_KEY=0x… node scripts/pay.mjs --service naira-rate --asset USDC  # opt out of USA₮
  ```

  It chooses the token by address, refuses any quote above `--max` (default
  0.05) before signing, and stops before signing if the wallet holds no USA₮,
  saying how to pay in USDC or USD₮ instead.
- `manifest.json` — the payment terms as data: network `eip155:42220`, payee,
  facilitator, **`defaultAsset` = USA₮**, each token's address, decimals and
  EIP-712 domain, and all four services with their prices. It is **generated
  from the live 402**, never typed by hand, and `--check` fails if it drifts. An index of
  both skills (`skills/manifest.json`) and a JSON Schema for the format
  (`skills/manifest.schema.json`) sit beside it.

The skills are also served from the app (`/skills/manifest.json`,
`/skill.md`) and linked from the agent card.

---

## Proof on mainnet

All of these are **our own test transactions**. Remesso has no independent
users yet, and we do not count any of the payments below as volume.

| What | Transaction |
|---|---|
| wARS, wBRL, wCOP allowed on the contract (2026-10-06) | `0x717cc22c…`, `0x482172a7…`, `0xbed93797…` |
| USA₮ allowed on the contract (2026-10-11) | `0xf3292694…9e5a` |
| cNGN allowed on the contract (2026-10-14) | `0x68ad32f6…3296` |
| **First cNGN payments by the agent:** schedule #11, 1,500 cNGN every 5 minutes (testing), twice. 1,496.25 cNGN to the recipient and a 3.75 cNGN fee each time | `0x90423b80…8bd0`, `0xb8051faa…fce9` |
| ERC-8004 agent #9879 registered from the agent wallet | `0xc806f21d…bad5` |
| **First peso payment by the agent:** a 1,000 wARS weekly schedule created outside the app was found and paid within 5 minutes, unprompted — 997.5 wARS to the recipient, 2.5 wARS fee | `0x4eaf6976…9cdc` |
| x402 payments in USA₮ through the official SDK (run twice) | `0x084c5027…ab39`, `0x5780ab21…d38d` |
| x402 payment in USA₮ through the `remesso-x402` skill script | `0xf91d3465…d6f9`, `0x15167882…d6f8` |
| `latam-rate` and `latam-route` paid in USA₮ through the skill script | `0x24d0ea8d…713a`, `0x86706193…d328` |
| An outside developer installed `remesso-x402` from GitHub and paid in USA₮ on their own — with test funds we provided | `0xa5d6eceb…aca2` |
| **RemessoExecutorV5 deployed (2026-10-16)**, fixing the findings of a security review of V4, verified on Celoscan | `0x95a9ddcc…6a07` |
| ERC-8004 #9879 moved to the V5 agent wallet `0xA351…cdb21`, which signed for it as `agentWallet`; both entries' metadata updated to V5 | `0xa8e717d6…0c3c`, `0xaa0bda8b…1b34`, `0x15a8dec9…c3e4`, `0x28d3eb9d…f3b6` |
| First payment on V5 (our own test, to our own MiniPay wallet): 1 USA₮ schedule created in the app, confirmed from the chain, paid by the agent 30 seconds later | `0xecc53e43…05b2`, `0x4ef1b459…2e72` |

## What we built during the hackathon (from 2026-10-06)

- Ripio's wARS, wBRL and wCOP, then USA₮, on the live contract's allowlist; the
  form and agent document read the allowlist from the chain.
- Ripio buy and cash-out links; per-currency safety caps and totals.
- Attribution on every transaction with both codes; the x402 builder-code
  extension.
- ERC-8004 agent #9879 held by the agent wallet.
- MiniPay: contact picker, phone numbers through ODIS with a 245-country picker,
  no addresses on screen, MiniPay's four tokens only (USA₮ included), USDm naming, phone
  numbers kept away from the AI model.
- Web: every token on the landing page and the form, read from the contract.
- x402 v2 verified with the official SDK in USA₮.
- Two new paid services, `latam-rate` and `latam-route`, for pricing and
  routing peso and real remittances on Celo — a bad request is refused before
  any price is quoted, and a source outage charges nothing.
- The public agent document corrected to say x402 v2 (it still said v1) and
  listing all four paid services.
- The `remesso-x402` skill, its script and its generated manifest, USA₮ by
  default.
- The pre-flight agent: observe, decide, act and verify on every upcoming
  payment, with notices in the app that carry their own fix.
- A security review of the live contract, and `RemessoExecutorV5` fixing what
  it found: an early send now takes the place of a scheduled payment instead of
  adding one, a grant to the agent follows key rotation, and the commission can
  no longer round to zero. Deployed with a fresh agent wallet, owner and
  treasury; the ERC-8004 identity moved with the agent wallet.
- The backend hardened from the same review: the database mirror can only be
  written from what the chain says, a paid early send is settled before it runs
  (one payment, one run), and paid answers are released only after settlement.

Commits from `a10658d` onward. The contract, the agent loop and x402 selling
predate the hackathon and are described in the README.
