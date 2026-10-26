# Find agents

> Look up an agent in the ERC-8004 registry on Celo, get the only address it can safely be paid at, and read what it accepts.

Source: https://docs.remesso.xyz/docs/guides/find-agents

This guide shows how to find another agent by its ERC-8004 id, where to pay it, and what its payee profile says it accepts.

## What `agents.find` returns

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) is a registry of agents on-chain: each has a numeric id, an owner, a wallet and a registration file. `agents.find` reads an agent from the registry on Celo:

```ts
async function lookUp(agentId: bigint) {
  const found = await reader.agents.find(agentId);
  if (!found.wallet) {
    console.log("don't pay it:", found.note);
    return;
  }
  console.log("pay", found.wallet, "accepts", found.profile?.assets ?? "not stated");
}
```

It returns:

| Field | Meaning |
|---|---|
| `agentId` | The id you asked for, as a `bigint`. |
| `wallet` | Where to pay the agent, or `null` when it has set no wallet. Then don't pay it. |
| `profile` | Its payee profile (below), or `null` when it has none Remesso can read. |
| `note` | Why there is no wallet or no profile, when there isn't. |

A read-only client is enough: finding an agent signs nothing.

## Where to pay an agent

The address comes from the registry's `getAgentWallet`, and only from there. That value can be set only by a signature from the wallet itself, and the registry clears it whenever the agent's token changes hands.

The registration file is different: whoever holds the agent's token can rewrite it at any time. So `agents.find` never takes an address from it, even when the file names one. Do the same in your own code: pay `found.wallet`, never an address from a document or a message.

## The payee profile

An agent can say what it accepts in a `remesso` entry in the `services` list of its registration file:

```json
{
  "name": "remesso",
  "endpoint": "https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment",
  "version": "1",
  "assets": [
    { "network": "eip155:42220", "asset": "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e" }
  ],
  "reference": { "required": true }
}
```

`agents.find` reads it into `found.profile`:

| Field | Meaning |
|---|---|
| `version` | `"1"`. An entry of another version reads as no profile. |
| `endpoint` | Remesso's request service, where a payer checks and answers the agent's requests, or `null`. |
| `assets` | The tokens accepted: the chain as CAIP-2 (`eip155:42220` for Celo) and the token's address. |
| `reference` | `{ required: true }` when every payment must carry the agent's request reference, otherwise `null` or `{ required: false }`. |

Match tokens by address, never by symbol: on Celo, a fee-currency adapter reports the same symbol as the real token. `findToken` from remesso-sdk takes an address:

```ts
import { findToken, type FoundAgent } from "remesso-sdk";

function payableTokens(found: FoundAgent) {
  return (found.profile?.assets ?? [])
    .filter((a) => a.network === "eip155:42220")
    .map((a) => findToken(a.asset))
    .filter((t) => t !== undefined);
}

async function show(agentId: bigint) {
  const found = await reader.agents.find(agentId);
  console.log("tokens Remesso can pay it in:", payableTokens(found).map((t) => t.symbol));
}
```

To publish a profile for your own agent, add the entry to your registration file. Its format and the reasoning behind it are in [AGENTS.md](https://bitbucket.org/crackedstudios/remesso/src/main/docs/AGENTS.md). Never add an address entry such as `agentWallet` to the file: some tools take one as the agent's wallet without reading the chain.

## Remote registration files

A registration file is a `data:` URI inside the token, or a link to one at `https:` or `ipfs:`. `agents.find` reads a `data:` URI with no network request. For a remote file it needs a fetcher, because the URL is whatever the agent's owner chose. In Node, pass `safeFetchText` from `remesso-sdk/node`:

```ts title="find.ts"
import { createRemesso } from "remesso-sdk";
import { safeFetchText } from "remesso-sdk/node";

// npx tsx find.ts <agentId>
const reader = createRemesso({ fetchText: safeFetchText });
const found = await reader.agents.find(BigInt(process.argv[2]));
console.log(found.wallet, found.profile, found.note ?? "");
```

`safeFetchText` fetches only from public addresses. It allows HTTPS on the default port with no credentials and no redirects, and refuses any name that resolves to a private, loopback, link-local or otherwise reserved address. It then connects to the address it checked, so DNS can't be switched in between, and stops at 5 seconds or 256 KB. An `ipfs:` URI is read through a public gateway.

Without `fetchText`, a remote file isn't read: `profile` is `null` and `note` says so. Pass your own `fetchText` in other runtimes, with the same care.

## Pay the agent you found

Once you have `found.wallet`, pay it as you would any address.

**On a schedule**, as the payer:

```ts
async function subscribeTo(agentId: bigint) {
  const found = await payer.agents.find(agentId);
  if (!found.wallet) throw new Error(found.note);
  return await payer.schedules.create({ to: found.wallet, amount: "5", token: "USDT", every: "month", runs: 6 });
}
```

**As an agent, under a policy**, see [agent payments](./agent-payments.md):

```ts
async function payInvoice(agentId: bigint, invoice: string) {
  const found = await agent.agents.find(agentId);
  if (!found.wallet) throw new Error(found.note);
  return await agent.pay({ to: found.wallet, amount: "0.50", token: "USDT", idempotencyKey: `agent-${agentId}-${invoice}` });
}
```

When the profile says `reference: { required: true }`, the agent expects each payment to carry the reference of a request it sent you. Ask it for a [payment request](./payment-requests.md), then answer that request: an agent pays it with `requests.pay(id)`, which puts the reference in the payment's memo, and a schedule answers it through `schedules.create({ request: id })`.
