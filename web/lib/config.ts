/// Browser-visible configuration. Everything here is public by construction:
/// contract addresses, an RPC URL and the Supabase anon key. No cNGN
/// credential of any kind may appear in this file — those live only in the
/// cngn-proxy Edge Function.

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 42220);

export const RPC_URL =
  process.env.NEXT_PUBLIC_CELO_RPC_URL ?? "https://forno.celo.org";

export const EXECUTOR_ADDRESS =
  (process.env.NEXT_PUBLIC_REMESSO_EXECUTOR_ADDRESS ?? "") as `0x${string}`;

export type TokenInfo = {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  /// Shown in MiniPay's own balance list. A recipient paid in anything else
  /// sees nothing, and MiniPay has no custom-token import.
  miniPayVisible: boolean;
  /// What one unit is worth. Only "USD" tokens are summed into a dollar total
  /// or compared against dollar amounts — a wARS is a peso, and adding it 1:1
  /// would overstate a balance by about 1,500 times.
  currency: "USD" | "NGN" | "ARS" | "BRL" | "COP";
};

/// Decimals are pinned beside every address on purpose. They are NOT uniform:
/// USDT, USDC and USA₮ are 6dp, USDm is 18dp. Assuming one for the other is a factor
/// of 10^12 — the same trap cNGN (6dp) and Mento's NGNm (18dp) set.
/// All four verified on-chain 2026-09-17.
export const USDT: TokenInfo = {
  address: (process.env.NEXT_PUBLIC_USDT_ADDRESS ??
    "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e") as `0x${string}`,
  symbol: "USDT",
  currency: "USD",
  decimals: 6,
  miniPayVisible: true,
};

export const USDC: TokenInfo = {
  address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  symbol: "USDC",
  currency: "USD",
  decimals: 6,
  miniPayVisible: true,
};

/// Mento's dollar, formerly cUSD. Its on-chain symbol is "USDm" and MiniPay
/// shows it under that name, so that is what we call it too — a sender
/// looking for "cUSD" in their wallet would not find it.
export const CUSD: TokenInfo = {
  address: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
  symbol: "USDm",
  currency: "USD",
  decimals: 18,
  miniPayVisible: true,
};

/// Tether's US-regulated dollar (Anchorage-issued), 6dp. Its EIP-712 domain is
/// "Tether America USD" v1 and an 18dp fee adapter reports the same symbol, so
/// the address is the identity.
///
/// MiniPay supports it as of 13 Oct 2026: the wallet's own Manual deposit
/// screen lists "Supported tokens: USDT, USDC, USDm, USAT". MiniPay's developer
/// docs (token table, FAQ) had not caught up that day and still named three —
/// the app is what recipients see, so it is what we follow.
export const USAT: TokenInfo = {
  address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771",
  symbol: "USA₮",
  currency: "USD",
  decimals: 6,
  miniPayVisible: true,
};

export const CNGN: TokenInfo = {
  address: (process.env.NEXT_PUBLIC_CNGN_ADDRESS ??
    "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f") as `0x${string}`,
  symbol: "cNGN",
  currency: "NGN",
  decimals: 6,
  miniPayVisible: false,
};

/// Ripio's wFIAT: local-currency stablecoins backed 1:1, all 18dp. These are
/// the three Celo's x402 facilitator lists (`/supported`, 2026-10-06), each
/// verified on-chain that day. MiniPay shows none of them, so a recipient
/// needs another wallet to see the balance — the form says so.
export const WARS: TokenInfo = {
  address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D",
  symbol: "wARS",
  decimals: 18,
  miniPayVisible: false,
  currency: "ARS",
};

export const WBRL: TokenInfo = {
  address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0",
  symbol: "wBRL",
  decimals: 18,
  miniPayVisible: false,
  currency: "BRL",
};

export const WCOP: TokenInfo = {
  address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76",
  symbol: "wCOP",
  decimals: 18,
  miniPayVisible: false,
  currency: "COP",
};

/// Assets the Direct rail can handle — sender funds in one of these and the
/// recipient receives the same asset, unswapped. The contract's allowlist
/// decides which a NEW schedule may use (`useAllowedDirectTokens`); this list
/// is what we can name and format, including for schedules already signed.
export const DIRECT_TOKENS: TokenInfo[] = [USDT, USDC, CUSD, USAT, WARS, WBRL, WCOP];

const BY_ADDRESS: Record<string, TokenInfo> = Object.fromEntries(
  [...DIRECT_TOKENS, CNGN].map((t) => [t.address.toLowerCase(), t]),
);

/// Resolve a token by address. Falls back to USDT because every pre-V3 schedule
/// was funded in it; an unknown address would otherwise format as 6dp silently.
export function tokenFor(address?: string | null): TokenInfo {
  return (address && BY_ADDRESS[address.toLowerCase()]) || USDT;
}

/// Uniswap V3 is the only cNGN venue on Celo. The frontend touches it purely to
/// quote a live rate, so the sender's floor is set against the real market
/// rather than a number they guessed.
export const QUOTER = (process.env.NEXT_PUBLIC_UNISWAP_V3_QUOTER ??
  "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8") as `0x${string}`;

export const POOL_FEE = Number(process.env.NEXT_PUBLIC_POOL_FEE_TIER ?? 100);

/// Where bank payouts are delivered on-chain. Empty means the question in the
/// README is still open, and the UI offers wallet payouts only rather than
/// letting a sender authorise a destination we are not sure of.
export const CNGN_REDEMPTION_ADDRESS = (
  process.env.NEXT_PUBLIC_CNGN_REDEMPTION_ADDRESS ?? ""
).trim() as `0x${string}` | "";

/// Both cNGN rails, off by default.
///
/// Paying anyone in naira — into a wallet as cNGN, or into a bank account —
/// is the part of Remesso with an open regulatory question: instructing naira
/// payouts to third parties is a money-transmission matter, and the cNGN
/// account is not verified. Until that is settled the product is stablecoin
/// only, which needs no cNGN API, no payout partner and no licence question.
///
/// Nothing is deleted. The contract still has the rails, the backend still
/// runs them, and existing schedules of either kind still render everywhere.
/// This only decides what a sender may newly authorise, and one env var
/// brings it back: NEXT_PUBLIC_ENABLE_CNGN_RAILS=1.
export const CNGN_RAILS_ENABLED = process.env.NEXT_PUBLIC_ENABLE_CNGN_RAILS === "1";

export const BANK_PAYOUTS_ENABLED =
  CNGN_RAILS_ENABLED && /^0x[a-fA-F0-9]{40}$/.test(CNGN_REDEMPTION_ADDRESS);

export const EXPLORER =
  CHAIN_ID === 42220 ? "https://celoscan.io" : "https://celo-sepolia.blockscout.com";

export function isConfigured(): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(EXECUTOR_ADDRESS);
}
