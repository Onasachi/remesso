# Remesso

**Agent-to-agent remittance rails on Celo: agents pay agents across borders, in the currency the recipient spends, on mandates and spending limits a human signs on-chain.**

Live on Celo mainnet · App: https://remesso.xyz · Docs: https://docs.remesso.xyz · Demo video: https://youtu.be/rxV5KtJocZ8 · Repo: https://bitbucket.org/crackedstudios/remesso

---

## Hackathon tracks

Agents on Open Rails (Loops House × Celo) — Remesso is entered in two tracks:

| Track | Bounties | Why Remesso fits |
|---|---|---|
| **Stable Agents: LatAm** (Ripio × Celo) | 1st and 2nd place | Remittances between agents in all six of Ripio's currencies on Celo mainnet — **wARS, wBRL, wCOP, wMXN, wCLP and wPEN** — with no conversion through dollars: recurring mandates Remesso's agent pays, one-off payments from one agent to another, Ripio's ramp to buy and cash out, and two paid services, `latam-rate` and `latam-route`, that agents pay per call **in pesos, reais or soles**. |
| **Open Corridors: USA₮ with x402** | 1st and 2nd place | Four services sold over **x402** through Celo's facilitator, priced in **USA₮** first (also USDC, USD₮ and the six wFIAT); a published skill that **pays in USA₮ by default**; an agent wallet for Claude, Codex and Cursor that pays any x402 API in USA₮ within on-chain limits; and USA₮ as a remittance currency in MiniPay and in the browser. |

## The problem

Money crosses borders on a rhythm: school fees every term, rent every month, a
parent's allowance every week. More and more of that work is being handed to AI
agents, and there is no rail built for one agent to pay another across a
border.

x402 covers a one-off API call. A remittance needs more: a request the
recipient's side can send, a payment the sender's side makes once and only once
however often it retries, a mandate that repeats, a receipt both sides can
check, and the currency the family actually spends — pesos, reais, soles or
naira, not only dollars. Without that, the options are handing an agent a card
on file or custody of the money.

## What Remesso is

**Agent-to-agent remittance rails on Celo mainnet:** three on-chain primitives,
and everything an agent needs around them. Money never sits with Remesso. Every
payment moves straight from the payer's wallet to the recipient's.

1. **Mandates.** A payer signs one schedule: who, how much, how often, until
   when and in which currency. Remesso's agent carries it out, and nobody — not
   the agent, not us, not the contract owner — can redirect, resize or extend a
   payment. `RemessoExecutorV5` (`0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8`,
   verified).
2. **Spending policies.** A human caps their agent from their own wallet: one
   token, a cap per payment and per day, a total, an expiry, and optionally a
   list of recipients. `RemessoAgentAllowance`
   (`0xA6351fAeEb097698289586C4D6188530300DB209`, verified) has no owner and no
   admin, and a prompt-injected agent hits the same caps as an honest one.
3. **Agent-to-agent payments.** One agent asks to be paid, with a payment
   request or a signed invoice, and the other pays from its own wallet or its
   policy, once per idempotency key. Remesso reads the payment from the chain,
   binds it to the request and sends the recipient's agent a signed webhook.
   Either side can verify the payment from the chain alone.

Around them: identity and discovery (ERC-8004 agent #9879, Self Agent ID #191,
an agent card and a free capability document), four paid x402 services in nine
stablecoins, `remesso-sdk` on npm, agent wallets for Claude, Codex and Cursor,
and the apps — MiniPay, the web and the Claude app — where the humans at each
end sign and see what happened.

### An agent-to-agent remittance, step by step

1. **The recipient's agent asks.** `requests.create`, or a signed invoice, asks
   a payer's wallet for an exact amount in one token, once or every month — say
   20,000 wARS. The request appears in the payer's app, and the payer's agent
   sees it through `payment_requests`.
2. **The payer's agent pays.** `remittances.send` pays it once, from the
   agent's own wallet or from its spending policy, answering the request. For a
   recurring request the payer signs a mandate, and Remesso's agent pays every
   month from then on.
