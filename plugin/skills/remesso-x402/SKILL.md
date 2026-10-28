---
name: remesso-x402
description: Pay Remesso's paid HTTP services on Celo mainnet over x402 v2 — in USA₮ by default (USDC, USD₮ and Ripio's wARS, wBRL, wCOP, wMXN, wCLP and wPEN also accepted), with no CELO needed. Use when an agent wants live NGN rates (naira-rate, 0.001), live peso and real rates on Celo (latam-rate, 0.001), a ready route to deliver pesos, reais or soles with Ripio links (latam-route, 0.002), or to bring a scheduled stablecoin payment forward (trigger-run, 0.01), or needs a working, tested example of paying an x402 endpoint on Celo with the official @x402/fetch client, including choosing USA₮ or a local currency and capping the price.
license: MIT
---

# Remesso x402 — pay per call on Celo

Four paid endpoints, one protocol. Send an unpaid request, read the price from
the 402, sign a payment, send it again. The facilitator submits the transfer
and pays the gas, so **the payer needs the token and no CELO** — in dollars or
in Ripio's local currencies.

`manifest.json` beside this file is the same information as data — assets,
EIP-712 domains, prices, the payee — generated from the live 402. **The live
402 is still the price**: if this file and a 402 disagree, the 402 is right.

## Services

| Service | Endpoint | Price | Body |
|---|---|---|---|
| `naira-rate` | `POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service` | 0.001 | `{}` |
| `latam-rate` | `POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/latam-rate` | 0.001 | `{"usd": 250}` (optional) |
| `latam-route` | `POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/latam-route` | 0.002 | `{"country":"AR","amount":20000}` |
| `trigger-run` | `POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/trigger-run` | 0.01 | `{"scheduleId": <id>}` |

- **naira-rate** returns live USDT/NGN and USDC/NGN (bid, ask, last; mid and
  spread when both sides are quoted) from on-chain RFQ makers. `503` if the
  feed is down — you are not charged.
- **latam-rate** returns USD-to-wARS and USD-to-wBRL from two independent
  on-chain sources side by side — Textile's RFQ makers (bid/ask) and the
  Uniswap pool on Celo at your size (with price impact) — and flags when they
  disagree by more than 1%. wCOP, wMXN, wCLP and wPEN have no on-chain market
  on Celo and come back as `"market": "none on Celo"`, never a number from
  elsewhere.
- **latam-route** answers "how do I get N pesos, reais or soles to someone": the
  token, the dollars it takes at that size and from which venue, Ripio's public
  buy and cash-out links and a prefilled Remesso schedule link. Input
  `country` (AR | BR | CO | MX | CL | PE), `amount` (local currency, or USD with
  `"currency":"USD"`), optional `recipient` and `every`. It moves nothing.
  Ripio is linked, not partnered: the person does Ripio's own checks there.
- Bad input to either is a `400` before any price is quoted, and a source
  outage is a `503` — not charged.
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
| wARS | `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` · 18dp · EIP-712 `Peso Argentino` v`1` · Permit2 |
| wBRL | `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` · 18dp · EIP-712 `Real Brasileño` v`1` · Permit2 |
| wCOP | `0x8a1D45e102e886510e891d2Ec656a708991e2D76` · 18dp · EIP-712 `Peso Colombiano` v`1` · Permit2 |
| wMXN | `0x337E7456B420bD3481e7FA61fA9850343d610d34` · 18dp · EIP-712 `Peso Mexicano` v`1` · Permit2 |
| wCLP | `0x61D450a098b6a7f69fC4b98CE68198fe59768651` · 18dp · EIP-712 `Peso Chileno` v`1` · Permit2 |
| wPEN | `0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE` · 18dp · EIP-712 `Sol Peruano` v`1` · Permit2 |

Each service has one price in dollars. In USDC, USD₮ and USA₮ that is the same
number of base units, since all three are 6dp. In a wFIAT it is the dollar
price in local currency at a rough rate rounded down, at 18 decimals:
naira-rate's 0.001 is 1.5 wARS. `manifest.json` lists every service's exact
amount in each asset; the 402 is still the price.

**Pay in USA₮.** It is the default in `pay.mjs` and in the code below, and the
currency to choose unless your wallet holds none. USDC and USD₮ remain
accepted, for wallets that only hold those.

**Or pay in the local currency you hold.** The six wFIAT have no EIP-3009, so
they settle through Permit2: the payer signs a Permit2 transfer and an EIP-2612
permit to Permit2, and the facilitator lands both and pays the gas. Still no
CELO. Two things a client must do for it, both in `pay.mjs`: read the chain
(the permit needs the wallet's allowance and nonce), and allow the asset in its
spend controls, since the stock client signs only USDC, USD₮ and USA₮ unless
told otherwise.

## Pay in two commands

With the Remesso wallet installed (the Claude plugin, or `remesso-wallet` in
Codex, Cursor or any MCP host), use its `pay_x402` tool instead: it
pays from a wallet whose spending is capped on-chain, and no key passes
through the conversation.

`scripts/pay.mjs` ships beside this file (its source is also in the
[repository](https://bitbucket.org/crackedstudios/remesso/src/main/skills/remesso-x402/scripts/pay.mjs)):

```bash
npm i @x402/fetch@2.28.0 @x402/evm@2.28.0 viem
PAYER_KEY=0x… node scripts/pay.mjs --service naira-rate
```

`pay.mjs` prints the HTTP status, the settlement receipt (transaction hash)
and the response body. It pays in **USA₮ unless told otherwise**, and stops
before signing if the wallet holds none. Options: `--asset` `USAT` (default),
`USDT`, `USDC`, `wARS`, `wBRL`, `wCOP`, `wMXN`, `wCLP` or `wPEN`;
`--max 0.05` (in dollars whatever you pay with: any quote above it is refused
before signing); `--body '{"scheduleId":3}'`.

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

For a wFIAT, allow the asset with a cap in its own base units, and give the
scheme an RPC so it can sign the sponsored permit. Without the RPC it signs no
permit, and a wallet that never approved Permit2 gets `412
permit2_allowance_required`:

```ts
const WARS = "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D";
client.setSpendControls({
  allowedAssets: [{ network: "eip155:42220", asset: WARS, maxAmountPerPayment: "100000000000000000000" }], // 100 wARS
});
registerExactEvmScheme(client, {
  signer: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`),
  paymentRequirementsSelector: select, // finding WARS rather than USAT
  schemeOptions: { rpcUrl: "https://forno.celo.org" },
});
```

## Mistakes that cost money

- **Match tokens by address, never by symbol.** USDC, USD₮ and USA₮ each have
  an 18-decimal fee-currency adapter on Celo reporting the same `symbol()`
  (USA₮'s: `0x0357EE22278c922e1D36cFe6b899269b161880C4`). Signing against the
  adapter is a 10¹² error.
- **The EIP-712 name is not the symbol.** USA₮ signs as `Tether America USD`,
  USD₮ as `Tether USD`, wBRL as `Real Brasileño`. Take it from the 402's
  `extra`, as the SDK does, and decode the header as UTF-8.
- **A peso is not a dollar.** The wFIAT are 18dp and priced in local units:
  0.001 dollars is 1.5 wARS, not 0.001 wARS.
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
  (`npx -y remesso-wallet skills`).
- Capabilities, live: `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent`
- Agent card: `https://remesso.xyz/.well-known/agent.json`
- Identity: ERC-8004 agents 9867 and 9879 on `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`; Self Agent ID 191.
- Remesso is live on mainnet and **unaudited**.
