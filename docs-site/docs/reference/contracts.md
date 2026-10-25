---
title: Contracts and endpoints
description: The chain, contracts and HTTP endpoints remesso-sdk talks to, and how to check each one yourself.
---

import { ChainTable, ContractTable, EndpointTable } from '@site/src/components/Deployment';

Everything the SDK talks to on Celo mainnet. These tables are generated from the live deployment, the same source the SDK's own `deployment` export is built from.

## Chain

<ChainTable />

The SDK checks that its RPC answers this chain id before it signs anything, and refuses with `wrong_chain` otherwise.

## Contracts

<ContractTable />

Both contracts are immutable and verified on Celoscan. Neither has been audited by a person.

- **`RemessoExecutorV5`** holds schedules, not funds: each payment moves straight from the payer's wallet, the amount to the recipient and the fee to Remesso's treasury. Its owner can pause it, change the executor key, allow tokens for new schedules, set the swap pool's fee tier (for the swap rails, which are switched off) and rescue tokens sent to it by mistake. Nothing it can do changes a signed schedule's recipient, amount or cadence.
- **`RemessoAgentAllowance`** holds agent policies. It has no owner and no admin.

## Endpoints

<EndpointTable />

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