3. **Remesso confirms it from the chain.** The indexer records the payment,
   binds it to the request — from the wallet asked, to the address that asked,
   made after the request — and sends the recipient's agent a signed
   `payment.received`, then `payment.finalized` once Celo finalizes the block.
4. **The recipient's agent checks it.** `receipts.verify` confirms payer,
   recipient, token and amount on the chain, with no key and no trust in
   Remesso. The family receives exactly the token sent, and keeps it or cashes
   out at Ripio or Textile.

Every step has run on Celo mainnet with our own wallets; the transactions are
under Proof on mainnet.

## Remesso's own agent

| | |
|---|---|
| Agent wallet (sends every scheduled payment) | `0xA351d65c15b8a342B6ECbC7f2B9eFE62B17cdb21` |
| ERC-8004 identity held by the agent wallet | agent **#9879** (registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) |
| ERC-8004 identity held by the owner | agent #9867 |
| Proof of a human behind it | Self Agent ID **#191** — soulbound, zero-knowledge passport proof |
| Capabilities (machine-readable, free) | `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` |
| Agent card | https://remesso.xyz/.well-known/agent.json |

It carries out every mandate, whoever created it:

1. Every 5 minutes, `sync-schedules` finds new schedules on-chain, including
   ones another agent or a script created outside the app.
2. Every minute, `execute-due-runs` reads `runnability()` on-chain (due, funded,
   approved), and the agent wallet calls `executeRun`.
3. The contract moves the amount, minus a 0.25% commission fixed at signing, to
   the recipient. Each scheduled payment is at least $1 or its equivalent in
   local currency, so the commission always covers the network fee the agent
   pays to send it.

### What the agent decides — the pre-flight check

Sending a payment that is due is the deterministic part, and should be: the
contract decides whether it may go. The judgement is in what comes before it.
Every 30 minutes, for each payment due in the next day, the agent runs a loop:

1. **Observe**: it reads from Celo mainnet the payer's balance of the payout
   token and how much they have allowed Remesso to move. For a peso or real
   payment it also reads the live Uniswap rate and compares it with its own
   reading from a day earlier.
2. **Decide**: it works out whether this payment will be skipped and why (no
   money, or no permission), whether the payment after it will be, and whether
   a peso payment's dollar value has moved by 3% (info) or 8% (warning). A
   shortfall becomes urgent inside six hours.
3. **Act**: it posts a notice in the payer's app that says by how much the
   payment falls short, with the fix attached: "Add money" in MiniPay, or
   "Allow payments again".
4. **Verify**: on every later pass it checks again and closes its own notice
   once the payer has fixed the problem, or when the schedule is cancelled
   on-chain.

A payment gets fixed before it is due, rather than failing and being explained
afterwards. The agent advises and never touches the money path. Its decision
rules are a pure function pinned by tests
(`supabase/functions/_shared/preflight.ts`), and the words a payer reads are
written in code, not by a model. It reads rates from the same sources as our
paid `latam-rate` service, but does not buy from its own x402 endpoint: paying
ourselves would put circular volume on our own `payTo`.

Every transaction Remesso causes — each payment the agent sends and each
transaction a payer signs in the app or through the SDK — carries an ERC-8021
attribution suffix with both `remesso` and our hackathon code
`celo_5cd35ca55baf`, pinned byte-for-byte to `@celo/attribution-tags` by a
test.

---

## Currencies

Eleven tokens in eight currencies on Celo mainnet. The contract's own allowlist decides what a
schedule may use, and the app and the capability document read it from the
contract, so nothing is offered before the contract accepts it. Ripio's wMXN,
wCLP and wPEN joined on 28 October, the day after Celo's x402 facilitator
listed them.

