/// The deployment, and tokens by symbol or address.
///
/// Everything here is generated from `deployments/celo-mainnet.json`, which is
/// generated from what is live. Tokens are matched by address: several Celo
/// tokens have fee-currency adapters that report the same symbol with other
/// decimals, and a symbol can be spelled more than one way (USA₮, USD₮).
import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import { deployment } from "./generated/deployment.js";
import { RemessoError } from "./errors.js";

export { deployment };

export type Token = (typeof deployment.tokens)[number];

export const CHAIN_ID = deployment.chain.chainId;
export const EXECUTOR = deployment.contracts.RemessoExecutorV5.address as Address;
export const ALLOWANCE = deployment.contracts.RemessoAgentAllowance.address as Address;
export const REGISTRY = deployment.contracts.ERC8004IdentityRegistry.address as Address;
/// Stored as a schedule's trigger, address(1) means "whoever is Remesso's
/// executor now", so a key rotation moves the grant.
export const CURRENT_EXECUTOR = deployment.contracts.RemessoExecutorV5.currentExecutorSentinel as Address;
/// The commission a schedule created now pins, in basis points. Taken from the
/// payment, rounded up. Policy payments take none.
export const FEE_BPS: number = deployment.contracts.RemessoExecutorV5.feeBps;

/// Other spellings people and agents use.
const ALIASES: Record<string, string> = {
  USAT: "USA₮",
  "USD₮": "USDT",
  USDT0: "USDT",
  CUSD: "USDm",
};

/// A token by symbol (any case; USAT for USA₮, cUSD for USDm) or address, or
/// undefined.
export function findToken(symbolOrAddress: string): Token | undefined {
  const s = String(symbolOrAddress).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    return deployment.tokens.find((t) => t.address.toLowerCase() === s.toLowerCase());
  }
  const upper = s.toUpperCase();
  const name = ALIASES[upper] ?? s;
  return deployment.tokens.find((t) => t.symbol.toUpperCase() === name.toUpperCase());
}

/// A token by symbol or address. Throws for one Remesso doesn't know.
export function token(symbolOrAddress: string): Token {
  const t = findToken(symbolOrAddress);
  if (!t) {
    throw new RemessoError(
      "invalid",
      `unknown token ${symbolOrAddress}: Remesso takes ${deployment.tokens.map((x) => x.symbol).join(", ")}`,
    );
  }
  return t;
}

/// A decimal amount in a token's own units, e.g. "2.50" USDT → 2_500_000n.
/// Strings only: a float in between is how precision is lost.
export function toUnits(amount: string, t: Token): bigint {
  const s = String(amount).trim();
  if (!/^\d{1,30}(\.\d+)?$/.test(s)) throw new RemessoError("invalid", `amount must be a decimal string, like "2.50" (got ${amount})`);
  const decimals = s.split(".")[1]?.length ?? 0;
  if (decimals > t.decimals) throw new RemessoError("invalid", `${t.symbol} has ${t.decimals} decimals; ${amount} has ${decimals}`);
  return parseUnits(s, t.decimals);
}

/// Base units as a decimal string with the symbol, e.g. "0.9975 USA₮".
export function formatAmount(units: bigint | string, tokenOrAddress: Token | string): string {
  const t = typeof tokenOrAddress === "string" ? findToken(tokenOrAddress) : tokenOrAddress;
  if (!t) return `${units} units of ${tokenOrAddress}`;
  return `${formatUnits(BigInt(units), t.decimals)} ${t.symbol}`;
}

/// What Remesso's executor runs per payment, gross, in base units. Outside
/// these a schedule is valid on-chain and never runs.
export function runLimits(t: Token): { min: bigint; max: bigint } {
  if (!t.directAllowed || t.minPerRun == null || t.maxPerRun == null) {
    throw new RemessoError("refused", `${t.symbol} isn't accepted for new schedules`);
  }
  return { min: BigInt(t.minPerRun), max: BigInt(t.maxPerRun) };
}

export const checksum = (a: string): Address => {
  try {
    return getAddress(a);
  } catch {
    throw new RemessoError("invalid", `not an address: ${a}`);
  }
};
