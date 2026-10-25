import { NextResponse } from "next/server";

/// The agent card: what you get by handing somebody one URL.
///
/// Until now pointing an agent at Remesso meant naming a Supabase project id,
/// which nobody types and nobody trusts. This is the conventional place to
/// look — an agent handed the app's origin and nothing else can find every
/// endpoint, the contract, and the registry entry from here.
///
/// **It points; it does not copy.** No prices, no currencies, no EIP-712
/// domains. The ERC-8004 entry went stale precisely because it restated facts
/// that then changed, and a second copy on a second host is a second thing to
/// forget. Anything that can move lives behind `capabilities` and is read from
/// the deployment that owns it.
///
/// Open CORS on purpose: a browser-side agent that cannot read this cannot
/// discover anything, and there is nothing here that is not already public.
export const dynamic = "force-static";

const FUNCTIONS = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "") +
  "/functions/v1";

export async function GET() {
  return NextResponse.json(
    {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Remesso",
      description:
        "Recurring stablecoin payments on Celo, bound by a mandate the payer " +
        "signs on-chain. An agent can be paid by a schedule, ask to be paid, " +
        "pay for services over x402, or commit its own wallet to paying on a " +
        "schedule. Nothing can redirect, resize or extend a payment once " +
        "signed — the contract enforces it, not the operator.",

      /// Start here. Prices, currencies and refusals are generated from what
              /// is actually deployed, so they cannot disagree with it.
      capabilities: `${FUNCTIONS}/agent`,

      /// How to integrate, written for an agent to load rather than a person
      /// to read.
      skill: "https://bitbucket.org/crackedstudios/remesso/raw/main/skills/remesso/SKILL.md",

      /// Every skill we publish, as data: names, install commands, and for the
      /// paid ones a manifest of assets, EIP-712 domains and prices generated
      /// from the live 402 (`scripts/build-skill-manifest.ts`).
      skills: "https://bitbucket.org/crackedstudios/remesso/raw/main/skills/manifest.json",

      endpoints: [
        { name: "capabilities", url: `${FUNCTIONS}/agent`, method: "GET" },
        { name: "request-payment", url: `${FUNCTIONS}/request-payment`, method: "POST" },
        { name: "payment-events", url: `${FUNCTIONS}/payment-events`, method: "GET" },
        { name: "webhooks", url: `${FUNCTIONS}/webhooks`, method: "POST" },
        { name: "naira-rate", url: `${FUNCTIONS}/rate-service`, method: "POST" },
        { name: "latam-rate", url: `${FUNCTIONS}/latam-rate`, method: "POST" },
        { name: "latam-route", url: `${FUNCTIONS}/latam-route`, method: "POST" },
        { name: "trigger-run", url: `${FUNCTIONS}/trigger-run`, method: "POST" },
      ],

      payment: {
        protocol: "x402",
        /// Which versions and currencies: ask `capabilities`, or just send an
        /// unpaid request and read the 402. The quote is the price.
        discover: "POST without a payment header and read the 402",
      },

      contracts: [
        {
          name: "RemessoExecutorV5",
          address: process.env.NEXT_PUBLIC_REMESSO_EXECUTOR_ADDRESS ?? null,
          chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 42220),
          role: "enforces every mandate; the authority on what may move",
        },
      ],

      registrations: [
        {
          standard: "ERC-8004",
          agentId: 9867,
          registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
          chainId: 42220,
        },
        {
          standard: "self-agent-id",
          agentId: 191,
          registry: "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944",
          note: "Soulbound to a human verified by zero-knowledge passport proof.",
        },
      ],

      source: "https://bitbucket.org/crackedstudios/remesso",
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        // Worth caching — it changes about as often as the contract does.
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
