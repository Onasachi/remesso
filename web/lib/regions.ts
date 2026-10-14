import type { TokenInfo } from "./config";

/// How the app groups its tokens for people rather than for the contract:
/// dollars (what MiniPay shows), Latin America (Ripio's wFIAT) and Nigeria
/// (cNGN). Derived from `currency`, so a new token lands in the right group
/// without an edit here.
export type Region = "usd" | "latam" | "ng";

export const REGIONS: Array<{ key: Region; label: string; long: string; icon?: string; flags: string }> = [
  { key: "usd", label: "Dollars", long: "Dollars", icon: "paid", flags: "" },
  { key: "latam", label: "LatAm", long: "Latin America", flags: "🇦🇷🇧🇷🇨🇴" },
  { key: "ng", label: "Nigeria", long: "Nigeria", flags: "🇳🇬" },
];

export function regionOf(t: TokenInfo): Region {
  if (t.currency === "USD") return "usd";
  if (t.currency === "NGN") return "ng";
  return "latam";
}

const FLAG: Partial<Record<TokenInfo["currency"], string>> = { ARS: "🇦🇷", BRL: "🇧🇷", COP: "🇨🇴", NGN: "🇳🇬" };
const COUNTRY: Partial<Record<TokenInfo["currency"], string>> = {
  ARS: "Argentina",
  BRL: "Brazil",
  COP: "Colombia",
  NGN: "Nigeria",
};

/// The country flag of a local-currency token; "" for dollars.
export const flagOf = (t: TokenInfo) => FLAG[t.currency] ?? "";
/// The country a local-currency token belongs to; "" for dollars.
export const countryOf = (t: TokenInfo) => COUNTRY[t.currency] ?? "";