| Token | Currency | Address | Decimals | Remittances | x402 | In MiniPay |
|---|---|---|---|---|---|---|
| **USD₮** (USDT) | US dollar | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 | ✅ | ✅ | ✅ |
| **USDC** | US dollar | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | 6 | ✅ | ✅ | ✅ |
| **USDm** (formerly cUSD) | US dollar | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | 18 | ✅ | — | ✅ |
| **USA₮** | US dollar | `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771` | 6 | ✅ | ✅ (default) | ✅ |
| **wARS** (Ripio) | Argentine peso | `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` | 18 | ✅ | ✅ | — |
| **wBRL** (Ripio) | Brazilian real | `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` | 18 | ✅ | ✅ | — |
| **wCOP** (Ripio) | Colombian peso | `0x8a1D45e102e886510e891d2Ec656a708991e2D76` | 18 | ✅ | ✅ | — |
| **wMXN** (Ripio) | Mexican peso | `0x337E7456B420bD3481e7FA61fA9850343d610d34` | 18 | ✅ | ✅ | — |
| **wCLP** (Ripio) | Chilean peso | `0x61D450a098b6a7f69fC4b98CE68198fe59768651` | 18 | ✅ | ✅ | — |
| **wPEN** (Ripio) | Peruvian sol | `0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE` | 18 | ✅ | ✅ | — |
| **cNGN** | Nigerian naira | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` | 6 | ✅ | — | — |

Remittances use the **Direct** rail: the recipient receives exactly the token
the payer sends. No swap, no conversion, no price risk. A peso remittance pays
pesos; a USA₮ remittance pays USA₮.

**A peso is not a dollar**, and code written for dollar stablecoins assumes it
is. The backend's per-payment safety cap is scaled per currency and rounded so
it only ever gets stricter, only dollar tokens count in balance totals and in
the unusual-payment check, and the backend refuses any token it does not know
rather than guess its decimals.

---

## For developers: remesso-sdk

```bash
npm install remesso-sdk
```

`remesso-sdk` puts the rails in a TypeScript library for Celo mainnet,
documented at https://docs.remesso.xyz: an app or agent can pay another agent,
ask to be paid and know when it was, in a few lines. 0.1.0 and 0.2.0 shipped on
25 October, 0.3.0 on 26 October.

- **Agent-to-agent payments.** `remittances.send` pays another agent one exact
  amount, from the agent's own wallet or from a spending policy on
  `RemessoAgentAllowance`, and can answer that agent's payment request. Each
  payment takes an idempotency key: a retry continues the same payment and
  never pays twice, and "nothing was paid" is said only when the chain proves
  it.
- **Getting paid.** Payment requests, signed invoices, payment events read from
  the chain, signed webhooks with retries, and `receipts.verify`, which checks a
  payment from the chain alone.
- **Mandates and policy payments**, refused before signing when they would be
  valid on-chain but never run.
- **Builder codes (ERC-8021).** An app's own code rides on its transactions and
  on every payment Remesso's agent sends for the schedules it created, so Celo
  credits that volume to the app.
- **Gas in stablecoins.** A wallet without CELO pays gas in USDT, USDC, USDm or
  USA₮ through Celo's fee abstraction.
- **A local fork.** `npx remesso-sdk dev` runs both kinds of payment against a
  fork of Celo.
- **Built to be retried.** Two rounds of code review before 0.3.0 found ways a
  retry could pay twice or stall a signer that the tests had missed. Each is
  fixed with a regression test, and the SDK has 186 tests.

**The receiving side, live since 25 October.**

- An indexer reads every payment, schedule and policy of `RemessoExecutorV5`
  and `RemessoAgentAllowance` from the chain. An event is final once Celo
  finalizes its block, and a reorg marks events removed rather than deleting
  them.
- A payment request counts as paid only with an indexed payment from the wallet
  asked, to the address that asked, made after the request.
- Webhooks: `payment.received`, `payment.finalized` and `payment.removed`,
  signed as Standard Webhooks and retried with the same id for 24 hours.
  Subscribing is signed by the receiving address.

**Docs and Build with AI (25–26 October).**

- https://docs.remesso.xyz has guides, six use cases built end to end and an API
  reference. Every code sample is type-checked against the SDK, and the token
  and contract tables come from the deployment manifest, never typed by hand.
- Build with AI: the same pages as https://docs.remesso.xyz/llms.txt,
  `llms-full.txt` and a `remesso-sdk` skill for coding assistants
  (`npx -y remesso-wallet skills`), generated from the pages so they can't
  disagree.

**Proven on mainnet, 26 October** (our own test wallets, not user volume):

- Our first wallet-funded agent-to-agent payment: a one-off payment request
  paid from the payer's own wallet with `remesso-sdk`, 1 USDC to the recipient:
  https://celoscan.io/tx/0xafa1e88d30c1305ddf7483bed8c488a1f66575f31f42cb03974dcaba133e7e6b
- A payment by Remesso's agent carrying an app's builder code (our test code
  `remesso_e2e`):
  https://celoscan.io/tx/0xc3619d9ed86ae80dcc1bb453ed1d5754b2f7410dfa6e22a528c258cad0299248
- An agent payment through a spending policy, 0.02 USDC:
  https://celoscan.io/tx/0xded8e872ff020d2d53a642fbef883d9cf89d95177bf2412a09d22d0b675b2906
- Gas paid in USDC by a wallet holding no CELO:
  https://celoscan.io/tx/0x3d0632e6abc3912ab4cdde08a69ab6ab9ea5624d8e35c65ecd5277caa7d58a80
- The run also found that Celo's public RPC can answer a read pinned to a block
  from a node that hasn't reached it yet. The SDK now reads again until the node
  catches up.

---

## Agent wallets: Claude, Codex and Cursor

### Claude Code, Codex, Cursor and any MCP host

```
/plugin marketplace add https://bitbucket.org/crackedstudios/remesso.git
/plugin install remesso@remesso
```

The Remesso wallet gives an agent money of its own on Celo, so it can pay
people, other agents and x402 APIs, and ask to be paid. What it cannot do is
spend more than its human allowed: the limits live in a contract, not in the
prompt. It is a Claude Code plugin, and the same wallet runs in Codex, Cursor
and any MCP host from npm as
[`remesso-wallet`](https://www.npmjs.com/package/remesso-wallet)
(`npx -y remesso-wallet`). Every host on one machine shares one agent key, so a
policy linked in Claude Code works in Cursor and Codex too.

- **The agent's key is generated on the user's machine** and never reaches the
  model. No tool returns it.
- **The human sets the limits from their own wallet** on
  `remesso.xyz/agent-wallet`, in MiniPay or a browser wallet, and
  `RemessoAgentAllowance` enforces them. The money stays in the human's wallet
  until a payment moves it, and Stop on the same page ends the policy at once.
- **Agent to agent:** `find_agent` resolves another agent's wallet from the
  ERC-8004 registry; `pay` pays it once; `pay_x402` pays its x402 API in USA₮,
  USDC or USD₮, never above a maximum the user sets, topping the agent up
  through the same policy so those payments pass the caps too;
  `request_payment` asks it to pay on a Remesso mandate; `payment_requests`
  shows what others ask the human to pay, and `decline_request` turns one down
  with a signature.
- **Ten tools** in all — `wallet`, `await_setup`, `link_policy`, `limits`,
  `pay`, `payment_requests`, `decline_request`, `pay_x402`, `request_payment`,
  `find_agent` — plus remesso-sdk's tools to quote, check and verify a payment.
  The SDK's tools that pay stay off unless the host turns them on.
- **A retried payment pays once.** The wallet pays through `remesso-sdk`:
  every payment takes an idempotency key, and the signed
  transaction is recorded before it is broadcast, so an agent whose call timed
  out can try again without paying twice.
- It installs Remesso's four skills, and every transaction carries the
  `remesso` and `celo_5cd35ca55baf` attribution tags.

### The Claude app

In the Claude app (claude.ai on the web, the desktop app, iPhone and Android),
Remesso is a connector: add `https://remesso.xyz/mcp` once under Customize →
Connectors. Ask "Send Mum 20 USDT every month" and Claude prepares a link to a
prefilled form that the person checks and signs in their own wallet, with no
sign-in and no keys. It also answers "what am I paying?" from the contract.

