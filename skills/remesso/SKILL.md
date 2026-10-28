---
name: remesso
description: Send, receive and schedule stablecoin payments on Celo as an autonomous agent. Use this when an agent needs to pay for an API in USDC, USD₮, USA₮ or Ripio's local-currency tokens over x402, ask a human or another agent to pay it on a recurring schedule, commit its own wallet to paying someone on a schedule, or bring a scheduled payment forward. Covers the live mainnet endpoints, the contract reads that verify any claim made here, and the decimal and EIP-712 traps that silently cost money on Celo.
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
| **Pay** for a service | USDC, USD₮, USA₮ or a Ripio wFIAT on Celo | CELO — the facilitator pays settlement gas |
| **Pay** on a schedule | USDC/USDT/USDm/USA₮, wARS/wBRL/wCOP/wMXN/wCLP/wPEN or cNGN **and** ~0.06 CELO | — you submit these two transactions yourself |

## With the Remesso wallet installed: use its tools

If the Remesso wallet is installed, you already have a wallet: the
`remesso-wallet` tools
`wallet`, `await_setup`, `link_policy`, `limits`, `pay`, `pay_x402`, `request_payment` and
`find_agent`. **Use them instead of the code below.** They spend from the user's
wallet only within a `RemessoAgentAllowance` policy the user set on-chain (a cap
per payment and per day, and an expiry), and the key never passes through the
conversation. A policy has no total of its own: every policy on a token draws on
the one approval the user gave the contract. The `remesso-wallet` skill says how
to use them.

It installs as a plugin in Claude Code (`/plugin marketplace add
https://bitbucket.org/crackedstudios/remesso.git`, then `/plugin install remesso@remesso`) and as the
`remesso-wallet` MCP server everywhere else: `npx -y remesso-wallet` in
Codex, Cursor or any MCP host.

## Writing code: the SDK

An agent or app you write in TypeScript can use `remesso-sdk` (`npm install
remesso-sdk viem`): schedules, agent payments that pay once per idempotency
key, one-off payments between agents, payment requests, payment events and
signed webhooks, with the deployment's addresses, tokens, fee and per-payment
limits built in. To write or review code with it, load the `remesso-sdk`
skill: it holds every page of the documentation at `https://docs.remesso.xyz`,
which is also one file at `https://docs.remesso.xyz/llms-full.txt`.
`https://remesso.xyz/developers` gets you from install to a small payment
and its webhook.

## In the Claude app, on a phone or the web: use the connector's links

The local wallet runs only on a computer. In the Claude app the plugin brings
the `remesso` connector instead, which holds no keys: `prepare_payment` turns
a payment or a schedule into a link the user signs in their own wallet, and
`list_schedules`, `check_wallet`, `request_payment` and `find_agent` read or
ask. It needs the user's `0x…` address to read anything; it has no login.

Never ask a user to paste a private key or seed phrase into the conversation.
The `PAYER_KEY` examples below are for agents running their own code without
the wallet, with a wallet that holds only what they are willing to lose.

## Addresses and endpoints

| | |
|---|---|
| Contract | `RemessoExecutorV5` `0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8` (Celo mainnet, 42220) |
| Start here | `https://remesso.xyz/.well-known/agent.json` — every endpoint, the contract, the registrations |
| Capabilities | `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` — prices and refusals, free |
| This file | `https://remesso.xyz/skill.md` |
| ERC-8004 | agent `9879`, held by the agent wallet that sends every payment (`0xA351d65c15b8a342B6ECbC7f2B9eFE62B17cdb21`); agent `9867`, held by the owner. Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Proof of human | Self Agent ID `191`, soulbound, zero-knowledge passport proof |
| Source | https://bitbucket.org/crackedstudios/remesso |

The capability document is free because discovery that costs money is discovery
nobody does. Read it first; it is generated from what is deployed, so it is
current in a way this file may not be.

## Paying for a service

A focused skill for this, with a tested script and a `manifest.json` of
assets and prices generated from the live 402, is `remesso-x402`
(`npx -y remesso-wallet skills`).

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
| `/functions/v1/latam-route` | 0.002 | A route to deliver pesos, reais or soles: venue, dollars needed, Ripio links, schedule link |
| `/functions/v1/trigger-run` | 0.01 | Bring one payment of an existing schedule forward |

Prices are in dollars, payable in **USDC, USD₮ or USA₮** (the same number of
base units in each, because all three are 6dp) or in **Ripio's wARS, wBRL,
wCOP, wMXN, wCLP or wPEN** (the same price in local currency, at 18dp). The
402 lists them all; the selector above picks one. The wFIAT settle through
Permit2, gasless for the payer too: the `remesso-x402` skill shows the two
settings a client needs for them.

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

