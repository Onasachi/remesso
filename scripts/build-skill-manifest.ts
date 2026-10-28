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
const APP = "https://remesso.xyz";
const RAW = "https://bitbucket.org/crackedstudios/remesso/raw/main";
const check = Deno.args.includes("--check");

type Accept = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod?: string };
};

/// The v2 price list rides in a base64 `PAYMENT-REQUIRED` header; an unpaid
/// POST costs nothing and is exactly what a paying agent sees first.
async function quote(url: string): Promise<{ accepts: Accept[]; extensions?: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await res.body?.cancel();
  const h = res.headers.get("payment-required");
  if (res.status !== 402 || !h) throw new Error(`${url}: expected a v2 402, got ${res.status}`);
  // UTF-8, as @x402/core encodes it: wBRL's EIP-712 name is "Real Brasileño".
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(h), (c) => c.charCodeAt(0))));
}

const agent = await (await fetch(`${FUNCTIONS}/agent`)).json();
const live = await quote(`${FUNCTIONS}/rate-service`);

// Symbols and decimals are not in a 402 — only addresses and EIP-712 domains.
// Taken from the capability document, matched by ADDRESS: USD₮, USDC and USA₮
// each have an 18dp fee adapter on Celo reporting the same symbol().
type Priced = { symbol: string; address: string; decimals: number; amount: string };
const named = new Map<string, Priced>();
for (const s of agent.services ?? []) {
  for (const a of (s.payment?.assets ?? []) as Priced[]) named.set(a.address.toLowerCase(), a);
}
const DISPLAY: Record<string, string> = { USDT: "USD₮", USAT: "USA₮" };

const assets = live.accepts.map((a) => {
  const known = named.get(a.asset.toLowerCase());
  if (!known || typeof known.decimals !== "number") throw new Error(`${a.asset} is in the 402 but /agent gives no symbol and decimals`);
  return {
    symbol: DISPLAY[known.symbol] ?? known.symbol,
    address: a.asset,
    decimals: known.decimals,
    // Permit2 for the wFIAT: the payer signs a Permit2 transfer and an
    // EIP-2612 permit the facilitator sponsors, not an EIP-3009 authorisation.
    transfer: a.extra.assetTransferMethod ?? "eip3009",
    eip712: { name: a.extra.name, version: a.extra.version },
  };
});

// Every paid service's price, from /agent. trigger-run only quotes for a
// schedule that allows it (403 otherwise, before any price), so its amount
// cannot be read from an anonymous 402 the way rate-service's is.
const services = (agent.services ?? [])
  .filter((s: { payment?: { protocol?: string } }) => s.payment?.protocol === "x402")
  .map((s: { name: string; description: string; endpoint: string; method: string; input?: unknown; payment: { amount: string; assets: Priced[] } }) => ({
    name: s.name,
    description: s.description,
    endpoint: s.endpoint,
    method: s.method,
    input: s.input ?? (s.name === "trigger-run" ? { scheduleId: "number — an on-chain V4 schedule id" } : {}),
    // The dollar price, and the same price in each asset's own base units.
    price: {
      amount: s.payment.amount,
      decimals: 6,
      usd: Number(s.payment.amount) / 1e6,
      assets: Object.fromEntries(assets.map((a) => {
        const amount = s.payment.assets.find((p) => p.address.toLowerCase() === a.address.toLowerCase())?.amount;
        if (!amount) throw new Error(`/agent gives ${s.name} no price in ${a.symbol}`);
        return [a.address, amount];
      })),
    },
  }));

const payTo = [...new Set(live.accepts.map((a) => a.payTo))];
if (payTo.length !== 1) throw new Error(`more than one payTo in the 402: ${payTo}`);

const x402Manifest = {
  $schema: `${RAW}/skills/manifest.schema.json`,
  manifestVersion: 1,
  name: "remesso-x402",
  version: "1.0.0",
  description:
    "Pay Remesso's paid HTTP services on Celo mainnet over x402 v2 — in USA₮ by default (USDC, USD₮ and Ripio's wARS, wBRL, wCOP, wMXN, wCLP and wPEN also accepted), gasless for the payer. " +
    "Use it to buy live NGN rates, peso and real prices and delivery routes, or to bring a scheduled stablecoin payment forward.",
  skill: { entry: "SKILL.md", url: `${RAW}/skills/remesso-x402/SKILL.md` },
  homepage: APP,
  repository: "https://bitbucket.org/crackedstudios/remesso",
  license: "MIT",
  install: {
    npxSkills: "npx -y remesso-wallet skills",
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
    // requirement: every asset below is accepted at the same dollar price.
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

// The SDK skill describes itself; its pages are written by build-ai-docs.ts.
const sdkDescription = (await Deno.readTextFile("skills/remesso-sdk/SKILL.md")).match(/^description: (.+)$/m)?.[1];
if (!sdkDescription) throw new Error("skills/remesso-sdk/SKILL.md has no description");

const index = {
  $schema: `${RAW}/skills/manifest.schema.json`,
  manifestVersion: 1,
  publisher: "Remesso",
  repository: "https://bitbucket.org/crackedstudios/remesso",
  skills: [
    {
      name: "remesso",
      description:
        "Send, receive and schedule stablecoin payments on Celo as an agent: be paid by a schedule, ask to be paid, " +
        "commit a wallet to paying on a schedule, or bring a payment forward.",
      skill: `${RAW}/skills/remesso/SKILL.md`,
      install: "npx -y remesso-wallet skills",
    },
    {
      name: "remesso-x402",
      description: x402Manifest.description,
      skill: x402Manifest.skill.url,
      manifest: `${RAW}/skills/remesso-x402/manifest.json`,
      install: x402Manifest.install.npxSkills,
    },
    {
      name: "remesso-sdk",
      description: sdkDescription,
      skill: `${RAW}/skills/remesso-sdk/SKILL.md`,
      install: "npx -y remesso-wallet skills",
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
