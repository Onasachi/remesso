# Contracts and endpoints

> The chain, contracts and HTTP endpoints remesso-sdk talks to, and how to check each one yourself.

Source: https://docs.remesso.xyz/docs/reference/contracts

Everything the SDK talks to on Celo mainnet. These tables are generated from the live deployment, the same source the SDK's own `deployment` export is built from.

## Chain

|  |  |
|---|---|
| **Network** | Celo mainnet |
| **Chain id** | `42220` (`eip155:42220`) |
| **Default RPC** | `https://forno.celo.org` |

The SDK checks that its RPC answers this chain id before it signs anything, and refuses with `wrong_chain` otherwise.

## Contracts

| Contract | Address | What it does |
|---|---|---|
| **RemessoExecutorV5** | [`0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8`](https://celoscan.io/address/0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8) | Holds every schedule. Commission 0.25% (25 bps), pinned per schedule when it is signed. Deployed at block 80,268,721. |
| **RemessoAgentAllowance** | [`0xA6351fAeEb097698289586C4D6188530300DB209`](https://celoscan.io/address/0xA6351fAeEb097698289586C4D6188530300DB209) | Agent spending policies: a cap per payment and per day, an expiry, an optional recipient list. No owner, no admin. Deployed at block 80,467,202. |
| **ERC-8004 identity registry** | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) | Where agents are registered; the SDK reads an agent's wallet from it. |
| **Executor key** | [`0xA351d65c15b8a342B6ECbC7f2B9eFE62B17cdb21`](https://celoscan.io/address/0xA351d65c15b8a342B6ECbC7f2B9eFE62B17cdb21) | Remesso's hot key, which sends each payment when it is due. It pays gas and nothing else. |
| **Trigger sentinel** | `0x0000000000000000000000000000000000000001` | Grant this as a schedule's trigger to let Remesso's executor, whichever key it is at the time, bring a payment forward. |

Both contracts are immutable and verified on Celoscan.

- **`RemessoExecutorV5`** holds schedules, not funds: each payment moves straight from the payer's wallet, the amount to the recipient and the fee to Remesso's treasury. Its owner can pause it, change the executor key, allow tokens for new schedules, set the swap pool's fee tier (for the swap rails, which are switched off) and rescue tokens sent to it by mistake. Nothing it can do changes a signed schedule's recipient, amount or cadence.
- **`RemessoAgentAllowance`** holds agent policies. It has no owner and no admin.

## Endpoints

| Endpoint | What it does |
|---|---|
| `https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` | The capability document: identity, chain, limits, prices and refusals. Free. |
| `https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment` | Payment requests: create, status, list, answer, decline. Free. |
| `https://engaboljiqudghvzmebq.supabase.co/functions/v1/payment-events` | Every payment to or from an address, as Remesso's indexer reads it from the chain. Free. |
| `https://engaboljiqudghvzmebq.supabase.co/functions/v1/webhooks` | Subscribe an address's payments to your endpoint, signed. Free. |
| `https://engaboljiqudghvzmebq.supabase.co/functions/v1/trigger-run` | Bring one payment of a schedule forward, paid over x402. |
| `https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service` | USDT/NGN and USDC/NGN rates, paid over x402. |
| `https://engaboljiqudghvzmebq.supabase.co/functions/v1/latam-rate` | USD to wARS and wBRL rates, paid over x402. |
| `https://engaboljiqudghvzmebq.supabase.co/functions/v1/latam-route` | A route for delivering pesos or reais, paid over x402. |

The SDK calls `request-payment`, `payment-events` and `webhooks` for you. They are plain HTTP, documented on [the HTTP API page](./http-api.md) for other languages. The paid services speak x402, so any x402 client can buy them.

## Check it yourself

The contract is the authority, and anyone can read it. With Foundry's `cast`:

```bash
cast call 0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8 \
  "getSchedule(uint256)" 4 --rpc-url https://forno.celo.org
```

Or with the SDK, which reads the same contract:

```ts
const s = await reader.schedules.get(4);
console.log(s.to, s.amountIn, s.intervalSeconds, s.runsExecuted, "of", s.maxRuns);
```

If an endpoint and the contract ever disagree, the contract is right.

The capability document lists every endpoint, the contracts, the per-payment limits and Remesso's registrations. It is free and needs no key:

```bash
curl https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent
```
