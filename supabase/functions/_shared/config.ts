/// Central config. Everything here comes from Supabase secrets; nothing is
/// hard-coded except addresses that were verified on-chain.

export const CELO = {
  rpcUrl: Deno.env.get("CELO_RPC_URL") ?? "https://forno.celo.org",
  chainId: Number(Deno.env.get("CELO_CHAIN_ID") ?? 42220),
  /// cNGN on Celo mainnet, 6 decimals. Verified 2026-09-07.
  cngn: (Deno.env.get("CNGN_ADDRESS") ??
    "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f") as `0x${string}`,
  /// USDT on Celo, 6 decimals. The funding asset: it is the only token with a
  /// cNGN pool, so senders fund in USDT and we never need a second hop.
  usdt: (Deno.env.get("USDT_ADDRESS") ??
    "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e") as `0x${string}`,
  quoter: (Deno.env.get("UNISWAP_V3_QUOTER") ??
    "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8") as `0x${string}`,
  executor: Deno.env.get("REMESSO_EXECUTOR_ADDRESS") as `0x${string}`,
  poolFee: Number(Deno.env.get("POOL_FEE_TIER") ?? 100),
};

/// The assets a Direct schedule can pay out, named.
///
/// The contract's own allowlist is the authority — this list only lets an
/// endpoint say "USDT" and mean an address, and reject a symbol nothing here
/// can pay. Decimals are not uniform (USDm and every wFIAT are 18dp) and are
/// never assumed. Mirrors `web/lib/config.ts`.
///
/// `unitsPerUsd` scales the backend's dollar cap into each token's own units.
/// For the dollar stablecoins it is 1. For Ripio's wFIAT it is a rough rate,
/// rounded DOWN from the market (wARS, wBRL on 2026-10-06 from Textile: USD→ARS
/// 1,597, USD→BRL 4.98; the rest on 2026-10-28 from open.er-api: USD→COP 3,143,
/// MXN 18.67, CLP 989, PEN 3.45). Rounding down and letting the peso fall both
/// make the cap stricter in dollar terms, so a stale number errs toward
/// refusing a run, never toward allowing a bigger one. A peso that gains
/// breaks that: wCOP was 3,200 until the peso passed it, and a cap that
/// rounded up let a payment worth $1,018 through. Re-read when adding a token.
/// It is a backstop on the on-chain envelope, not a price a schedule pays at.
/// x402 uses it to quote a service's dollar price in a local currency
/// (`x402.ts`), where rounding down charges a little under the dollar price.
///
/// The six wFIAT are the ones Celo's x402 facilitator lists (`/supported`):
/// wARS, wBRL and wCOP since 2026-10-06, wMXN, wCLP and wPEN since 2026-10-27.
/// Each was verified on-chain when it was added: 18dp, proxies. A schedule in
/// one only exists once the owner has called `setDirectToken(token, true)` —
/// until then `createSchedule` reverts with TokenNotAllowed and this entry
/// simply names a token nobody can use.
export const DIRECT_TOKENS = [
  { symbol: "USDT", address: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", decimals: 6, unitsPerUsd: 1 },
  { symbol: "USDC", address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, unitsPerUsd: 1 },
  { symbol: "USDm", address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18, unitsPerUsd: 1 },
  { symbol: "USA₮", address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", decimals: 6, unitsPerUsd: 1 },
  { symbol: "wARS", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", decimals: 18, unitsPerUsd: 1500 },
  { symbol: "wBRL", address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0", decimals: 18, unitsPerUsd: 5 },
  { symbol: "wCOP", address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76", decimals: 18, unitsPerUsd: 3100 },
  { symbol: "wMXN", address: "0x337E7456B420bD3481e7FA61fA9850343d610d34", decimals: 18, unitsPerUsd: 18 },
  { symbol: "wCLP", address: "0x61D450a098b6a7f69fC4b98CE68198fe59768651", decimals: 18, unitsPerUsd: 950 },
  { symbol: "wPEN", address: "0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE", decimals: 18, unitsPerUsd: 3 },
  // cNGN on the DIRECT rail: the recipient receives cNGN and nothing converts —
  // no swap, no redemption, no bank. That is why the rail flags do not gate
  // it (they gate payout types, rails.ts). ~1,363 NGN/USD on 14 Oct 2026,
  // rounded DOWN like the others so the cap only ever gets stricter. 6dp.
  { symbol: "cNGN", address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", decimals: 6, unitsPerUsd: 1300 },
] as const;

export type DirectToken = (typeof DIRECT_TOKENS)[number];

/// The table entry for an address, or `undefined` for one we do not know.
export function directToken(address: string | null | undefined): DirectToken | undefined {
  const a = (address ?? "").toLowerCase();
  return DIRECT_TOKENS.find((t) => t.address.toLowerCase() === a);
}

/// Read lazily rather than snapshotted at import time. Eager reads capture
/// whatever the environment held the instant the module graph was evaluated,
/// which makes import order load-bearing and pins a missing secret to
/// `undefined` for the life of the isolate even after it is supplied.
export const CNGN_API = {
  get base(): string {
    return Deno.env.get("CNGN_API_BASE") ?? "https://api.cngn.co/v1/api";
  },
  /// The prefix selects the environment: cngn_test_... is sandbox, cngn_live_...
  /// moves real naira. Each environment has its own encryption and SSH keys.
  get apiKey(): string {
    return Deno.env.get("CNGN_API_KEY") ?? "";
  },
  /// AES-256-CBC request encryption. SHA-256'd to derive the 32-byte key.
  get encryptionKey(): string {
    return Deno.env.get("CNGN_ENCRYPTION_KEY") ?? "";
  },
  /// OpenSSH Ed25519 private key. Its public half is uploaded to the dashboard,
  /// and every response `data` field is sealed to it. Without this, responses
  /// are unreadable and requests fail with "No Test/Live SSH Key found".
  get sshPrivateKey(): string {
    return Deno.env.get("CNGN_SSH_PRIVATE_KEY") ?? "";
  },
  /// Signs inbound webhooks: X-cNGN-Signature: sha256=<hex hmac of raw body>.
  get webhookSecret(): string {
    return Deno.env.get("CNGN_WEBHOOK_SECRET") ?? "";
  },
  get isLive(): boolean {
    return this.apiKey.startsWith("cngn_live");
  },
  /// An HTTP forward proxy with a fixed egress IP, e.g.
  /// `http://user:pass@proxy.example.com:9293`.
  ///
  /// cNGN whitelists by source IP and answers 403 to everything else, and
  /// Supabase Edge Functions have no stable egress address. Routing cNGN
  /// traffic through one proxy is what makes a whitelist entry possible.
  /// Unset means direct, which only works where the runtime's own IP is
  /// whitelisted.
  get egressProxyUrl(): string {
    return Deno.env.get("CNGN_EGRESS_PROXY_URL") ?? "";
  },
};

/// Self identity verification. Optional: with no API key the feature reports
/// itself unavailable and nothing else changes.
export const SELF_API = {
  get base(): string {
    return (Deno.env.get("SELF_API_BASE") ?? "https://edge.dashboard.self.xyz").replace(/\/+$/, "");
  },
  /// sk_test_... accepts the Self app's mock passports; sk_live_... needs a
  /// real one. The key alone picks the environment.
  get apiKey(): string {
    return Deno.env.get("SELF_API_KEY") ?? "";
  },
  /// The Pre-KYC flow deployed in the Self dashboard. Its config (OFAC, minimum
  /// age) lives there, not here, and each environment has its own flow.
  get flowId(): string {
    return Deno.env.get("SELF_FLOW_ID") ?? "";
  },
  /// `whsec_...`, generated by Self when the webhook endpoint is added.
  get webhookSecret(): string {
    return Deno.env.get("SELF_WEBHOOK_SECRET") ?? "";
  },
  get isConfigured(): boolean {
    return Boolean(this.apiKey && this.flowId);
  },
};

export const LIMITS = {
  /// Backend slippage bound, tightened on top of the contract's own floor.
  maxSlippageBps: Number(Deno.env.get("MAX_SLIPPAGE_BPS") ?? 100),
  /// Refuse to execute above this even if the on-chain envelope permits it.
  /// The cNGN/USDT pool holds roughly $95k; a single large run is the one way
  /// to eat real slippage. Measured 2026-09-07: $1k costs 0.06%, $10k costs
  /// 0.56%, $50k costs 2.7%.
  maxRunAmountUsdt: Number(Deno.env.get("MAX_RUN_AMOUNT_USDT") ?? 1000),
  /// Abort a run if the pool cannot fill it inside this bound.
  maxAcceptableImpactBps: 150,
  /// Refuse runs below this, in dollars. A run costs the executor ~$0.002 in
  /// gas whatever its size, and 0.25% of anything under ~$0.70 does not cover
  /// it — so a one-unit schedule was a way to make us pay gas forever
  /// (solidity-auditor scan 2026-10-16). $1 keeps every run above break-even.
  minRunAmountUsd: Number(Deno.env.get("MIN_RUN_AMOUNT_USD") ?? 1),
};

/// Why the backend will not run `amountIn` of `token`, or null if it will.
///
/// One check for every caller that moves money — the cron, a paid trigger and
/// the sync that adopts schedules — so a rule cannot hold on one path and be
/// missing from another (the paid trigger skipped all of these before
/// 2026-10-16). An asset missing from the table is refused, never assumed 6dp.
export function runAmountProblem(token: string | null | undefined, amountIn: bigint): string | null {
  const asset = directToken(token ?? CELO.usdt);
  if (!asset) return `funding asset ${token} is not in the backend token list`;
  const unit = 10n ** BigInt(asset.decimals);
  const cap = BigInt(LIMITS.maxRunAmountUsdt) * BigInt(asset.unitsPerUsd);
  if (amountIn > cap * unit) return `amount exceeds backend cap of ${cap} ${asset.symbol}`;
  // `unitsPerUsd` is rounded down, so this minimum is a little under a dollar
  // for the peso tokens — the lenient direction for a floor.
  const min = BigInt(LIMITS.minRunAmountUsd) * BigInt(asset.unitsPerUsd);
  if (amountIn < min * unit) return `amount is below the backend minimum of ${min} ${asset.symbol}`;
  return null;
}

/// The smallest and largest `amountIn` the backend runs for `asset`, in base
/// units: the bounds `runAmountProblem` applies, for publishing. `/agent`
/// states them so a payer sees them before signing a schedule that would never
/// run; `config.test.ts` holds them to `runAmountProblem` itself.
export function runLimits(asset: { decimals: number; unitsPerUsd: number }): { min: bigint; max: bigint } {
  const unit = 10n ** BigInt(asset.decimals);
  return {
    min: BigInt(LIMITS.minRunAmountUsd) * BigInt(asset.unitsPerUsd) * unit,
    max: BigInt(LIMITS.maxRunAmountUsdt) * BigInt(asset.unitsPerUsd) * unit,
  };
}

export function requireEnv(): void {
  const missing = [
    ["REMESSO_EXECUTOR_ADDRESS", CELO.executor],
    ["CNGN_API_KEY", CNGN_API.apiKey],
    ["CNGN_ENCRYPTION_KEY", CNGN_API.encryptionKey],
    ["CNGN_SSH_PRIVATE_KEY", CNGN_API.sshPrivateKey],
    ["EXECUTOR_PRIVATE_KEY", Deno.env.get("EXECUTOR_PRIVATE_KEY")],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing secrets: ${missing.join(", ")}`);

  // A test key against mainnet Celo would swap real USDT and then try to redeem
  // it in a sandbox that never pays out. Catch it here, not in production.
  const key = CNGN_API.apiKey;
  if (!key.startsWith("cngn_test") && !key.startsWith("cngn_live")) {
    throw new Error("CNGN_API_KEY must start with cngn_test or cngn_live");
  }
  if (CELO.chainId === 42220 && !CNGN_API.isLive) {
    throw new Error(
      "refusing to run: Celo mainnet is configured with a cNGN sandbox key",
    );
  }
}
