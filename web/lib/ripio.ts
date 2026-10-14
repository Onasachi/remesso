import type { TokenInfo } from "./config";

/// Links into Ripio's ramp for its wFIAT stablecoins: pesos or reais in from a
/// bank, or out to one.
///
/// This is what makes a peso schedule usable by somebody who is not already
/// holding wARS. Ripio's hosted ramp takes query parameters and needs no API
/// credentials (their team, 2026-10-07); the B2B API needs a company KYB we do
/// not have. With `country`, `chain`, `token` and `amount` all present the
/// user skips Ripio's form; with any missing, the ones given only prefill it.
///
/// A link and nothing more: it opens Ripio, where the user does Ripio's own
/// checks and signs nothing of ours. No credential, no callback, no
/// redirect back — Remesso never sees the bank side of either leg.
///
/// Which networks and tokens a country supports is Ripio's to decide. Celo
/// for wARS in Argentina is their own example; the others are the obvious
/// pairing and Ripio may still decline them.

const COUNTRY: Record<string, string> = { ARS: "AR", BRL: "BR", COP: "CO" };

/// `null` for a token Ripio does not ramp — every dollar stablecoin here.
export function ripioRampUrl(
  side: "on" | "off",
  token: TokenInfo,
  opts: { address?: string; amount?: string } = {},
): string | null {
  const country = COUNTRY[token.currency];
  if (!country) return null;
  const q = new URLSearchParams({
    country,
    chain: "42220",
    token: token.symbol.toUpperCase(), // Ripio's spelling: WARS, not wARS
  });
  if (opts.amount && Number(opts.amount) > 0) q.set("amount", opts.amount);
  // Ripio validates it as an EVM address; one that is not would only earn the
  // user an error page, so it is left out instead. Read on both sides (their
  // OpenRamp parser, checked 14 Oct 2026): required to buy — where the tokens
  // land — and optional to cash out, where it names the wallet they leave.
  if (opts.address && /^0x[0-9a-fA-F]{40}$/.test(opts.address)) q.set("address", opts.address);
  // `/off-ramp`, not the `/offramp` in their note: that 308s to this.
  return `https://ramp.ripio.com/${side === "off" ? "off-ramp" : ""}?${q}`;
}
