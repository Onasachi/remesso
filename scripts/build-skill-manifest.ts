/// Write `skills/remesso-x402/manifest.json` and the `skills/manifest.json`
/// index from what is DEPLOYED, not from what anyone remembers.
///
/// The ERC-8004 entry went stale because it restated prices and currencies by
/// hand; a manifest is the same kind of file, read by agents that will believe
/// it. So the payment terms here are copied out of the live 402 — the one
/// place they cannot be wrong — and the service list out of `/agent`.
/// Re-run after any change to prices, assets or endpoints:
///
///   deno run --allow-net --allow-write --allow-read scripts/build-skill-manifest.ts
///
/// `--check` writes nothing and exits 1 if the committed files differ from
/// what is live, for CI or a cron.

const FUNCTIONS = "https://engaboljiqudghvzmebq.supabase.co/functions/v1";
const APP = "https://remesso-3q67.vercel.app";
const RAW = "https://raw.githubusercontent.com/crackedstudio/Remesso/main";
const check = Deno.args.includes("--check");

type Accept = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
};

/// The v2 price list rides in a base64 `PAYMENT-REQUIRED` header; an unpaid
/// POST costs nothing and is exactly what a paying agent sees first.
async function quote(url: string): Promise<{ accepts: Accept[]; extensions?: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await res.body?.cancel();
  const h = res.headers.get("payment-required");
  if (res.status !== 402 || !h) throw new Error(`${url}: expected a v2 402, got ${res.status}`);
  return JSON.parse(atob(h));
}

const agent = await (await fetch(`${FUNCTIONS}/agent`)).json();
const live = await quote(`${FUNCTIONS}/rate-service`);

// Symbols and decimals are not in a 402 — only addresses and EIP-712 domains.
// Taken from the capability document, matched by ADDRESS: each of these has an
// 18dp fee adapter on Celo reporting the same symbol().
const named = new Map<string, string>();
for (const s of agent.services ?? []) {
  for (const a of s.payment?.assets ?? []) named.set(a.address.toLowerCase(), a.symbol);
}
const DISPLAY: Record<string, string> = { USDT: "USD₮", USAT: "USA₮" };

const assets = live.accepts.map((a) => {
  const symbol = named.get(a.asset.toLowerCase()) ?? "?";
  return {
    symbol: DISPLAY[symbol] ?? symbol,
    address: a.asset,
    decimals: 6,
    eip712: a.extra,
  };
});
if (assets.some((a) => a.symbol === "?")) throw new Error("a 402 asset is missing from /agent");

// Every paid service's price, from /agent. trigger-run only quotes for a
// schedule that allows it (403 otherwise, before any price), so its amount
// cannot be read from an anonymous 402 the way rate-service's is.
const services = (agent.services ?? [])
  .filter((s: { payment?: { protocol?: string } }) => s.payment?.protocol === "x402")
  .map((s: { name: string; description: string; endpoint: string; method: string; input?: unknown; payment: { amount: string } }) => ({
    name: s.name,
    description: s.description,
    endpoint: s.endpoint,
    method: s.method,
    input: s.input ?? (s.name === "trigger-run" ? { scheduleId: "number — an on-chain V4 schedule id" } : {}),
    price: { amount: s.payment.amount, decimals: 6, usd: Number(s.payment.amount) / 1e6 },
  }));

const payTo = [...new Set(live.accepts.map((a) => a.payTo))];
if (payTo.length !== 1) throw new Error(`more than one payTo in the 402: ${payTo}`);

const x402Manifest = {
  $schema: `${RAW}/skills/manifest.schema.json`,
  manifestVersion: 1,
  name: "remesso-x402",
  version: "1.0.0",
  description:
    "Pay Remesso's paid HTTP services on Celo mainnet over x402 v2 — in USA₮ by default (USDC and USD₮ also accepted), gasless for the payer. " +
    "Use it to buy live NGN rates or to bring a scheduled stablecoin payment forward.",
  skill: { entry: "SKILL.md", url: `${RAW}/skills/remesso-x402/SKILL.md` },
  homepage: APP,
  repository: "https://github.com/crackedstudio/Remesso",
  license: "MIT",
  install: {
    npxSkills: "npx skills add crackedstudio/Remesso --skill remesso-x402",
    npm: ["@x402/fetch@2.28.0", "@x402/evm@2.28.0", "viem"],
    run: "node scripts/pay.mjs --service naira-rate",
  },
  payment: {
    protocol: "x402",
    version: 2,
    scheme: "exact",
    network: "eip155:42220",
    chain: { name: "Celo", chainId: 42220, rpc: "https://forno.celo.org" },
    payTo: payTo[0],
    facilitator: agent.services?.find((s: { payment?: { facilitator?: string } }) => s.payment?.facilitator)?.payment.facilitator ??
      "https://api.x402.celo.org",
    gas: "paid by the facilitator — the payer needs the token, not CELO",
    // What the skill pays in unless told otherwise. A preference, not a
    // requirement: every asset below is accepted at the same price.
    defaultAsset: assets.find((a) => a.symbol === "USA₮")?.address ?? null,
    assets,
    builderCode: (live.extensions?.["builder-code"] as { info?: unknown } | undefined)?.info ?? null,
    authoritative: "the PAYMENT-REQUIRED header of an unpaid request — this file is a snapshot of it",
  },
  services,
  discovery: {
    capabilities: `${FUNCTIONS}/agent`,
    agentCard: `${APP}/.well-known/agent.json`,
    erc8004: { registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", agentIds: [9867, 9879], chainId: 42220 },
  },
  snapshotOf: { rateService402: `${FUNCTIONS}/rate-service`, capabilities: `${FUNCTIONS}/agent` },
};

const index = {
  $schema: `${RAW}/skills/manifest.schema.json`,
  manifestVersion: 1,
  publisher: "Remesso",
  repository: "https://github.com/crackedstudio/Remesso",
  skills: [
    {
      name: "remesso",
      description:
        "Send, receive and schedule stablecoin payments on Celo as an agent: be paid by a schedule, ask to be paid, " +
        "commit a wallet to paying on a schedule, or bring a payment forward.",
      skill: `${RAW}/skills/remesso/SKILL.md`,
      install: "npx skills add crackedstudio/Remesso --skill remesso",
    },
    {
      name: "remesso-x402",
      description: x402Manifest.description,
      skill: x402Manifest.skill.url,
      manifest: `${RAW}/skills/remesso-x402/manifest.json`,
      install: x402Manifest.install.npxSkills,
    },
  ],
};

const files: Record<string, unknown> = {
  "skills/remesso-x402/manifest.json": x402Manifest,
  "skills/manifest.json": index,
};

let drift = false;
for (const [path, body] of Object.entries(files)) {
  const next = JSON.stringify(body, null, 2) + "\n";
  const prev = await Deno.readTextFile(path).catch(() => "");
  if (prev === next) {
    console.log(`${path}: current`);
  } else if (check) {
    console.log(`${path}: DIFFERS from what is live`);
    drift = true;
  } else {
    await Deno.writeTextFile(path, next);
    console.log(`${path}: written`);
  }
}
if (drift) Deno.exit(1);
