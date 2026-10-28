# Fees, limits and gas

> What each payment costs, the amounts Remesso's executor sends, and who pays gas for what.

Source: https://docs.remesso.xyz/docs/guides/fees-and-gas

This page covers what a payment costs: Remesso's fee on scheduled payments, the range of amounts its executor sends, and the gas each step uses and who pays it.

## The fee on scheduled payments

Remesso takes **0.25% of each scheduled payment** (25 basis points), from the payment itself, rounded up to the token's smallest unit. The rest arrives.

| Each payment sends | Fee | The recipient receives |
|---|---|---|
| 1 USDT | 0.0025 USDT | 0.9975 USDT |
| 50 USDT | 0.125 USDT | 49.875 USDT |
| 1,000 USDT | 2.5 USDT | 997.5 USDT |
| 1,500 wARS | 3.75 wARS | 1,496.25 wARS |
| 5 wBRL | 0.0125 wBRL | 4.9875 wBRL |

A few things follow from how the fee is set:

- **It is pinned when the schedule is signed.** Each schedule stores its own `feeBps`, and nothing can raise it afterwards. The contract caps any fee at 0.5% in code. `schedules.create` reads the current fee from the contract when it builds a schedule, and `FEE_BPS` is that value as of the SDK's release.
- **Policy payments carry no fee.** What an agent pays is what arrives.
- **Receiving costs nothing,** and so do payment requests, payment events and webhooks.

### Work out the numbers

The SDK exports the contract's own arithmetic, in base units:

```ts
import { FEE_BPS, feeOf, formatAmount, grossFor, netOf, token, toUnits } from "remesso-sdk";

const usdt = token("USDT");
const gross = toUnits("50", usdt); // 50_000_000n

formatAmount(feeOf(gross, FEE_BPS), usdt); // "0.125 USDT"
formatAmount(netOf(gross, FEE_BPS), usdt); // "49.875 USDT"

// What to send so that exactly 50 arrives:
formatAmount(grossFor(toUnits("50", usdt), FEE_BPS), usdt); // "50.125314 USDT"
```

- `feeOf(gross, bps)` is what the contract keeps, rounded up as the contract rounds it: `feeOf(1_000_001n, 25)` is `2_501n`, not 2,500.
- `netOf(gross, bps)` is what arrives.
- `grossFor(net, bps)` is the smallest amount to send for at least `net` to arrive. This is what `schedules.create({ receive })` signs, and what a payer's form signs for a [payment request](./payment-requests.md).

For a schedule that already exists, use its own `feeBps`, from `schedules.get(id)`. `recipientGets` on a schedule is already `netOf` its amount.

### What a whole schedule costs

The approval covers every payment, so the payer needs the gross amount times the number of payments:

```ts
import { FEE_BPS, formatAmount, grossFor, token, toUnits } from "remesso-sdk";

const usdt = token("USDT");
const each = grossFor(toUnits("50", usdt), FEE_BPS); // 50 arrives each month
const total = each * 12n;
console.log(`approve ${formatAmount(total, usdt)} for 12 payments`); // approve 601.503768 USDT for 12 payments
```

## Per-payment limits

Remesso's executor sends the equivalent of **1 to 1,000 US dollars per payment**, counted on what leaves the payer's wallet, before the fee. A schedule outside that range is valid on-chain and never runs, because the executor won't send it. So the SDK refuses it before signing, with [`refused`](../reference/errors.md#refused).

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

These come from the deployment the SDK is generated from, and Remesso's capability document publishes the live values under `limits.perRun`. In code, `runLimits` gives the bounds in base units:

```ts
import { formatAmount, runLimits, token } from "remesso-sdk";

const wars = token("wARS");
const { min, max } = runLimits(wars);
console.log(`${formatAmount(min, wars)} to ${formatAmount(max, wars)} per payment`); // 1500 wARS to 1500000 wARS per payment
```

With `receive`, the limit applies to the gross amount the SDK works out. Receiving exactly 1 USDT sends 1.002507 USDT, inside the range. Asking to receive 999 USDT sends about 1,001.5 USDT, which is refused.

Agent payments have no executor limits. The policy's caps per payment and per day are their limits. See [Agent payments](./agent-payments.md).

## Who pays gas

Every transaction on Celo pays gas. Remesso pays for the payments its executor sends, and you pay for the transactions your own key sends:

| Step | Who pays the gas | Measured on our own transactions |
|---|---|---|
| Creating a schedule: an approval, then `createSchedule` | The payer | About 224,000 gas for `createSchedule`, plus the approval |
| Each scheduled payment | Remesso's executor, covered by the fee | About 91,875 gas |
| Pausing, resuming, cancelling, or changing a trigger | The payer | One transaction each |
| Creating a policy: an approval, then `createPolicy` | The person | Two transactions |
| Each agent payment | The agent's key | About 85,000 gas |
| Receiving a payment | Nobody | None |
| Requests, payment events, webhooks | Nobody: they are HTTP calls | None |

These figures were measured, not promised: at 202 gwei, with CELO near $0.09, creating a schedule cost about $0.004. They move with the gas price and the price of CELO.

## Paying gas without CELO

Celo lets some tokens pay for gas themselves, which Celo calls fee abstraction. The SDK uses it automatically. Before each transaction it looks at the account's CELO:

1. If the account holds at least twice the estimated cost in CELO, it pays in CELO.
2. If not, and the transaction's token can pay gas and the account holds some of it, it pays the gas in that token.
3. Otherwise it throws [`no_gas`](../reference/errors.md#no_gas) before signing, saying how much CELO the transaction needs.

The token it uses is the one the transaction is about:

- **creating or managing a schedule:** the schedule's token;
- **creating or managing a policy:** the policy's token;
- **an agent payment:** the policy's token, but held by the agent's own key, since the agent pays its gas. Most agents hold none, so they need a little CELO.

USDT, USDC, USDm and USA₮ can pay gas: the "Pays gas" column in the table above. Ripio's tokens and cNGN can't, so a payer funding a schedule in them needs some CELO.

Gas paid in a token costs a little more gas than gas paid in CELO. In our mainnet test on 2026-10-25, a wallet holding no CELO sent an approval, a `createPolicy` and a `revoke`, which used 115,469, 211,253 and 115,498 gas. The three cost 0.007028 USDT in all.

```ts
import { RemessoError } from "remesso-sdk";

try {
  await payer.schedules.create({ to: "0xRecipient", amount: "1500", token: "wARS", every: "month", runs: 3 });
} catch (e) {
  // wARS can't pay gas: the message says how much CELO to send the payer.
  if (e instanceof RemessoError && e.code === "no_gas") console.error(e.message);
  else throw e;
}
```

## Early sends

An early send brings one payment of a schedule forward, when its payer granted a trigger (see [Let a payment be sent early](./schedules.md#let-a-payment-be-sent-early)):

- **Through Remesso,** for a schedule whose trigger is `"remesso"`: `trigger-run` costs 0.01 USDC, USDT or USA₮, or the same in a Ripio token, paid over x402. The x402 facilitator pays the settlement's gas, and Remesso's executor pays for the run. See the [HTTP API](../reference/http-api.md).
- **Yourself,** when your own address is the trigger: call `runNow` on the contract, and pay its gas.

An early send costs no extra fee beyond the 0.25% the payment carries anyway, and it never adds a payment.

## Next steps

- [Tokens and limits](../reference/tokens-and-limits.md): every token, with its address and decimals.
- [Pay on a schedule](./schedules.md): `amount` or `receive`, and everything else `create` takes.
- [Errors](../reference/errors.md): what `refused` and `no_gas` carry.
