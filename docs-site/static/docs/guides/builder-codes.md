# Builder codes

> Put your own ERC-8021 code on the schedules you create, so Celo credits their volume to you on every payment.

Source: https://docs.remesso.xyz/docs/guides/builder-codes

This guide shows how to get credit for the payments your app brings to Celo: your builder code goes on the transaction that creates a schedule, and Remesso's executor carries it on every payment of that schedule.

## What is a builder code?

A builder code is a short name for your app, written after a transaction's calldata in the format [ERC-8021](https://github.com/celo-org/attribution-tags) defines. The EVM ignores those trailing bytes, so the code changes nothing about what the transaction does. It only records who caused it. Celo reads these codes to credit activity to the apps that produced it, and a transaction that went out untagged can't be credited later.

Remesso tags every transaction it causes with its own codes. Builder codes add yours.

## Why the executor carries your code

You sign one transaction to create a schedule, but its payments are sent later, one by one, by Remesso's executor. Without builder codes, those payments would carry only Remesso's codes, and the volume your schedule moves would never be credited to you.

So the executor reads your codes from the transaction that created the schedule and puts them, after its own, on every payment of it, for as long as the schedule runs.

## Add your code

Pass `builderCodes` when you create the client:

```ts title="pay.ts"
import { createRemesso } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const payer = createRemesso({
  account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`),
  builderCodes: ["your_code"],
});

const s = await payer.schedules.create({ to: "0xRecipient", amount: "5", token: "USDT", every: "month", runs: 12 });
console.log("schedule", s.id, "created in", s.hash);
```

Every transaction this client sends carries Remesso's codes and then yours: the approval, the schedule, policies and agent payments. Each payment of the schedule then carries Remesso's codes and yours.

`attribution: false` leaves Remesso's codes out and keeps yours.

## The rules

The SDK checks your codes when you create the client, by the same rules the executor applies, and throws a `RemessoError` with code [`invalid`](../reference/errors.md#invalid) for any it wouldn't carry:

- up to three codes;
- each 1 to 32 characters of lowercase `a` to `z`, `0` to `9` and `_`, as Celo's attribution codes are;
- no repeats;
- none of Remesso's own codes, `remesso` and `celo_5cd35ca55baf`: those are carried anyway.

Register your code with Celo so its volume is credited to you. Tagging works either way.

## Check that it was read

About a minute after the schedule is created, Remesso's indexer has read its transaction. The schedule's `schedule_created` [payment event](./payment-events.md) lists what it found under `details.builderCodes`:

```ts
const { events } = await payer.events.list({ role: "from", kinds: ["schedule_created"] });
const created = events.find((e) => e.refId === scheduleId.toString());
console.log(created?.details?.builderCodes); // ["your_code"]
```

An empty list means the transaction carried none of yours.

To check a payment itself, read its transaction with `verifyTx` from Celo's [`@celo/attribution-tags`](https://www.npmjs.com/package/@celo/attribution-tags), which returns every code its suffix carries:

```ts
import { verifyTx } from "@celo/attribution-tags";
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";

const client = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
const tag = await verifyTx({ client, hash: "0x…" }); // a run's txHash, from a payment event or a webhook
console.log(tag?.codes); // ["remesso", "celo_5cd35ca55baf", "your_code"]
```

## Tag without the SDK

If you create schedules with your own code, tag the `createSchedule` transaction yourself. `withAttribution` from `@celo/attribution-tags` adds the suffix to every transaction a viem wallet client sends, and `toDataSuffix` returns it for you to append:

```ts
import { withAttribution } from "@celo/attribution-tags";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";

const wallet = createWalletClient({
  account: privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`),
  chain: celo,
  transport: http("https://forno.celo.org"),
}).extend(withAttribution("your_code"));
```

The executor reads Schema 0, the format both functions write: a list of codes. It doesn't read Schema 2 (roles such as app and wallet). A schedule created through an ERC-4337 bundle isn't read yet either: the executor reads the outer transaction, which is the bundler's.

`attributionFor` from remesso-sdk gives the suffix with Remesso's codes first and yours after, checked by the same rules, for a transaction you send yourself:

```ts
import { attributionFor } from "remesso-sdk";

const suffix = attributionFor(["your_code"]); // pass it as viem's dataSuffix
console.log(suffix);
```

## What it doesn't change

The suffix sits after the calldata, where the contract never reads it. A builder code changes who is credited, never what a payment does: the recipient, the amount and the cadence are the ones the payer signed. If your codes and Remesso's don't fit in one suffix, the executor sends Remesso's alone rather than leave a payment untagged.
