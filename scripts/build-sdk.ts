/// Write the generated parts of `packages/remesso-sdk/src/`, or check them.
///
/// The SDK describes a deployment, and people will believe an SDK that
/// describes something we no longer serve (docs/agent-to-agent.md, step 4). So
/// nothing in it about the deployment is typed by hand:
///
/// - `generated/deployment.ts`, from `deployments/celo-mainnet.json`, which
///   `build-deployments.ts` writes from what is live;
/// - `generated/abi.ts`, from the compiled ABIs in `indexer/abis/`;
/// - `vendor/`, exact copies of the code the backend and the app run: the
///   webhook and decline signatures, the fee, the payee profile reader, the
///   Node safe fetch and the ERC-8021 rules for builder codes. A payer signs
///   what the backend verifies because it is the same file.
///
///   deno run --allow-read --allow-write scripts/build-sdk.ts
///
/// `--check` writes nothing and exits 1 on drift, so a change to any source
/// file shows here until the SDK is regenerated.
const check = Deno.args.includes("--check");
const SDK = "packages/remesso-sdk/src";

const VENDOR: [from: string, to: string][] = [
  ["supabase/functions/_shared/standard-webhooks.ts", "vendor/standard-webhooks.ts"],
  ["supabase/functions/_shared/webhook-actions.ts", "vendor/webhook-actions.ts"],
  ["supabase/functions/_shared/request-decline.ts", "vendor/request-decline.ts"],
  ["supabase/functions/_shared/erc8021.ts", "vendor/erc8021.ts"],
  ["web/lib/fee.ts", "vendor/fee.ts"],
  ["web/lib/payee-profile.ts", "vendor/payee-profile.ts"],
  ["web/lib/safe-fetch.ts", "vendor/safe-fetch.ts"],
];

const ABIS: [name: string, from: string][] = [
  ["executorAbi", "indexer/abis/RemessoExecutorV5.json"],
  ["allowanceAbi", "indexer/abis/RemessoAgentAllowance.json"],
];

const header = (from: string) =>
  `// Copied from ${from} by scripts/build-sdk.ts. Edit the original and re-run;\n` +
  `// \`build-sdk.ts --check\` fails while the two differ.\n`;

const outputs = new Map<string, string>();

for (const [from, to] of VENDOR) {
  outputs.set(to, header(from) + await Deno.readTextFile(from));
}

const manifest = JSON.parse(await Deno.readTextFile("deployments/celo-mainnet.json"));
outputs.set(
  "generated/deployment.ts",
  header("deployments/celo-mainnet.json") +
    "\n/// Celo mainnet as Remesso runs it: contracts, tokens with their per-run\n" +
    "/// limits, the fee, and the public endpoints.\n" +
    `export const deployment = ${JSON.stringify(manifest, null, 2)} as const;\n`,
);

let abi = header("indexer/abis/") + "\n";
for (const [name, from] of ABIS) {
  const raw = JSON.parse(await Deno.readTextFile(from));
  const entries = Array.isArray(raw) ? raw : raw.abi;
  abi += `export const ${name} = ${JSON.stringify(entries, null, 2)} as const;\n\n`;
}
outputs.set("generated/abi.ts", abi.trimEnd() + "\n");

let drift = 0;
for (const [path, body] of outputs) {
  const full = `${SDK}/${path}`;
  if (check) {
    let current = "";
    try {
      current = await Deno.readTextFile(full);
    } catch {
      console.error(`build-sdk: ${full} is missing; run without --check`);
      drift++;
      continue;
    }
    if (current !== body) {
      console.error(`build-sdk: ${full} has drifted from its source; run without --check`);
      drift++;
    }
  } else {
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, body);
  }
}
if (check) {
  if (drift) Deno.exit(1);
  console.log(`${outputs.size} generated files in ${SDK} match their sources`);
} else {
  console.log(`wrote ${outputs.size} generated files in ${SDK}`);
}
