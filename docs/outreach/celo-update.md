# Update to the Celo team — Remesso

**Subject:** Remesso — what changed since we entered Agents on Open Rails

Hi Celo team,

A progress update on **Remesso** (https://remesso.crackedstudios.xyz), our
entry in Agents on Open Rails (Stable Agents: LatAm, and Open Corridors:
USA₮ with x402). Since we entered on 6 October, Remesso has grown from a
dollar-only remittance agent into a multi-currency product, live on Celo
mainnet, that both people and agents can use.

**Remesso in one line:** a sender signs one on-chain mandate (who, how much,
how often, until when) and Remesso's agent pays it on Celo, every week or
month, without asking again and without ever holding the money.

Demo (2 min): https://youtu.be/AD8JhgAlb9c · Repo: https://github.com/crackedstudio/Remesso

---

### 1. From four currencies to eight, with no redeploy

The contract's allowlist (`setDirectToken`) let us add currencies without
touching a signed schedule:

- **Ripio's wARS, wBRL and wCOP** (6 Oct) — remittances to Argentina, Brazil
  and Colombia paid in pesos and reais, never converted through dollars.
- **USA₮** (11 Oct), offered in MiniPay too.
- **cNGN** (14 Oct), for Nigeria.

A peso is not a dollar, so the backend's safety caps are now scaled per
currency, and any token the backend does not know is refused.

### 2. Paid in cNGN and pesos, on mainnet

- **First peso payment:** a 1,000 wARS schedule, created outside the app,
  found by the agent within 5 minutes and paid with nobody pressing a button
  (`0x4eaf6976…9cdc`).
- **First cNGN payments:** a 1,500 cNGN schedule paid twice, 1,496.25 cNGN
  delivered each time (`0x90423b80…8bd0`, `0xb8051faa…fce9`).

All of these are our own test wallets, and we label them that way.

### 3. MiniPay-native recipients

Inside MiniPay a recipient is now a **contact** (`minipay_requestContact`)
or a **phone number**, resolved through **ODIS + FederatedAttestations**,
trusting only MiniPay's issuer. There are no addresses on screen, a country
picker covers 245 countries, and only masked numbers are stored. The
"say it" assistant understands phone numbers and keeps them away from the
model.

### 4. An agent that thinks ahead

New **pre-flight agent**: every 30 minutes it looks at each payment due in
the next day. It observes balance, allowance and, for pesos, the rate
against its own reading a day earlier. It decides whether the payment will
be skipped, acts by posting a notice with the fix attached, and verifies by
closing the notice once the sender has fixed it. Its rules are pinned by
tests, and it never touches the money path.

### 5. Celo's agent stack, used properly

- **x402 v2** through Celo's facilitator, verified with the official
  `@x402/fetch` + `@x402/evm` 2.28.0 paying in **USA₮**. We moved off v1
  after finding the official SDK refused v1 sellers.
- **Four paid services** (was one): `naira-rate`, `latam-rate`,
  `latam-route` and `trigger-run`, priced in USA₮, USDC and USD₮. The rate
  services are built on **Textile FX's** live maker quotes, cross-checked
  against the Uniswap pools on Celo.
- **Agent skills:** `npx skills add crackedstudio/Remesso --skill
  remesso-x402`, which pays in **USA₮ by default**. Its manifest is generated
  from the live 402 responses, so it cannot drift.
- **ERC-8004 identity #9879**, held by the wallet that sends every payment,
  plus **Self Agent ID #191** as proof of a human behind it.
- **ERC-8021 attribution** on every transaction, carrying `remesso` and our
  code `celo_5cd35ca55baf`, and the x402 `builder-code` extension declared
  in every 402, ready for when the facilitator writes it.

### 6. Local currency in and out, through partners

- **Ripio:** buy and cash-out links for pesos and reais, prefilled with the
  right wallet.
- **Textile:** "Get cNGN" (swap USDT) and "Withdraw to bank" for naira, paid
  out by Noblocks. Following Textile's guidance that the bank account must
  belong to the person selling, **recipients cash out to their own
  account** — Remesso never pays a third party's bank.

### 7. A redesigned app

The app has a new design: currencies grouped by Dollars, Latin America and
Nigeria, with flags and an "In MiniPay" label; a compact three-step form;
and a signing view that shows exactly which wallet prompt comes next.

---

### Where we would value your help

1. **MiniPay listing.** We are submitting Remesso for MiniPay Discovery. An
   introduction or a review slot would help us put it in front of the users
   it was built for.
2. **Attribution credit.** Every transaction carries the `remesso` code.
   Could it be registered on the dashboard so its activity is credited?
3. **x402 builder-code.** Our 402s declare the `builder-code` extension.
   When the facilitator writes Schema 2 tags (x402-rs#99), we would like to
   be among the first to test it.
4. **First real users.** We are onboarding our first senders now. Any
   community, Telegram group or event where people support family across
   borders would be a great place to start.

Thank you for the rails. Remesso exists because Celo made scheduled,
agent-run payments cheap enough to be worth sending.

[Your name]
Cracked Studio · Remesso
