/// A seller invoice, a buyer agent and an independently verified receipt.
/// Run with: deno run --allow-all --config examples/sdk.deno.json
/// --unstable-sloppy-imports examples/agent-to-agent.ts request|pay|verify
/// `pay` only previews until you explicitly add --send. Celo mainnet is real money.
import { createRemesso, RemessoError } from "remesso-sdk";
import { fileRemittanceStore, fileStore, safeFetchText } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Set ${name}`);
  return value;
}
const command = Deno.args[0];
const rpcUrl = Deno.env.get("RPC_URL");
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);

try {
  if (command === "request") {
    const seller = createRemesso({ account: privateKeyToAccount(required("SELLER_KEY") as Hex), rpcUrl });
    const invoice = await seller.requests.create({
      payer: required("PAYER_ADDRESS"), amount: required("AMOUNT"), token: Deno.env.get("TOKEN") ?? "USDT",
      runs: 1, from: "Example seller agent", note: "One service delivery",
    });
    console.log(json(invoice));
  } else if (command === "pay") {
    const funding = required("FUNDING");
    if (funding !== "wallet" && funding !== "policy") throw new Error("FUNDING must be wallet or policy");
    const buyer = createRemesso({
      account: privateKeyToAccount(required("BUYER_KEY") as Hex), rpcUrl, fetchText: safeFetchText,
      store: fileStore(Deno.env.get("POLICY_STORE")),
      remittanceStore: fileRemittanceStore(Deno.env.get("WALLET_STORE")),
    });
    const requestId = required("REQUEST_ID");
    const invoice = await buyer.requests.get(requestId);
    const fundingOptions = funding === "wallet" ? { funding: "wallet" as const }
      : { funding: "policy" as const, policyId: required("POLICY_ID") };
    const agentId = Deno.env.get("SELLER_AGENT_ID");
    const discovered = agentId ? await buyer.agents.find(agentId) : undefined;
    console.log(json({ preview: true, funding, signer: buyer.address, invoice, discovered }));
    if (!Deno.args.includes("--send")) {
      console.log("Preview only. Review the invoice and funding, then add --send to sign and broadcast.");
    } else {
      const payment = agentId
        ? await buyer.agents.pay(agentId, { ...fundingOptions, requestId, expectedWallet: required("SELLER_ADDRESS") })
        : await buyer.remittances.send({ ...fundingOptions, requestId, to: required("SELLER_ADDRESS"), amount: required("AMOUNT"), token: Deno.env.get("TOKEN") ?? "USDT", idempotencyKey: `request:${requestId}` });
      console.log(json(payment));
      if (payment.status === "pending") console.log("Retry the same command and request key to recover; do not invent a new payment key.");
    }
  } else if (command === "verify") {
    const reader = createRemesso({ rpcUrl });
    const proof = await reader.receipts.verify({
      txHash: required("TX_HASH") as Hex, from: required("PAYER_ADDRESS"), to: required("SELLER_ADDRESS"),
      token: Deno.env.get("TOKEN") ?? "USDT", amount: required("AMOUNT"),
      ...(Deno.env.get("POLICY_ID") ? { policyId: required("POLICY_ID"), memo: required("REQUEST_ID").replaceAll("-", "") } : { scheduleId: required("SCHEDULE_ID") }),
      finality: Deno.env.get("FINALITY") === "included" ? "included" : "finalized",
    });
    console.log(json(proof));
    console.log("Persist proof.eventId in the same database transaction as fulfillment so a retry cannot fulfill twice.");
  } else {
    console.log("Commands: request, pay [--send], verify. See docs-site/docs/guides/agent-to-agent.md for environment variables.");
  }
} catch (error) {
  console.error(error instanceof RemessoError ? json({ code: error.code, message: error.message, details: error.details }) : String(error));
  Deno.exitCode = 1;
}