For hands-free payments, the person signs in with a code sent to their email,
gets an agent wallet they own with Remesso as its only signer, and sets a cap
per payment and per day once, from their own wallet, through
`RemessoAgentAllowance`. Claude then pays on request, asking before each
payment, and `remesso.xyz/agent/stop` ends it. Steps: https://remesso.xyz/claude

---

## x402: four services, nine stablecoins

Remesso sells four services to other agents over **x402**, through **Celo's
facilitator** (`https://api.x402.celo.org`). Each has one price in dollars,
payable in **USA₮, USDC or USD₮**, or in **any of Ripio's six currencies** at
the same price — an agent working in pesos pays in pesos. The facilitator
submits every payment and pays its gas, so **the payer needs no CELO**, in any
of the nine.

| Service | Endpoint | Price | What it does |
|---|---|---|---|
| `naira-rate` | `POST /functions/v1/rate-service` | 0.001 | Live USDT/NGN and USDC/NGN — bid, ask, last; mid and spread only when both sides are quoted (never invented) |
| `latam-rate` | `POST /functions/v1/latam-rate` | 0.001 | USD-to-wARS and USD-to-wBRL from two independent on-chain sources side by side — Textile's RFQ makers and the Uniswap pool on Celo at your size, with price impact — flagged when they disagree by more than 1%. wCOP, wMXN, wCLP and wPEN: "no on-chain market on Celo", never priced from elsewhere |
| `latam-route` | `POST /functions/v1/latam-route` | 0.002 | How to deliver pesos, reais or soles to Argentina, Brazil, Colombia, Mexico, Chile or Peru: the token, the dollars it takes and the best venue at that size, Ripio's buy and cash-out links and a prefilled Remesso mandate link. Moves nothing |
| `trigger-run` | `POST /functions/v1/trigger-run` | 0.01 | Brings one payment of a mandate forward, only if its payer allowed early sends. It takes the place of the next scheduled payment — the payer never pays more often than they signed |

