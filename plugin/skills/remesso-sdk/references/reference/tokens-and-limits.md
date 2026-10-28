# Tokens and limits

> The tokens a schedule can pay in, their decimals and addresses, the executor's per-payment limits, and which tokens can pay gas.

Source: https://docs.remesso.xyz/docs/reference/tokens-and-limits

These are the tokens Remesso's executor accepts for new schedules, with the bounds it applies to each payment. The table is generated from the live deployment.

| Token | Currency | Decimals | Per payment, before the fee | Pays gas | Address |
|---|---|---|---|---|---|
| **USDT** | USD | 6 | 1 to 1,000 | Yes | [`0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`](https://celoscan.io/address/0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e) |
| **USDC** | USD | 6 | 1 to 1,000 | Yes | [`0xcebA9300f2b948710d2653dD7B07f33A8B32118C`](https://celoscan.io/address/0xcebA9300f2b948710d2653dD7B07f33A8B32118C) |
| **USDm** | USD | 18 | 1 to 1,000 | Yes | [`0x765DE816845861e75A25fCA122bb6898B8B1282a`](https://celoscan.io/address/0x765DE816845861e75A25fCA122bb6898B8B1282a) |
| **USA₮** | USD | 6 | 1 to 1,000 | Yes | [`0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771`](https://celoscan.io/address/0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771) |
| **wARS** | ARS | 18 | 1,500 to 1,500,000 | No | [`0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D`](https://celoscan.io/address/0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D) |
| **wBRL** | BRL | 18 | 5 to 5,000 | No | [`0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0`](https://celoscan.io/address/0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0) |
| **wCOP** | COP | 18 | 3,100 to 3,100,000 | No | [`0x8a1D45e102e886510e891d2Ec656a708991e2D76`](https://celoscan.io/address/0x8a1D45e102e886510e891d2Ec656a708991e2D76) |
| **wMXN** | MXN | 18 | 18 to 18,000 | No | [`0x337E7456B420bD3481e7FA61fA9850343d610d34`](https://celoscan.io/address/0x337E7456B420bD3481e7FA61fA9850343d610d34) |
| **wCLP** | CLP | 18 | 950 to 950,000 | No | [`0x61D450a098b6a7f69fC4b98CE68198fe59768651`](https://celoscan.io/address/0x61D450a098b6a7f69fC4b98CE68198fe59768651) |
| **wPEN** | PEN | 18 | 3 to 3,000 | No | [`0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE`](https://celoscan.io/address/0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE) |
| **cNGN** | NGN | 6 | 1,300 to 1,300,000 | No | [`0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`](https://celoscan.io/address/0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f) |

## Reading the table

- **Per payment, before the fee.** The executor sends each payment only if its gross amount is between the equivalent of 1 and 1,000 dollars. Local currencies are converted with rough rates rounded down, so the bounds only ever err on the strict side. A schedule outside them is valid on-chain but never runs, so the SDK refuses it before you sign. `runLimits(token)` returns the same bounds in base units.
- **Decimals differ.** USDT, USDC, USA₮ and cNGN have 6 decimals; USDm and Ripio's wARS, wBRL, wCOP, wMXN, wCLP and wPEN have 18. Pass amounts as decimal strings and let `toUnits` convert them.
- **Pays gas.** A wallet without CELO can pay transaction fees in these tokens, through Celo's fee abstraction. The SDK does this by itself when the account holds too little CELO and some of the token it is sending. See [fees, limits and gas](../guides/fees-and-gas.md).
- **Payments are in the same token.** A schedule funded in a token pays out in that token: there is no conversion.

## Symbols and aliases

`token()` and `findToken()` match symbols in any case and accept common spellings:

| You write | You get |
|---|---|
| `USAT`, `usat` | USA₮ |
| `USD₮`, `USDT0` | USDT |
| `cUSD` | USDm (formerly cUSD) |
| an address | the token at that address |

Match tokens by address when you can. On Celo, USDT, USDC and USA₮ each have an 18-decimal fee-currency adapter that reports the same `symbol()` as the real token, so a symbol read from a contract can mislead.

## Which tokens a recipient can see

What a recipient's wallet displays matters as much as what the contract accepts.

- **MiniPay** shows only USDT, USDC, USDm and USA₮. A MiniPay user paid in cNGN or a Ripio token receives the tokens but can't see them in the app.
- **Local-currency tokens** suit recipients with a wallet that shows them, or who cash out through a ramp: Ripio's for its six local currencies, and Textile's for naira from USDT. Remesso links to these ramps; the recipient uses them with their own wallet.

## Changes

New schedules can use a token only once the contract allows it, and the SDK reads that from the contract before creating a schedule. When the list changes, this page and the SDK's generated deployment change with it.
