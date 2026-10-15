# Update to the Celo team — Remesso

**Subject:** Remesso — progress since our last meeting

Hi Celo team,

Thank you again for the time at our last meeting. We wanted to follow up
with where **Remesso** (https://remesso.crackedstudios.xyz) stands now.

**Remesso in one line:** a sender signs one on-chain mandate — who, how much,
how often, until when — and Remesso's agent pays it on Celo every week or
month, without asking again and without ever holding the money.

Since we last spoke, Remesso has grown from a dollar-only remittance agent
into a multi-currency product, live on Celo mainnet, that serves Latin
America and Nigeria as well as MiniPay's dollar users, and that both people
and agents can use.

Demo (2 min): https://youtu.be/AD8JhgAlb9c · Repo: https://github.com/crackedstudio/Remesso

---

### 1. Latin American payments: pesos and reais

Families sending money to Argentina, Brazil or Colombia usually convert
through dollars first and pay a spread at each step. Remesso now pays them
in their own currency, end to end.

- **Ripio's wARS, wBRL and wCOP** are allowed on the contract
  (`setDirectToken`, no redeploy). A sender funds in pesos or reais, and the
  recipient receives exactly that, with nothing converted.
- **Getting pesos in and out** goes through Ripio's ramp. Remesso links
  "Buy" and "Cash out", prefilled with the country, Celo, the token and the
  right wallet.
- **First peso payment on mainnet:** a 1,000 wARS schedule, created outside
  the app, was found by the agent within 5 minutes and paid with nobody
  pressing a button. The recipient received 997.5 wARS (`0x4eaf6976…9cdc`).
- **A peso is not a dollar**, so the backend's safety caps are now scaled per
  currency, and any token the backend does not know is refused.

### 2. Nigeria: cNGN

- **cNGN is now a payout currency** (allowed on the contract on 14 Oct,
  `0x68ad32f6…3296`). A sender can pay someone in naira on a schedule.
- **First cNGN payments on mainnet:** a 1,500 cNGN schedule paid twice by
  the agent, 1,496.25 cNGN delivered each time (`0x90423b80…8bd0`,
  `0xb8051faa…fce9`).
- **Into and out of naira, through Textile.** "Get cNGN" swaps USDT for cNGN
  on Textile FX, and "Withdraw to bank" sends cNGN to a Nigerian bank
  account, paid out by Noblocks at about ₦1 per cNGN. Recipients paid in USDT
  can cash out to naira the same way.
- **Compliant by design.** Following Textile's guidance that a payout bank
  account must belong to the person selling, Remesso pays tokens into the
  recipient's wallet, and **the recipient cashes out to their own account.**
  Remesso never pays naira into a third party's bank.

### 3. Identity with Self

- **Senders can verify with Self** from the home screen: a passport-based
  check (OFAC screening, 18+) done on their phone with a zero-knowledge
  proof. Remesso receives the result, never the passport and no personal
  data, and a verified sender gets a badge. It is optional and gates
  nothing, so nobody is locked out of paying their family.
- **The agent itself is verified.** Remesso is registered with **Self Agent
  ID #191**, soulbound to our owner wallet, so a real human stands behind the
  key that moves money, rather than an anonymous key.
- **ERC-8004 identity #9879** is held by the wallet that sends every
  payment, so the agent's identity and its transactions are the same
  address.

### 4. MiniPay-native recipients

Inside MiniPay a recipient is now a **contact** (`minipay_requestContact`)
or a **phone number**, resolved through **ODIS + FederatedAttestations** and
trusting only MiniPay's issuer.

- **No wallet address on screen**, anywhere in MiniPay.
- **A country picker** covers 245 countries.
- **Only masked numbers are stored** (`+234 706 ••• 1245`).
- **The "say it" assistant** ("Send 20 USDT to +234 … every month")
  understands phone numbers and keeps them away from the language model.
- **USDT, USDC, USDm and USA₮** are offered in MiniPay, matching its Deposit
  screen.

### 5. An agent that thinks ahead

A new **pre-flight agent** runs every 30 minutes on each payment due in the
next day:

1. **Observe:** the sender's balance and allowance and, for pesos, the rate
   against its own reading a day earlier.
2. **Decide:** whether the payment will be skipped, and why.
3. **Act:** post a notice in the sender's app with the fix attached ("Add
   money", "Allow payments again").
4. **Verify:** close the notice once it is fixed.

Its rules are pinned by tests, and it never touches the money path.

### 6. Celo's agent stack

- **x402 v2** through Celo's facilitator, verified with the official
  `@x402/fetch` + `@x402/evm` 2.28.0 paying in **USA₮**.
- **Four paid services** (was one): `naira-rate`, `latam-rate`,
  `latam-route` and `trigger-run`, priced in USA₮, USDC and USD₮. The rate
  services are built on **Textile FX's** live maker quotes, cross-checked
  against the Uniswap pools on Celo.
- **Agent skills:** `npx skills add crackedstudio/Remesso --skill
  remesso-x402` pays in **USA₮ by default**. Its manifest is generated from
  the live 402 responses, so it cannot drift.
- **ERC-8021 attribution** on every transaction Remesso causes, and the x402
  `builder-code` extension declared in every 402.

### 7. A redesigned app

The app has a new design:

- **Currencies grouped** by Dollars, Latin America and Nigeria, with flags
  and an "In MiniPay" label.
- **A compact three-step form.**
- **A signing view** that shows exactly which wallet prompt comes next.

All the mainnet transactions above are from our own wallets while we test,
and we label them that way.

---

### Where we would value your help

1. **MiniPay listing.** We are submitting Remesso for MiniPay Discovery. An
   introduction or a review slot would help us put it in front of the users
   it was built for.
2. **Attribution credit.** Every transaction carries the `remesso` code.
   Could it be registered on the dashboard so its activity is credited?
3. **x402 builder-code.** Our 402s declare the `builder-code` extension.
   When the facilitator writes Schema 2 tags, we would like to be among the
   first to test it.

Thank you for the rails, and for the guidance so far. Remesso exists because
Celo made scheduled, agent-run payments cheap enough to be worth sending.

[Your name]
Cracked Studio · Remesso