- **Nine stablecoins, one price.** USDC, USD₮ and USA₮ settle from an EIP-3009
  authorisation, the same number of base units in each. Ripio's wARS, wBRL,
  wCOP, wMXN, wCLP and wPEN take the same dollar price in local currency and
  settle through Permit2: the payer signs a Permit2 transfer and an EIP-2612
  permit, and the facilitator lands both inside the settlement. Live since 28
  October: `latam-rate` paid with 1.5 wARS, the facilitator paying the gas
  (`0xcff27a83…e846`).
- **Paid to (payTo):** `0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2` — the same
  on every service and in every currency, confirmed from the live 402s.
- **How x402 activity is credited.** Attribution tags are not yet supported on
  x402 settlements, so the hackathon credits x402 by this payTo address. It is
  the owner of the earlier contracts; since V5 the 0.25% commission goes to a
  separate treasury (`0x2dA4…F134`), so every payment into payTo is an x402
  settlement submitted by Celo's facilitator (`0x0d74D5Ce…FB48`). Every one to
  date is our own test (listed under Proof on mainnet).
- **x402 v2 on the wire**, v1 still accepted: the price list rides in the
  `PAYMENT-REQUIRED` header, the payment in `PAYMENT-SIGNATURE`, the receipt in
  `PAYMENT-RESPONSE`. We moved to v2 after measuring that the official
  `@x402/fetch` refused v1 sellers — every agent using the standard SDK could
  not have paid us.
- **Built on Textile's quotes.** `naira-rate`, `latam-rate` and `latam-route`
  read Textile FX's live maker quotes (`api.textilecredit.com/tickers`), and the
  pre-flight agent falls back to them when the Uniswap pool cannot answer. We
  use them as prices, never as a payment route. Every answer sets Textile beside
  the Uniswap pool, because a maker can stop quoting one side.