**A requested amount is what you receive.** The payer's form adds Remesso's
0.25% on top, so asking for 5 means 5 arrives.

### Knowing you were paid

Accepted is not paid. Only a payment with a transaction is, and that is the
thing to check before you release anything.

- **Your request's status:** `POST …/request-payment` with
  `{"action":"status","id":"<request id>"}` says pending, accepted,
  accepted_with_changes, declined or expired, and lists each payment's
  transaction. A payer's agent answers your request by paying with its
  `reference` in the memo, or by reporting the schedule with `"action":"answer"`.
- **Your payment events:** `GET …/payment-events?address=0xYou&role=to` lists
  every run and policy payment to you, read from the chain. Each says whether
  it is `final`, and a reorg marks one `removed` instead of dropping it. Pass
  the answer's `next` back as `after` to see only what changed.
- **Webhooks:** `POST …/webhooks` subscribes an HTTPS endpoint, signed by your
  wallet (EIP-712; `GET` it for the typed data). Your endpoint must echo a
  challenge first. Deliveries use the Standard Webhooks headers, carry
  `payment.received`, `payment.finalized` or `payment.removed`, keep the same
  `webhook-id` across retries for 24 hours, and say whether the payment is final.

**Tell payers what you accept.** Add a `remesso` entry to your ERC-8004
registration's `services`, listing the tokens you take and whether a payment
must carry your request's reference
([docs/AGENTS.md](https://bitbucket.org/crackedstudios/remesso/src/main/docs/AGENTS.md)).
A payer's agent pays only `getAgentWallet(agentId)`, never an address from the
file.

## Paying on a schedule

[`examples/create-schedule.ts`](https://bitbucket.org/crackedstudios/remesso/src/main/examples/create-schedule.ts)
in the repository (not shipped in the plugin) signs the mandate from your own
wallet. This is the one flow that needs **CELO for gas** — an approval and the
schedule, submitted by you rather than a facilitator.

```bash
TO=0xRecipient AMOUNT=1 TOKEN=USDT EVERY=week RUNS=2 TRIGGER=remesso \
PAYER_KEY=... deno run --allow-env --allow-net create-schedule.ts
```

Each transfer must be at least a dollar's worth (1 USDT, 1,500 wARS, 1,300
cNGN; `/agent` lists them under `limits.perRun`). A smaller schedule is valid
on-chain and the executor never sends it.

`TRIGGER=remesso` grants the `CURRENT_EXECUTOR` sentinel (`0x…0001`), which
lets Remesso's executor — whichever key that is — bring a payment forward on request —
worth setting, because a schedule created directly on-chain is discovered by a
sync that runs every five minutes, and until then only a trigger can move it.

**The fee comes out of the schedule's amount, not on top.** At 25bps a 1 USDT
transfer costs the payer exactly 1; the recipient receives 0.9975. A
payment request names what the recipient receives, so to meet one, schedule the
gross: the smallest amount whose net is the request (the fee rounds up). 5
asked is 5.012532 scheduled.

## Verify rather than believe

Every claim in this file is checkable, and the contract is the only authority.

```bash
cast call 0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8 \
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
  wARS, wBRL, wCOP, wMXN, wCLP and wPEN are 18dp. A wFIAT amount is pesos,
  reais or soles, not dollars.
- **v2 uses headers, not the body.** The price list arrives in
  `PAYMENT-REQUIRED`, the payment goes back in `PAYMENT-SIGNATURE`, the receipt
  comes in `PAYMENT-RESPONSE`. v1's body-and-`X-PAYMENT` shape is still
  accepted.

## What it refuses, and why

- `403` from `trigger-run` if the payer never authorised early sending, if the
  grant is spent, or within 60 seconds of the last one — **before quoting a
  price**, because nobody should pay to discover a call would fail.
- `403` for a schedule that converts to cNGN (the swap and bank-payout rails).
  Those rails are built and switched off pending regulatory work. A schedule
  that pays cNGN as it is, on the Direct rail, is allowed like any other.
- `409` if the payment reverts on-chain — the caller is not charged.
- `429` once a payer has 10 payment requests waiting.

## Limits, measured rather than claimed

`RemessoExecutorV5` is **live on mainnet and unaudited**, and so is
`RemessoAgentAllowance` (`0xA6351fAeEb097698289586C4D6188530300DB209`), which
holds the plugin wallet's spending policies. It holds a spending
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
