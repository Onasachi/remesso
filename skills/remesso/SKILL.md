---
name: remesso
description: Send, receive and schedule stablecoin payments on Celo as an autonomous agent. Use this when an agent needs to pay for an API in USDC, USD₮ or USA₮ over x402, ask a human or another agent to pay it on a recurring schedule, commit its own wallet to paying someone on a schedule, or bring a scheduled payment forward. Covers the live mainnet endpoints, the contract reads that verify any claim made here, and the decimal and EIP-712 traps that silently cost money on Celo.
license: MIT
---

# Remesso — recurring stablecoin payments on Celo, for agents

Remesso is a payment rail an agent can use without an account, an API key or a
signup. A payer signs a **mandate** on-chain: a fixed amount, to a fixed
address, on a fixed cadence. After that the recipient, the amount and the
schedule cannot be changed by anyone — not the payer, not the operator, not the
contract owner. Cancelling is the only edit.

Three things an agent can do, and they are independent:

| | needs | does not need |
|---|---|---|
| **Be paid** by a schedule | an address | gas, a balance, an account, any software |
| **Pay** for a service | USDC, USD₮ or USA₮ on Celo | CELO — the facilitator pays settlement gas |
| **Pay** on a schedule | USDC/USDT/USDm/USA₮ or wARS/wBRL/wCOP **and** ~0.06 CELO | — you submit these two transactions yourself |

## Addresses and endpoints

| | |
|---|---|
| Contract | `RemessoExecutorV4` `0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009` (Celo mainnet, 42220) |
| Start here | `https://remesso-3q67.vercel.app/.well-known/agent.json` — every endpoint, the contract, the registrations |
| Capabilities | `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` — prices and refusals, free |
| This file | `https://remesso-3q67.vercel.app/skill.md` |
| ERC-8004 | agent `9867`, registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Proof of human | Self Agent ID `191`, soulbound, zero-knowledge passport proof |
| Source | https://github.com/crackedstudio/Remesso |

The capability document is free because discovery that costs money is discovery
nobody does. Read it first; it is generated from what is deployed, so it is
current in a way this file may not be.

## Paying for a service

A focused skill for this, with a tested script and a `manifest.json` of
assets and prices generated from the live 402, is `remesso-x402`
(`npx skills add crackedstudio/Remesso --skill remesso-x402`).

These endpoints speak **x402 v2**, so the standard client works with no
Remesso-specific code:

```bash
npm i @x402/fetch @x402/evm viem
```

```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`);
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";

// The SELECTOR chooses the currency. Without it the SDK takes the first entry
// in `accepts`, and Celo USDC is a built-in default asset — so a wallet holding
// both pays in USDC while its owner believes `allowedAssets` chose otherwise.
// `allowedAssets` is a ceiling on what may be spent, not a choice of what.
const client = new x402Client((_v, reqs) => reqs.find((r) => r.asset === USDC) ?? reqs[0]);
client.setSpendControls({
  allowedAssets: [{ network: "eip155:42220", asset: USDC, maxAmountPerPayment: "10000" }],
});
client.register("eip155:*", new ExactEvmScheme(account, { rpcUrl: "https://forno.celo.org" }));

const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch(
  "https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service",
  { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
);
```

**Always treat the 402 as the price**, never a figure published anywhere —
including in this file. A plain POST with no payment header returns it for free.

### Services

| Service | Price | What you get |
|---|---|---|
| `/functions/v1/agent` | free | Capabilities, prices, refusals |
| `/functions/v1/request-payment` | free | Ask someone to pay you on a schedule |
| `/functions/v1/rate-service` | 0.001 | Live USDT/NGN and USDC/NGN from on-chain RFQ makers |
| `/functions/v1/latam-rate` | 0.001 | USD-to-wARS and USD-to-wBRL from RFQ makers and the Uniswap pool, side by side |
| `/functions/v1/latam-route` | 0.002 | A route to deliver pesos or reais: venue, dollars needed, Ripio links, schedule link |
| `/functions/v1/trigger-run` | 0.01 | Bring one payment of an existing schedule forward |

Prices are in **USDC, USD₮ or USA₮** — the same number of base units in each,
because all three are 6dp. The 402 lists them; the selector above picks one.

## Being paid

Receiving takes an address and nothing else. You need no gas, no balance and no
code: the payer and the executor carry every cost. The only problem is getting
your address to a payer, and there are three ways.

**Ask directly.** Free, and it appears in the payer's app:

```bash
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment \
  -H 'content-type: application/json' \
  -d '{"payer":"0xTheirWallet","to":"0xYourAddress","amount":"5",
       "token":"USDT","every":"week","runs":4,"from":"your name","note":"why"}'
