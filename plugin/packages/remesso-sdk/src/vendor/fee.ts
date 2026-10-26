// Copied from web/lib/fee.ts by scripts/build-sdk.ts. Edit the original and re-run;
// `build-sdk.ts --check` fails while the two differ.
/// The commission V5 takes, and what a recipient is owed, in base units.
///
/// V5 rounds its commission UP (`Math.mulDiv(amount, bps, 10_000,
/// Math.Rounding.Ceil)`), so what arrives from a gross amount is
/// `gross - ceil(gross * bps / 10_000)`. A requested amount, from a request or
/// a pay link, is what the recipient receives (docs/agent-to-agent.md, 3a,
/// decided 2026-10-24), so the form signs `grossFor(requested)`: an invoice
/// names what is owed, and the payer covers the fee on top.
///
/// A policy payment through RemessoAgentAllowance takes no fee, so none of
/// this applies there: what an agent pays is what arrives.

/// What V5 keeps from `gross`, rounded up as the contract rounds it.
export function feeOf(gross: bigint, bps: number): bigint {
  return (gross * BigInt(bps) + 9_999n) / 10_000n;
}

/// What the recipient receives from `gross`.
export function netOf(gross: bigint, bps: number): bigint {
  return gross - feeOf(gross, bps);
}

/// The smallest gross whose net is at least `net`.
///
/// `netOf` never decreases as the gross grows (each extra unit raises the fee
/// by at most one), so starting from the estimate `net / (1 - bps/10_000)` and
/// stepping a unit or two either way finds the exact answer.
export function grossFor(net: bigint, bps: number): bigint {
  if (net <= 0n) return 0n;
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error(`fee of ${bps}bps is out of range`);
  if (bps === 0) return net;
  let gross = (net * 10_000n) / (10_000n - BigInt(bps));
  while (gross > 0n && netOf(gross - 1n, bps) >= net) gross--;
  while (netOf(gross, bps) < net) gross++;
  return gross;
}
