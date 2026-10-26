# Utilities and constants

> The functions and constants remesso-sdk exports besides the client - tokens, amounts, fees, limits, memos, pay links, webhook verification, stores, ABIs and the deployment.

Source: https://docs.remesso.xyz/docs/reference/utilities

Besides `createRemesso`, the SDK exports the helpers it uses itself. They are pure functions with no network access, unless noted.

## Tokens and amounts

Amounts go in as decimal strings and come out as base units (`bigint`). Never pass a JavaScript number in between: that is how precision is lost.

```ts
import { findToken, formatAmount, token, toUnits } from "remesso-sdk";

const usdt = token("USDT");               // throws for a token Remesso doesn't know
const units = toUnits("2.50", usdt);       // 2_500_000n: USDT has 6 decimals
console.log(formatAmount(997_500n, usdt)); // "0.9975 USDT"
console.log(findToken("USAT")?.symbol);    // "USA₮": undefined if unknown, never throws
```

| Export | Signature | Description |
|---|---|---|
| `token` | `(symbolOrAddress: string) => Token` | A token by symbol or address. Throws `invalid` for one Remesso doesn't know. |
| `findToken` | `(symbolOrAddress: string) => Token \| undefined` | The same, returning `undefined` instead of throwing. |
| `toUnits` | `(amount: string, t: Token) => bigint` | A decimal string in base units. Throws `invalid` for a malformed amount or more decimals than the token has. |
| `formatAmount` | `(units: bigint \| string, token: Token \| string) => string` | Base units as a decimal with the symbol, such as `"1500 wARS"`. |

Symbols match in any case, and common spellings resolve: `USAT` and `USD₮` to USA₮ and USDT, `cUSD` to USDm. A `Token` has `symbol`, `address`, `decimals`, `currency`, `directAllowed`, `feeCurrency`, `minPerRun` and `maxPerRun`. The full table is on [tokens and limits](./tokens-and-limits.md).

## Fees and limits

The commission is taken from each scheduled payment and rounded up, exactly as the contract rounds it.

```ts
import { FEE_BPS, feeOf, grossFor, netOf, runLimits, token, toUnits } from "remesso-sdk";

const usdt = token("USDT");
const gross = toUnits("1", usdt);

feeOf(gross, FEE_BPS);                  // 2_500n: 0.0025 USDT
netOf(gross, FEE_BPS);                  // 997_500n: what arrives
grossFor(toUnits("50", usdt), FEE_BPS); // 50_125_314n: send this for exactly 50 to arrive
runLimits(token("wARS"));               // { min: 1,500 wARS, max: 1,500,000 wARS }, in base units
```

| Export | Signature | Description |
|---|---|---|
| `FEE_BPS` | `number` | Remesso's commission on new schedules, in basis points: 25, or 0.25%. |
| `feeOf` | `(gross: bigint, bps: number) => bigint` | The commission on a gross amount, rounded up. |
| `netOf` | `(gross: bigint, bps: number) => bigint` | What the recipient receives from a gross amount. |
| `grossFor` | `(net: bigint, bps: number) => bigint` | The smallest gross amount that delivers at least `net`. |
| `runLimits` | `(t: Token) => { min: bigint; max: bigint }` | The gross per-payment bounds the executor sends. Throws `refused` for a token not taken for new schedules. |

## Memos

```ts
import { memo32 } from "remesso-sdk";

memo32("invoice-42"); // 0x696e766f6963652d3432 followed by zeros: 32 bytes
```

`memo32(memo?)` encodes a memo as the `bytes32` an agent payment records on-chain, padded on the right. It throws `invalid` over 32 bytes rather than cutting it. A plain letter is one byte, an accented letter two and an emoji four.

`invoiceReference(invoiceId)` is the memo that settles a signed invoice made without a request: the first 32 hex characters of its id. `invoices.pay` sets it for you; pass it as `memo` to pay such an invoice another way.

## Pay links

```ts
import { parsePayLink, payLink } from "remesso-sdk";

const link = payLink({
  to: process.env.RECIPIENT!,
  amount: "50",
  token: "USDT",
  every: "month",
  runs: 12,
  from: "Ada's studio",
});
// https://remesso.xyz/schedules/new?to=0x…&from=Ada%27s+studio&amount=50&token=USDT&every=month&runs=12

parsePayLink(link); // { to, from, amount: "50", token: "USDT", intervalSeconds: 2592000, runs: 12 }
```

| Export | Signature | Description |
|---|---|---|
| `payLink` | `(input: PayLinkInput, origin?: string) => string` | A link that opens the Remesso payment form filled in. The amount is what the recipient should receive. |
| `parsePayLink` | `(urlOrQuery: string) => PayLink` | What a link says, keeping only what validates: a real address, a positive amount, a token taken for new schedules, a cadence the form offers, a request id. |

The client's own `payLink` method defaults `to` to the client's address.

## Webhook verification

| Export | Signature | Description |
|---|---|---|
| `webhookHandler` | `(options: WebhookHandlerOptions) => (req: Request) => Promise<Response>` | A fetch-style handler: answers the subscription challenge for your address, verifies the signature, payment shape and recipient, and calls `onPayment` per delivery attempt. Deduplicate `message.id` with your business action. |
| `verifyWebhook` | `(raw, headers, secrets) => Promise<boolean>` | Whether a raw body was signed with one of your secrets in the last five minutes. |
| `parseWebhook` | `(raw, headers, secrets) => Promise<WebhookMessage>` | A verified delivery, parsed. Throws for a bad signature or a body that isn't a Remesso payment message. |

