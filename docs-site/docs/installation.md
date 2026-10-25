---
title: Installation and setup
sidebar_label: Installation
description: Install remesso-sdk, create a client for a server, a browser wallet or read-only use, and keep its keys safe.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

This page covers installing the SDK, the three ways to create a client, and how to handle the keys it signs with.

## Requirements

- **Node 20 or later.** The SDK also runs in Deno through `npm:` specifiers.
- **ES modules.** The package is ESM. In a Node project, set `"type": "module"` in `package.json` or use `.mjs` and `.mts` files. Node 20.19 and 22.12 or later can also `require()` it from CommonJS.
- **viem 2.21 or later** as a peer dependency. The SDK signs and reads through viem, and accepts viem accounts and clients.
- **Celo mainnet.** The SDK refuses to sign on any other chain. There is no testnet.

## Install

<Tabs groupId="package-manager">
<TabItem value="npm" label="npm" default>

```bash
npm install remesso-sdk viem
```

</TabItem>
<TabItem value="pnpm" label="pnpm">

```bash
pnpm add remesso-sdk viem
```

</TabItem>
<TabItem value="yarn" label="yarn">

```bash
yarn add remesso-sdk viem
```

</TabItem>
<TabItem value="deno" label="Deno">

```ts nocheck
import { createRemesso } from "npm:remesso-sdk@0.2.0";
```

</TabItem>
</Tabs>

The package has two entry points:

| Import | For |
|---|---|
| `remesso-sdk` | Everything that runs anywhere: the client, webhook verification, token and fee helpers. |
| `remesso-sdk/node` | Node only: `fileStore` (agent payment records on disk), `safeFetchText` and `toNodeListener`. |

## Create a client

Every feature hangs off one client, created with `createRemesso`. What you pass decides what it can do.

### With a private key

On a server, in a script or in an agent, give it a viem account. The client can then pay, create schedules, sign requests and subscribe to webhooks.

```ts title="client.ts"
import { createRemesso } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const remesso = createRemesso({
  account: privateKeyToAccount(process.env.REMESSO_KEY as `0x${string}`),
});

console.log(remesso.address); // the account's address
```

### With a browser wallet

In a web app, pass the user's own wallet as a viem wallet client on Celo. The user approves each transaction in their wallet. Agent payments are the exception: they are signed before they are sent, so they need a local account like the one above.

```ts title="browser.ts"
import { createRemesso } from "remesso-sdk";
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { celo } from "viem/chains";

declare const ethereum: EIP1193Provider; // window.ethereum, injected by the wallet

const [address] = await ethereum.request({ method: "eth_requestAccounts" });
const wallet = createWalletClient({ account: address, chain: celo, transport: custom(ethereum) });

const remesso = createRemesso({ walletClient: wallet });
```

### Read-only

Without an account, the client reads: schedules, policies, requests, payment events and agents. Methods that need a signer throw a `no_account` error, and methods that default to "this account" need an address.

```ts title="reader.ts"
import { createRemesso } from "remesso-sdk";

const reader = createRemesso();

const schedule = await reader.schedules.get(4);
const { events } = await reader.events.list({ address: schedule.to, role: "to" });
console.log(schedule.runsExecuted, "of", schedule.maxRuns, "payments sent;", events.length, "events");
```

## Options

The options you will use most:

| Option | Default | What it does |
|---|---|---|
| `account` | none | A viem account that signs. |
| `walletClient` | none | A viem wallet client instead of an account. |
| `rpcUrl` | `https://forno.celo.org` | A Celo mainnet RPC. The SDK checks it answers chain 42220 before signing anything. |
| `store` | memory | Where agent payments are recorded so a retry pays once. Use `fileStore()` in production. |
| `builderCodes` | none | Your own ERC-8021 codes. See [builder codes](./guides/builder-codes.md). |

Every option is in the [client reference](./reference/client.md#createremessooptions).

## Keys and safety

The SDK signs with whatever key you give it, and Remesso has no way to reverse a payment.

- **Keep keys out of code.** Read them from the environment or a secrets manager, and never commit them.
- **One key per role.** The wallet that pays on a schedule, the agent's key and the receiving address do different jobs. Keeping them apart limits what one leaked key can do.
- **Hold only what you need.** A schedule spends through an ERC-20 approval, and an agent spends within its policy. Both are limits you set: keep them close to what you intend to pay.
- **The receiving key is optional.** Receiving needs only an address. You need its key only to subscribe to webhooks, answer or decline requests, or sign as that address.

## Check your setup

This reads the chain and Remesso's backend without signing anything:

```ts title="check.ts"
import { CHAIN_ID, createRemesso, EXECUTOR, FEE_BPS } from "remesso-sdk";

const reader = createRemesso();
console.log("chain", CHAIN_ID, "executor", EXECUTOR, "fee", FEE_BPS / 100, "%");
console.log("rpc answers chain", await reader.publicClient.getChainId());
```

## Next steps

- [Core concepts](./concepts.md): how schedules, the executor and finality fit together.
- [Quickstart](./quickstart.md): a first payment and its webhook.
