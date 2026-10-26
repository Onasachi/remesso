#!/usr/bin/env node
import { startDev } from "./dev.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "dev" || args.includes("--help")) {
    console.log("Usage: remesso-sdk dev [--smoke] [--rpc-port 18546] [--http-port 18547] [--fork-url https://forno.celo.org]\nRequires Foundry's anvil on PATH. Starts real contracts on a local Celo fork and an in-memory receiving emulator. No mainnet transactions.");
    if (args[0] !== "dev" && args.length && !args.includes("--help")) process.exitCode = 1;
    return;
  }
  let smoke = false;
  let rpcPort: number | undefined; let httpPort: number | undefined; let forkUrl: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--smoke") { smoke = true; continue; }
    if (!["--rpc-port", "--http-port", "--fork-url"].includes(arg) || !args[index + 1]) throw new Error(`unknown or incomplete argument ${arg}`);
    const value = args[++index];
    if (arg === "--rpc-port") rpcPort = Number(value);
    if (arg === "--http-port") httpPort = Number(value);
    if (arg === "--fork-url") forkUrl = value;
  }
  const controller = new AbortController();
  let startup: ReturnType<typeof startDev>;
  const shutdown = async () => {
    controller.abort();
    const running = await startup.catch(() => null);
    await running?.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  startup = startDev({ rpcPort, httpPort, forkUrl, signal: controller.signal });
  const dev = await startup;
  console.log(`Remesso local development\nReal Celo contracts on owned Anvil: ${dev.rpcUrl}\nReceiving backend: ${dev.functionsUrl} (in-memory development emulator)\nEmbedded signed webhook receiver: ${dev.receiverUrl}\nPublic Anvil test keys and SDK configuration: ${dev.envFile}\nNever fund or use these public test keys on a real network.\nBuyer agent: ${dev.accounts.buyer}\nSeller agent: ${dev.accounts.seller}\nTreasury policy owner: ${dev.accounts.treasury}\nSample one-off invoice: ${dev.sampleInvoice.id}\n\nCreate clients with rpcUrl and functionsUrl above; use chain: celo.\nWallet funding: buyer.remittances.send({funding:'wallet',to:SELLER_ADDRESS,amount:'1',token:'USDT',requestId:SAMPLE_REQUEST_ID,idempotencyKey:'my-order-1'})\nPolicy funding: treasury.policies.create({agent:BUYER_ADDRESS,token:'USDT',budget:'10',perPayment:'5',perDay:'10',recipients:[SELLER_ADDRESS]}); buyer.remittances.send({funding:'policy',payer:TREASURY_ADDRESS,policyId,to:SELLER_ADDRESS,amount:'1',token:'USDT',idempotencyKey:'my-order-2'})`);
  if (smoke) {
    try {
      const checks = await dev.smoke();
      for (const check of checks) console.log(`PASS ${check}`);
      console.log(`PASS ${checks.length} local development smoke checks; no mainnet transactions`);
    } finally { await dev.close(); process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown); }
  } else console.log("\nReady. Ctrl-C stops only this environment and removes its temporary files.");
}

main().catch((error) => { console.error(`remesso-sdk: ${(error as Error).message}`); process.exitCode = 1; });