See [webhooks](../guides/webhooks.md) for running them, and [webhook payloads](./webhook-payloads.md) for the message format.

## Payment stores

Agent payments are recorded before they are broadcast, so a retry with the same idempotency key can find the first attempt.

| Export | Description |
|---|---|
| `memoryStore()` | The default: records in memory, lost when the process exits. |
| `fileStore(path?)` | From `remesso-sdk/node`. Records in a JSON file with `0600` permissions, by default `~/.remesso-sdk/payments.json`. Use one process per file. |
| `PaymentStore` | The interface, to keep records in your own database: `byKey(key, deployment)`, `since(ms)` and `save(record)`. |
| `memoryRemittanceStore()` | Wallet payments in memory, lost when the process exits. |
| `fileRemittanceStore(path?)` | From `remesso-sdk/node`. Wallet payments in a JSON file with `0600` permissions, by default `~/.remesso-sdk/remittances.json`. Use one process per file. |
| `RemittanceStore` | The interface: `get(key, scope)`, `list(scope)` and `save(record)`. `list` returns every record for the signer; `save` resolves only once the record is durable. |

Keys belong to one chain, contract and signing key. A key, and a transaction not yet settled, are kept for good; only settled payments without a key are dropped, after 30 days or past 1,000 of them. Keep the stores across restarts and back them up. An unreadable or corrupt file refuses new payments rather than forgetting the old ones.

Before signing anything, the SDK reads every journal for transactions the chain hasn't mined yet. It sends them again, lowest nonce first, or cancels at its nonce one that must no longer land, and signs the new one above them. So a lost broadcast never holds up the transactions after it, and a lagging RPC never lets a new payment replace a saved one. Keep both stores with the key.

Clients that share a key in one process share one queue. Workers in several processes need the shared journals and lock of `remesso-sdk/postgres`. A nonce used with no receipt to show by what is a `conflict` to investigate, never a reason to pay again.

## Node helpers

From `remesso-sdk/node`:

| Export | Description |
|---|---|
| `fileStore(path?)` | Agent payment records on disk, above. |
| `fileRemittanceStore(path?)` | Wallet payment records on disk, above. |
| `toNodeListener(handler)` | Runs a fetch-style handler, such as `webhookHandler`'s, under `http.createServer` or Express. Mount it before any JSON body parser: the signature covers the raw body. |
| `safeFetchText(url)` | Fetches an agent's registration file only from public addresses, connecting to the address it checked. Pass it as the client's `fetchText`. |

## Deployment constants

Generated from what is live, never typed by hand.

| Export | Description |
|---|---|
| `deployment` | Celo mainnet as Remesso runs it: chain, contracts, tokens and endpoints. |
| `CHAIN_ID` | `42220`. |
| `EXECUTOR` | The `RemessoExecutorV5` contract, which holds schedules. |
| `ALLOWANCE` | The `RemessoAgentAllowance` contract, which holds agent policies. |
| `REGISTRY` | The ERC-8004 identity registry. |
| `CURRENT_EXECUTOR` | `0x…0001`: the trigger value that means Remesso's executor, whichever key it is at the time. |
| `CADENCES` | `week`, `fortnight`, `month` (30 days) and `quarter` (90 days), in seconds. |

The addresses are on [contracts and endpoints](./contracts.md).

## ABIs

`executorAbi`, `allowanceAbi`, `erc20Abi` and `registryAbi`, for reading or writing the contracts with viem directly.

```ts
import { EXECUTOR, executorAbi } from "remesso-sdk";

const [due, funded, approved] = await reader.publicClient.readContract({
  address: EXECUTOR,
  abi: executorAbi,
  functionName: "runnability",
  args: [scheduleId],
});
console.log({ due, funded, approved });
```

## Attribution

| Export | Description |
|---|---|
| `ATTRIBUTION` | The ERC-8021 suffix the SDK appends to every transaction: Remesso's own codes. |
| `attributionFor(builderCodes?, ours?)` | That suffix with your builder codes after Remesso's, checked by the rules the executor applies. For a transaction you send yourself. |

See [builder codes](../guides/builder-codes.md).

## Errors

`RemessoError` is the class of every refusal, with a `code` (`RemessoErrorCode`) and sometimes `details`. See [errors](./errors.md).

## Types

`Cadence`, `CreateScheduleInput`, `CreatedSchedule`, `Schedule`, `PayInput`, `PaymentResult`, `Policy`, `CreatePolicyInput`, `CreateRequestInput`, `RequestState`, `RequestStatus`, `RequestSummary`, `EventKind`, `EventQuery`, `PaymentEvent`, `WebhookHandlerOptions`, `WebhookMessage`, `WebhookType`, `FoundAgent`, `PayeeProfile`, `PayLink`, `PayLinkInput`, `PaymentRecord`, `PaymentStore`, `Token`, `Remesso`, `RemessoOptions` and `RemessoErrorCode`.