- **The LatAm services read the market, not a table.** On live data, 20,000 ARS
  costs about $12.48 of USDT through the Uniswap pool; at $5,000 the wBRL pool
  loses 1.2% to price impact, so `latam-route` picks Textile's makers instead
  and `latam-rate` flags the split. Ripio is linked, not integrated — its
  public ramp, no partnership implied.
- **Nobody pays for a failure.** `trigger-run` checks the mandate on-chain and
  answers 403 *before quoting a price* if the call could not succeed. The order
  is verify → simulate → settle → run: a run that would revert charges nothing
  (409), and settling before the run means one payment buys exactly one run.
- **Builder code, ready for when tags arrive.** Every 402 already declares the
  x402 `builder-code` extension (`{"a":"remesso","s":["celo_5cd35ca55baf"]}`),
  verified identical to `@x402/extensions`, so settlements will carry our tag
  once Celo's facilitator supports it. Until then, payTo is what counts.
- **Verified with the official client.** `@x402/fetch` + `@x402/evm` 2.28.0 pay
  our endpoints in USA₮ at default settings, and in wARS through Permit2 once
  the asset is allowed; a test runs that client against our own 402.

## Agent skills

Four skills, installed by any agent with one command:

```bash
npx -y remesso-wallet skills                    # remesso, remesso-x402, remesso-wallet, remesso-sdk into ~/.agents/skills
npx -y remesso-wallet skills ~/.claude/skills   # the same, for Claude Code
```

`remesso` is the integration guide, `remesso-wallet` drives the agent wallet
above, and `remesso-sdk` gives coding assistants the SDK's full documentation.

**`remesso-x402` pays in USA₮ by default.** It installs:

- `SKILL.md` — the services, payment terms, a code sample and the mistakes that
  cost money on Celo (fee adapters that share a token's symbol, EIP-712 names
  that are not the symbol, v2 headers, a peso that is not a dollar).
- `scripts/pay.mjs` — a ready-to-run payer on the official x402 client:

  ```bash
  npm i @x402/fetch@2.28.0 @x402/evm@2.28.0 viem
  PAYER_KEY=0x… node scripts/pay.mjs --service naira-rate                # pays in USA₮
  PAYER_KEY=0x… node scripts/pay.mjs --service latam-rate --asset wARS   # pays in pesos
  PAYER_KEY=0x… node scripts/pay.mjs --service latam-route --body '{"country":"MX","amount":2000}'
  PAYER_KEY=0x… node scripts/pay.mjs --service naira-rate --asset USDC   # opt out of USA₮
  ```

  It chooses the token by address, refuses any quote above `--max` (in
  dollars, default 0.05) before signing, and stops before signing if the wallet
  holds none of the token.
- `manifest.json` — the payment terms as data: network `eip155:42220`, payee,
  facilitator, **`defaultAsset` = USA₮**, each token's address, decimals,
  transfer method and EIP-712 domain, and every service's price in each
  currency. It is **generated from the live 402**, never typed by hand, and
  `--check` fails if it drifts. An index of the skills (`skills/manifest.json`)
  and a JSON Schema for the format (`skills/manifest.schema.json`) sit beside
  it.

The skills are also served from the app (`/skills/manifest.json`,
`/skill.md`) and linked from the agent card.

---

## For the humans at each end: MiniPay and the web

Agents move the money; people sign the mandates and the limits, and see what
happened. Remesso meets them where they already are.

### MiniPay

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
  supports — USDT, USDC, USDm and **USA₮** (added the day MiniPay's own deposit
  screen listed it) — and call USDm by MiniPay's name for it.
- **The assistant understands numbers too.** "Send 20 USDT to +234 803 123
  4567 every month" fills the whole form. The phone number is cut out in the
  browser before the sentence goes to the language model — the model sees
  `[recipient]`, never a person's number — and then looked up exactly as if
  typed.

Status: built and tested through MiniPay's developer mode. Remesso is not yet a
listed Mini App, so ordinary MiniPay users cannot open it until MiniPay
approves it; that submission is our next step.

### The web

In any browser with a Celo wallet (MetaMask, Valora, Rabby…), Remesso offers
everything MiniPay's rules leave out.

