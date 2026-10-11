---
name: remesso-x402
description: Pay Remesso's paid HTTP services on Celo mainnet over x402 v2 — in USA₮ by default (USDC and USD₮ also accepted), with no CELO needed. Use when an agent wants live NGN exchange rates (naira-rate, 0.001) or to bring a scheduled stablecoin payment forward (trigger-run, 0.01), or needs a working, tested example of paying an x402 endpoint on Celo with the official @x402/fetch client, including choosing USA₮ and capping the price.
license: MIT
---

# Remesso x402 — pay per call on Celo

Two paid endpoints, one protocol. Send an unpaid request, read the price from
the 402, sign a token authorisation, send it again. The facilitator submits the
transfer and pays the gas, so **the payer needs the token and no CELO**.

`manifest.json` beside this file is the same information as data — assets,
EIP-712 domains, prices, the payee — generated from the live 402. **The live
402 is still the price**: if this file and a 402 disagree, the 402 is right.

## Services

| Service | Endpoint | Price | Body |
|---|---|---|---|
| `naira-rate` | `POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service` | 0.001 | `{}` |
| `trigger-run` | `POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/trigger-run` | 0.01 | `{"scheduleId": <id>}` |

- **naira-rate** returns live USDT/NGN and USDC/NGN (bid, ask, last; mid and
  spread when both sides are quoted) from on-chain RFQ makers. `503` if the
  feed is down — you are not charged.
- **trigger-run** brings ONE payment of an existing Remesso schedule forward.
  It only works for a schedule whose payer allowed early sends, and it answers
  `403` *before quoting a price* otherwise — so you never pay to learn a call
  would fail. A reverted run returns `409` and charges nothing.

## Payment terms

| | |
|---|---|
| Protocol | x402 **v2** (v1 still accepted), scheme `exact` |
| Network | `eip155:42220` — Celo mainnet |
| Pay to | `0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2` |
| Facilitator | `https://api.x402.celo.org` (pays settlement gas) |
| USDC | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` · 6dp · EIP-712 `USDC` v`2` |
| USD₮ | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` · 6dp · EIP-712 `Tether USD` v`1` |
| USA₮ | `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771` · 6dp · EIP-712 `Tether America USD` v`1` |

The same amount in base units is the price in each — all three are 6dp.

**Pay in USA₮.** It is the default in `pay.mjs` and in the code below, and the
currency to choose unless your wallet holds none. USDC and USD₮ remain
accepted, for wallets that only hold those.

## Pay in three commands

```bash
npm i @x402/fetch@2.28.0 @x402/evm@2.28.0 viem
curl -sO https://raw.githubusercontent.com/crackedstudio/Remesso/main/skills/remesso-x402/scripts/pay.mjs
PAYER_KEY=0x… node pay.mjs --service naira-rate
```

`pay.mjs` prints the HTTP status, the settlement receipt (transaction hash)
and the response body. It pays in **USA₮ unless told otherwise**, and stops
before signing if the wallet holds none. Options: `--asset USAT|USDT|USDC`
(default `USAT`), `--max 0.05` (refuse any quote above this, before signing),
`--body '{"scheduleId":3}'`.

Verified on mainnet 2026-10-11 with exactly this script: 200, both NGN pairs
returned, 0.001 USA₮ settled by Celo's facilitator in
`0xf91d34654fedefca88a074b17eac7c2a3e5fee16b056522d399f12118a72d6f9`.

## Or in your own code

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";
const MAX = 50_000n; // 0.05 — your ceiling per call

// The selector CHOOSES the currency — USA₮ here. Without one the SDK takes
// the first entry in the 402, which is USDC.
const select = (_v: number, accepts: any[]) => {
  const a = accepts.find((r) => r.asset.toLowerCase() === USAT.toLowerCase());
  if (!a || BigInt(a.amount) > MAX) throw new Error("no acceptable quote");
  return a;
};
const client = new x402Client(select);
registerExactEvmScheme(client, {
  signer: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`),
  paymentRequirementsSelector: select,
});

const pay = wrapFetchWithPayment(fetch, client);
const res = await pay("https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service", {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
```

USA₮ is inside the SDK's **default** spend controls on Celo — no opt-in needed.

## Mistakes that cost money

- **Match tokens by address, never by symbol.** USDC, USD₮ and USA₮ each have
  an 18-decimal fee-currency adapter on Celo reporting the same `symbol()`
  (USA₮'s: `0x0357EE22278c922e1D36cFe6b899269b161880C4`). Signing against the
  adapter is a 10¹² error.
- **The EIP-712 name is not the symbol.** USA₮ signs as `Tether America USD`,
  USD₮ as `Tether USD`. Take it from the 402's `extra`, as the SDK does.
- **v2 is headers.** The price is the base64 `PAYMENT-REQUIRED` header, the
  payment goes in `PAYMENT-SIGNATURE`, the receipt comes back in
  `PAYMENT-RESPONSE`. A client reading only the body is a v1 client.
- **Cap the price yourself.** Read the 402, compare with your ceiling, then
  sign. A quote is an offer, not a bill.

## Attribution

Every 402 carries the x402 `builder-code` extension
(`{"a":"remesso","s":["celo_5cd35ca55baf"]}`). Clients that echo extensions
pass it to the facilitator, which will write it on-chain once Celo's
facilitator supports it. Nothing to do on your side.

## More

- Scheduling, being paid, and the contract: the `remesso` skill
  (`npx skills add crackedstudio/Remesso --skill remesso`).
- Capabilities, live: `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent`
- Agent card: `https://remesso-3q67.vercel.app/.well-known/agent.json`
- Identity: ERC-8004 agents 9867 and 9879 on `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`; Self Agent ID 191.
- Remesso is live on mainnet and **unaudited**.