```

**Send a link.** `…/schedules/new?to=0xYou&amount=5&every=week` opens their form
with the fields filled in. **Or just tell them the address.**

None of these creates anything. Every route ends with the payer signing
`createSchedule` in their own wallet. A request prefills a form; it cannot
approve an allowance, move a token, or oblige anyone to pay you.

## Paying on a schedule

`examples/create-schedule.ts` in the repo signs the mandate from your own
wallet. This is the one flow that needs **CELO for gas** — an approval and the
schedule, submitted by you rather than a facilitator.

```bash
TO=0xRecipient AMOUNT=0.05 TOKEN=USDT EVERY=week RUNS=2 TRIGGER=remesso \
PAYER_KEY=... deno run --allow-env --allow-net create-schedule.ts
```

`TRIGGER=remesso` lets Remesso's executor bring a payment forward on request —
worth setting, because a schedule created directly on-chain is discovered by a
sync that runs every five minutes, and until then only a trigger can move it.

**The fee comes out of the payment, not on top.** At 25bps a 0.05 transfer
costs the payer exactly 0.05; the recipient receives 0.049875.

## Verify rather than believe

Every claim in this file is checkable, and the contract is the only authority.

```bash
cast call 0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009 \
  "getSchedule(uint256)" <id> --rpc-url https://forno.celo.org
# runnability(uint256)                     is a payment due, funded, allowed
# triggerability(uint256,address)          may `caller` collect early
```

`destination`, `amountIn` and `interval` in that struct are what will happen.
If an endpoint and the contract disagree, the contract is right.

## Facts you must not get wrong

- **`extra.name` is not the symbol.** USA₮ signs as `Tether America USD`
  (version `1`), USDT as `Tether USD`. Take the EIP-712 domain from the 402's
  `extra`, never from a symbol.
- **Match assets by address.** USD₮, USDC and USA₮ each have an 18-decimal
  fee-currency adapter on Celo reporting the **same `symbol()`** as the real
  6-decimal token — USA₮'s is `0x0357EE22278c922e1D36cFe6b899269b161880C4`,
  USD₮'s is `0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72`. Pricing against an
  adapter is an error of 10¹². USD₮'s symbol is also literally `USD₮`, not
  `USDT`.
- **Decimals are not uniform.** USDC, USD₮ and USA₮ are 6dp; USDm (formerly cUSD) and Ripio's
  wARS, wBRL and wCOP are 18dp. A wFIAT amount is pesos or reais, not dollars.
- **v2 uses headers, not the body.** The price list arrives in
  `PAYMENT-REQUIRED`, the payment goes back in `PAYMENT-SIGNATURE`, the receipt
  comes in `PAYMENT-RESPONSE`. v1's body-and-`X-PAYMENT` shape is still
  accepted.

## What it refuses, and why

- `403` from `trigger-run` if the payer never authorised early sending, if the
  grant is spent, or within 60 seconds of the last one — **before quoting a
  price**, because nobody should pay to discover a call would fail.
- `403` for any schedule paying out in cNGN. Those rails are built and switched
  off pending regulatory work; everything settles in stablecoins today.
- `409` if the payment reverts on-chain — the caller is not charged.
- `429` once a payer has 10 payment requests waiting.

## Limits, measured rather than claimed

`RemessoExecutorV4` is **live on mainnet and unaudited**. It holds a spending
allowance the moment a payer approves it. That is worth knowing before pointing
real money at it.

Gas is the real floor, measured on our own transactions: a scheduled payment is
~91,875 gas (~$0.0017 at 202 gwei with CELO near $0.09), an x402 settlement
~85,800 in USDC and ~87,500 in USA₮, and creating a schedule ~224,000 (~$0.004).
So a one-cent payment loses roughly 17% to gas, and a few cents is the honest
minimum. The facilitator pays the settlement gas, which is why a tenth of a cent
works for an API call and not for a mandate.

`MIN_TRIGGER_GAP` is 60 seconds, so this is per-minute granularity rather than
per-call streaming. Sub-cent streaming is payment channels, and this is not
that.
