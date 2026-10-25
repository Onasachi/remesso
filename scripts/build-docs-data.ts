/// Copy the deployment manifest into the documentation site, or check it.
///
/// The docs show contract addresses, tokens, decimals and per-payment limits.
/// Those are believed, so none of them is typed into a page: the site renders
/// them from `docs-site/src/data/deployment.json`, an exact copy of
/// `deployments/celo-mainnet.json` (which `build-deployments.ts` writes from
/// what is live).
///
///   deno run --allow-read --allow-write scripts/build-docs-data.ts
///
/// `--check` writes nothing and exits 1 while the copy differs.
const check = Deno.args.includes("--check");
const FROM = "deployments/celo-mainnet.json";
const TO = "docs-site/src/data/deployment.json";

const source = JSON.stringify(JSON.parse(await Deno.readTextFile(FROM)), null, 2) + "\n";
let current: string | null = null;
try {
  current = await Deno.readTextFile(TO);
} catch { /* not written yet */ }

if (current === source) {
  console.log(`${TO} matches ${FROM}`);
} else if (check) {
  console.error(`${TO} differs from ${FROM}: run scripts/build-docs-data.ts`);
  Deno.exit(1);
} else {
  await Deno.writeTextFile(TO, source);
  console.log(`wrote ${TO} from ${FROM}`);
}
