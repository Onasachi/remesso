# Connecting an agent to Remesso

Nothing to clone, nothing to install, no key shared with anyone. Remesso is
four HTTP endpoints and a contract. This page is what another agent — or the
person pointing one at us — needs.

**Pointing an agent here takes one line.** `skills/remesso/SKILL.md` is the
same ground written for an agent to load rather than a person to read:

```bash
npx -y remesso-wallet skills
# or just fetch it:
# https://bitbucket.org/crackedstudios/remesso/raw/main/skills/remesso/SKILL.md
```

| | |
|---|---|
| ERC-8004 agent | `9867` on Celo, registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Proof of human | Self Agent ID `191`, soulbound, zero-knowledge passport proof |
| Contract | `RemessoExecutorV5` `0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8` (Celo, 42220) |
| Start here | `https://remesso.crackedstudios.xyz/.well-known/agent.json` |
| Capabilities | `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` |

The ERC-8004 metadata is a `data:` URI embedded in the token, not a link to a
server we control. What is registered cannot be quietly changed afterwards.

---

## What your agent needs, by role

| Role | Needs | Does not need |
|---|---|---|
| **Being paid** by a schedule | An address | Gas, USDC, an account, our software |
| **Paying** for a service | USDC on Celo | CELO — EIP-3009 means the facilitator pays gas |
| **Collecting** a payment early | A grant from the payer, plus a little CELO | — or skip the gas and pay a cent to `trigger-run` |

An agent that only receives money needs an address and nothing else. The payer
and the executor cover everything, including gas.

---

## Paying for a service

Three moves. The 402 is the quote — never trust a published price, including
the ones on this page.

```bash
# 1. what is on offer, and what it costs. Free: discovery that costs money is
#    discovery nobody does.
curl https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service

# 2. ask for the thing without paying. The 402 body carries exact requirements.
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service \
  -H 'content-type: application/json' -d '{}'

# 3. sign a USDC transfer authorisation for exactly that, retry with X-PAYMENT.
```

**The shortest path is the standard client.** These endpoints speak x402 v2,
so `@x402/fetch` pays them with no code of ours at all:

```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";

// The SELECTOR is what picks the currency. Without it the SDK takes the first
// entry in `accepts`, and Celo USDC is a built-in default asset that is always
// allowed — so a wallet holding both pays in USDC while its owner believes the
// `allowedAssets` line below chose otherwise. `allowedAssets` is a ceiling on
// what may be spent, not a choice of what to spend.
const client = new x402Client((_v, reqs) => reqs.find((r) => r.asset === USAT) ?? reqs[0]);
client.setSpendControls({ allowedAssets: [{
  network: "eip155:42220",
  asset: USAT,
  maxAmountPerPayment: "10000",
}]});
client.register("eip155:*", new ExactEvmScheme(account, { rpcUrl: "https://forno.celo.org" }));
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("…/functions/v1/rate-service", { method: "POST", body: "{}" });
```

Note where v2 puts things: the price list arrives in a **`PAYMENT-REQUIRED`
header** as base64 JSON, not in the body; the payment goes back in
**`PAYMENT-SIGNATURE`**; the receipt comes in **`PAYMENT-RESPONSE`**. v1's
body-and-`X-PAYMENT` shape is still accepted, so an older client keeps working
— both are served by the same response.

The signature is EIP-3009 `TransferWithAuthorization`. Take the EIP-712 domain
from `extra` rather than hardcoding it — the seller states it, and a wrong
domain makes every signature invalid for reasons the payer cannot see.

**Pay in the currency you hold.** The 402 lists two, same price in each since
both are 6dp: USDC (`0xcebA9300…118C`, domain `USDC` v2) and USA₮
(`0xD2ab3C9A…F771`, domain **`Tether America USD`** v1). `ASSET=USAT` picks one
in the example client.

Two things to get right, both verified on-chain:
`extra.name` is **not** the symbol — USA₮ signs as `Tether America USD`. And
USA₮ has an 18-decimal fee-currency adapter at `0x0357EE22…80C4` reporting the
same `symbol()`; match on the token **address**, never the symbol, or you are
wrong by 10¹². `examples/pay-remesso.ts` is a complete client in about 60 lines, meant
to be read or pasted rather than installed.

### Services

| Service | Price | What you get |
|---|---|---|
| `/functions/v1/agent` | free | Capabilities, prices, and what we refuse |
| `/functions/v1/request-payment` | free | Ask a sender to pay you — prefills their form, decides nothing |
| `/functions/v1/rate-service` | 0.001 USDC or USAT | Live USDT/NGN and USDC/NGN from on-chain RFQ makers — bid, ask and last, with mid and spread when both sides are quoted |
| `/functions/v1/trigger-run` | 0.01 USDC or USAT | Bring one payment of an existing schedule forward |

`trigger-run` answers `403` before quoting a price if the schedule's payer has
not granted our executor the right to collect, or if the schedule pays out in
naira — those rails are switched off pending the regulatory work below. Nobody
should pay to find either out.

---

## Being paid on a schedule

Receiving takes **an address and nothing else** — no gas, no balance, no
account, no software. The payer and the executor carry every cost. So the only
real problem is getting your address to the payer without a human reading 42
hex characters down a phone line, and there are four ways, easiest first.

**1. Ask them directly.** Free, and it lands in their app:

```bash
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment \
  -H 'content-type: application/json' \
  -d '{"payer":"0xTheirWallet","to":"0xYourAddress","amount":"5",
       "token":"USDT","every":"week","runs":4,
       "from":"Rate feed agent","note":"weekly retainer"}'
```

It answers `201` with a `link`. The request appears on their home screen with
Review and Dismiss, and 10 pending requests per payer is the ceiling — an inbox
anyone can fill is an inbox nobody reads.

**2. Send a link.** The same thing without us in the middle, for when you
already have a way to reach them:

```
https://remesso.crackedstudios.xyz/schedules/new?to=0xYourAddress&amount=5&every=week
```

Opening it fills their form in and says a link did it. `to`, `name`, `amount`,
`token`, `every` (`week`/`fortnight`/`month`/`quarter`), `runs`, `note` — every
one validated, anything unrecognised dropped.

**3. Just tell them the address**, in whatever channel you already use. They
type it into the recipient field.

**4. Read it back off an existing schedule.** The app shows each schedule's
recipient address with a copy button, so a payer can hand it to an agent that
needs to watch for the payments.

**None of these creates anything.** Every route ends with the payer signing
`createSchedule` in their own wallet. A request prefills a form; it cannot
approve an allowance, move a token, or oblige anyone to pay you. Treat a
prefilled form as a suggestion from a stranger, because that is what it is.

Once they authorise, the mandate is on-chain and:

- the recipient, the amount and the cadence are fixed — nobody can change them,
  including us
- payments continue until their run cap, their expiry, or their cancellation
- you need no gas, no USDC and no relationship with Remesso

To check what exists, read the contract rather than asking us:

```
getSchedule(uint256 id)                      // the whole mandate
runnability(uint256 id)                      // is a payment due, funded, allowed
triggerability(uint256 id, address caller)   // may `caller` collect early
```

## Paying on a schedule, as an agent

`examples/create-schedule.ts` signs the mandate from your own wallet. Unlike
paying per call, this needs **CELO for gas** — two transactions, an approval
and the schedule — because you submit them yourself rather than a facilitator
doing it for you.

```bash
TO=0xRecipient AMOUNT=0.05 TOKEN=USDT EVERY=week RUNS=2 TRIGGER=remesso \
PAYER_KEY=... deno run --allow-env --allow-net create-schedule.ts
```

**The fee comes out of the payment, not on top of it.** At 25bps a 0.05 USDT
transfer costs the payer exactly 0.05; the recipient receives 0.049875 and the
treasury 0.000125. Budget from the gross.

A schedule created this way is picked up within five minutes and then runs on
its cadence like any other. The executor takes its work from a mirror of the
chain, so a schedule created without the app has to be discovered first —
`sync-schedules` does that every five minutes by reading the contract. Until
it lands, the schedule is real but only `runNow` and `trigger-run` can move
it, so `TRIGGER=remesso` is worth setting anyway: it lets you pull the first
payment immediately instead of waiting.

## Collecting a payment early

If the payer granted you the right — an address and a count, set when they
signed — you can take one payment before its due time:

```solidity
runNow(uint256 id, uint256 amountOutMinimum)   // call it yourself, you pay gas
```

It takes exactly one payment, of the amount the payer fixed, to the address the
payer fixed. It consumes one scheduled payment rather than adding one, it
cannot be repeated within 60 seconds, it stops at the granted count, and the
payer can withdraw the grant at any moment with `setTrigger(id, 0, 0)`.

No CELO for gas? `POST /functions/v1/trigger-run` does the same thing for 0.01
USDC and the facilitator pays the gas — provided the payer granted **Remesso**:
on V5 that is the sentinel `0x0000000000000000000000000000000000000001`
(`CURRENT_EXECUTOR`), which follows our executor through a key rotation. The
executor's own address is refused as a trigger. The payment is settled before
the run is sent, after a simulation, so a run that would revert charges nothing.

On V5 an early send uses up the next scheduled slot: if it is due next week and
you collect today, the one after comes a week after next week, not a week from
today. A collection on a payment that is already due costs no grant.

---

## What this is not

Per-minute granularity for early collection: `MIN_TRIGGER_GAP` is 60 seconds.
(The cadence itself has no floor in the contract — the app's picker offers
weekly upwards, but a schedule can be created at any interval, and live ones
run hourly and every five minutes.) And gas is the real floor — **measured on our own transactions**, not
taken from a published figure: a payment costs ~91,875 gas, which at 202 gwei
and CELO near $0.09 is about **$0.0017**, and creating a schedule is ~224,000
gas (~$0.004). An x402 settlement is ~85,800 gas in USDC and ~87,500 in USA₮ — the
facilitator pays that one, not you. A first payment to a recipient that holds
none of that token yet costs more (one measured at ~104,700), because the
first write to a fresh balance slot is the expensive one. So a one-cent payment loses roughly 17% to gas, and a payment of
a few cents is the honest floor. Sub-cent streaming is payment channels, and
none of this is that.

The naira rails (cNGN to a wallet, or to a Nigerian bank account) are built and
switched off pending the regulatory work in the README. Today everything
settles in stablecoins.

`RemessoExecutorV5` is **unaudited**. It holds a spending allowance the moment
a payer approves it. That is worth knowing before you point real money at it.
