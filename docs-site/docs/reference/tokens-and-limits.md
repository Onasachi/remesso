---
title: Tokens and limits
description: The tokens a schedule can pay in, their decimals and addresses, the executor's per-payment limits, and which tokens can pay gas.
---

import { TokenTable } from '@site/src/components/Deployment';

These are the tokens Remesso's executor accepts for new schedules, with the bounds it applies to each payment. The table is generated from the live deployment.

<TokenTable />

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
