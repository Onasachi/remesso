## What it is

Remesso sends money home on a schedule, in the currency the family actually spends. A sender signs one on-chain mandate — who gets paid, how much, how often, until when — and Remesso's agent carries it out on Celo mainnet without asking again. Neither Remesso nor anyone else can redirect, resize or extend a payment: the contract (`RemessoExecutorV4`, `0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009`) enforces the mandate, and the agent's key can only trigger a payment the sender already authorised.

## Who it is for

Families split across borders. Someone in the diaspora paying a parent in Argentina, Brazil or Colombia every month today converts through the dollar and pays a fee at each step. With Remesso the sender funds in pesos or reais and the family receives exactly that — no conversion — and both sides move between the bank and the token through Ripio.

## What we built during the hackathon (from 2026-10-06)

- **Pesos and reais on mainnet.** Ripio's wARS, wBRL and wCOP were added to the live contract's allowlist on 2026-10-06 (txs `0x717cc22c…`, `0x482172a7…`, `0xbed93797…`), rehearsed first on a mainnet fork. The send form and our public agent document read that allowlist from the contract, so nothing is offered before it is real.
- **USA₮ for schedules.** Allowed on the live contract on 2026-10-11 (tx `0xf3292694…9e5a`), alongside USDT, USDC and USDm.
- **Ripio on- and off-ramp.** When a sender picks a wFIAT, the form links Ripio's ramp — buy wARS from a local bank account, and cash out the same way — prefilled with country, Celo, token and wallet.
- **A peso is not a dollar.** Code written for dollar stablecoins assumed 1 token = $1. We fixed the per-run safety cap (now scaled per currency, failing toward refusal), balance totals and the risk check, and made the backend refuse any token it does not know.
- **Attribution on every transaction.** Every executor run and every transaction a sender signs carries our hackathon tag alongside our own, pinned byte-for-byte to `@celo/attribution-tags`.
- **Builder code on x402.** Our paid endpoints declare the x402 `builder-code` extension (verified identical to `@x402/extensions`), so settlements through Celo's facilitator tag themselves as soon as it ships support.
- **Agent identity held by the agent wallet.** ERC-8004 agent **#9879**, registered from the executor that sends every run.
- **Proven on mainnet with pesos.** Our own test run on 2026-10-11: a 1,000 wARS weekly schedule created outside the app (schedule #8) was discovered and paid by the agent in under five minutes with no one triggering it — 997.5 wARS to the recipient, 2.5 wARS fee, one tagged transaction (`0x4eaf6976…9cdc`). wARS was bought on Celo itself, through Uniswap's USDT/wARS pool.
- **Pay a contact or a phone number, not an address.** MiniPay forbids typing or showing wallet addresses, so inside MiniPay a sender picks the recipient from their MiniPay contacts, or types their number with a country picker covering 245 countries. Numbers resolve to MiniPay wallets through Celo's ODIS and FederatedAttestations, trusting only MiniPay's issuer; only a masked number is stored, and a number typed into the AI box is removed before the sentence reaches the model.
- **MiniPay-ready.** Inside MiniPay only USDT, USDC and USDm are offered, no address is ever displayed, and cUSD is called USDm as MiniPay names it. Every other currency stays available from a browser wallet, and the landing page says so.

Commits: `a10658d`, `dda9809`, `668b82e`, `65cb225`, `041e7be`, `8b4f822`, `24f829e`, `7ce6f9f`, `ebc3729`, `1aaeb38`, `aba7696` (and later). Earlier work — the contract, the executor, x402 selling — predates the hackathon and is described in the README.

## USA₮ and x402

Remesso sells over x402 through Celo's facilitator, priced in USDC, USD₮ or USA₮: `trigger-run` lets an agent bring a scheduled payment forward for $0.01, and `rate-service` sells live NGN rates for $0.001. x402 settlements are paid to `0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2`. Since 2026-10-11 USA₮ is also a schedule currency, so a sender can pay family in USA₮ on a schedule from a browser wallet.

## Addresses

- Agent wallet (executor, sends every run): `0x3c754AD31e802D5fA65487f460dED65Aba749Cd1`
- ERC-8004: agent #9879 (also #9867, held by the owner); Self Agent ID #191
- Contract: `0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009` (verified, unaudited)
- App: https://remesso-3q67.vercel.app · Agent document: `/functions/v1/agent`