- **Every currency on the contract's allowlist**, including USA₮, cNGN and
  Ripio's pesos, reais and soles, read live from the contract.
- **Ripio on- and off-ramp.** Choosing a Ripio token shows "Buy it with Ripio"
  (from a local bank account) and "Cash out at Ripio", prefilled with country,
  Celo, token and wallet. We also bought wARS on Celo itself, through Uniswap's
  0.01% USDT/wARS pool.
- **Naira cash-out, linked.** For a USDT payment, the form and the schedule
  page show a Nigerian recipient how to get naira into their bank account on
  Textile: swap USDT to cNGN on Celo, then Withdraw NGN (paid out by Noblocks).
  It is a link, as with Ripio. The recipient does it from their own wallet, and
  Remesso never instructs a bank payout. A mandate can also pay in **cNGN**
  directly. The home screen has "Get cNGN" (swap USDT on Textile) and
  "Withdraw to bank" (Textile's Withdraw NGN).
- **Wallet addresses**, typed or pasted, with a copy button on each schedule.
- **Pay links.** `/schedules/new?to=…&amount=…&token=…&every=…` opens a
  prefilled form; the form says a link filled it in, and the payer still
  reviews and signs every field. Our invite links are built this way.
- **Payment requests.** Anyone — a person or an agent — can ask to be paid
  (`POST /functions/v1/request-payment`, free); the request appears on the
  payer's home screen as a prefilled form. It can never create a payment, and
  only the payer's own signature declines it.
- **"Or just say it".** Describe the payment in a sentence and the form fills
  in. Every field is shown for review before signing; ambiguous readings are
  flagged, and an unusual schedule (amount, rhythm, new recipient) gets a
  warning before it is signed.
- **Schedule pages** with the next payment countdown, pause, resume and cancel,
  the full payment history, and — when the payer allows it — who may send a
  payment early.
- **Optional identity check** with Self (passport, 18+, sanctions list) shown as
  a badge; it never gates a payment.

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
| ERC-8004 agent #9879 registered from the agent wallet of the time (`0x3c75…9Cd1`; moved to the V5 agent wallet on 2026-10-16, below) | `0xc806f21d…bad5` |
| **First peso payment by the agent:** a 1,000 wARS weekly schedule created outside the app was found and paid within 5 minutes, unprompted — 997.5 wARS to the recipient, 2.5 wARS fee | `0x4eaf6976…9cdc` |
| x402 payments in USA₮ through the official SDK (run twice) | `0x084c5027…ab39`, `0x5780ab21…d38d` |
| x402 payment in USA₮ through the `remesso-x402` skill script | `0xf91d3465…d6f9`, `0x15167882…d6f8` |
| `latam-rate` and `latam-route` paid in USA₮ through the skill script | `0x24d0ea8d…713a`, `0x86706193…d328` |
| An outside developer installed `remesso-x402` from GitHub and paid in USA₮ on their own — with test funds we provided | `0xa5d6eceb…aca2` |
| **RemessoExecutorV5 deployed (2026-10-16)**, fixing the findings of a security review of V4, verified on Celoscan | `0x95a9ddcc…6a07` |
| ERC-8004 #9879 moved to the V5 agent wallet `0xA351…cdb21`, which signed for it as `agentWallet`; both entries' metadata updated to V5 | `0xa8e717d6…0c3c`, `0xaa0bda8b…1b34`, `0x15a8dec9…c3e4`, `0x28d3eb9d…f3b6` |
| First payment on V5 (our own test, to our own MiniPay wallet): 1 USA₮ schedule created in the app, confirmed from the chain, paid by the agent 30 seconds later | `0xecc53e43…05b2`, `0x4ef1b459…2e72` |
| **RemessoAgentAllowance deployed (2026-10-19)**, verified on Celoscan | `0x0b80f355…dc1e` |
| Claude plugin end to end (our test wallets): a policy of 0.05 USDT per payment, a payment, then an x402 call that topped the agent up through the policy and was settled by Celo's facilitator | `0xfaebbb07…69d8`, `0x8451f5c8…ecdc`, `0x627789be…3210` |
| First payment from the installed plugin, in Claude Code: 0.2 USA₮ under a policy set on `/agent-wallet` (our own test) | `0xa8e70f5f…bd56` |
| Hands-free payment from the Claude app (2026-10-20): 1 USD₮ from our wallet, signed by its hosted agent within the policy we set | `0x085558a7…644f` |
| A payment by the agent carrying an app's builder code (our test code `remesso_e2e`), 2026-10-26: 1 USDC to the recipient | `0xc3619d9e…9248` |
| An agent payment through a spending policy, sent with remesso-sdk: 0.02 USDC | `0xded8e872…2906` |
| Gas paid in USDC by a wallet holding no CELO | `0x3d0632e6…8a80` |
| **First wallet-funded agent-to-agent payment** (remesso-sdk 0.3.0, 2026-10-26): a one-off payment request paid from the payer's own wallet, 1 USDC to the recipient | `0xafa1e88d…7e6b` |
| wMXN, wCLP and wPEN allowed on the contract (2026-10-28) | `0x2fc36144…3a94`, `0x90d56db5…6601`, `0xa81c0996…f5b4` |
| **First x402 payment in pesos** (2026-10-28): `latam-rate` paid with 1.5 wARS through Permit2, settled by Celo's facilitator, which paid the gas | `0xcff27a83…e846` |

## What we built during the hackathon (from 2026-10-06)

- **Agent-to-agent payments, end to end:** `remesso-sdk` on npm (0.1.0 to
  0.3.0) with payments from a wallet or a policy, requests, invoices, payment
  events, signed webhooks and on-chain receipts; our first wallet-funded
  agent-to-agent payment on mainnet on 2026-10-26.
- **The receiving side:** every payment read from the chain into payment
  events, a request counted as paid only on an on-chain payment, and signed
  webhooks.
- **All six of Ripio's currencies** on the live contract's allowlist — wARS,
  wBRL and wCOP, then wMXN, wCLP and wPEN — with USA₮ and cNGN; the form and the
  agent document read the allowlist from the chain.
- **x402 in nine stablecoins:** our services take USA₮, USDC, USD₮ and the six
  wFIAT, gas-free for the payer through Celo's facilitator, Permit2 for the
  pesos; our first x402 payment in wARS settled on 2026-10-28.
- **An agent wallet** for Claude Code, Codex and Cursor whose spending is capped
  on-chain by `RemessoAgentAllowance`, a setup page for the limits, and ten
  tools for paying, paying x402 APIs, answering payment requests, finding
  agents on ERC-8004 and asking to be paid. A retried payment pays once.
- **Remesso in the Claude app:** a connector that prepares payments for the
  person to sign, and pays hands-free within caps they sign.
- **Developer docs** at docs.remesso.xyz, every code sample type-checked
  against the SDK, and Build with AI.
- Builder codes: an app's ERC-8021 code rides on every payment of the
  schedules it creates.
- Two paid services, `latam-rate` and `latam-route`, for pricing and routing
  peso, real and sol remittances on Celo — a bad request is refused before any
  price is quoted, and a source outage charges nothing.
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
- MiniPay: contact picker, phone numbers through ODIS with a 245-country picker,
  no addresses on screen, MiniPay's four tokens only (USA₮ included), USDm
  naming, phone numbers kept away from the AI model.
- Ripio buy and cash-out links; per-currency safety caps and totals.
- Attribution on every transaction with both codes; the x402 builder-code
  extension; ERC-8004 agent #9879 held by the agent wallet.
- x402 v2 verified with the official SDK; the public agent document corrected
  to say v2 and listing all four paid services; the `remesso-x402` skill, its
  script and its generated manifest, USA₮ by default.
- Terms of Service and a Privacy Policy, linked from every page.

Commits from `a10658d` onward. The contract, the agent loop and x402 selling
predate the hackathon and are described in the README.
