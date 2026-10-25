/// Celo attribution tag (ERC-8021) for every transaction Remesso sends.
///
/// A short suffix appended after the calldata. The EVM discards trailing bytes,
/// so the contract sees exactly the arguments it always saw and execution is
/// unchanged — the suffix only lets Celo trace a transaction back to the app
/// that produced it. That data feeds ecosystem reward distribution and cannot
/// be claimed retroactively: an untagged transaction is unattributed forever.
///
/// Encoded here rather than via `@celo/attribution-tags`, which the frontend
/// does use. Schema 0 is four concatenated pieces and nothing more, and this
/// module sits in the path of every remittance — a dependency there earns its
/// place or stays out. `attribution.test.ts` pins the output to the SDK's own.
///
/// One fixed code, not the SDK's hostname-derived one: the executor has no
/// hostname, and a hostname code would change the moment the frontend moves
/// off ngrok onto a real domain, splitting one app's history in two.
/// `remesso` is a custom code — it tags immediately, and having it credited on
/// the attribution dashboard is a registry step with the Celo team.

/// Several codes, one suffix. `remesso` is the app's own history; a hackathon
/// credits only the code it issued (Agents on Open Rails: `celo_5cd35ca55baf`,
/// assigned by Loops at enrolment). ERC-8021 Schema 0 carries a list as one
/// comma-joined code field, which the SDK's `withAttribution([...])` writes
/// and `verifyTx` splits — so each code is credited, neither displaces the
/// other, and dropping the event code later is an env change, not a redeploy
/// of anything on-chain.
///
/// The encoding itself is in `erc8021.ts`, which the SDK carries a copy of.
import { integratorCodes, OWN_CODES, suffixFor } from "./erc8021.ts";

export { parseSuffix, suffixFor } from "./erc8021.ts";

/// Comma-separated in `ATTRIBUTION_CODE`. The default carries both, so a
/// deploy that forgets the variable still tags for the event.
export const ATTRIBUTION_CODES = (Deno.env.get("ATTRIBUTION_CODE") ?? "remesso,celo_5cd35ca55baf")
  .toLowerCase()
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

/// The app's own code, first by convention — what `/agent` advertises.
export const ATTRIBUTION_CODE = ATTRIBUTION_CODES[0] ?? "remesso";

export const attributionSuffix = suffixFor(ATTRIBUTION_CODES);

/// Every code that is ours: what we carry now and what we ever wrote. None of
/// them is an integrator's.
export const OUR_CODES: readonly string[] = [...new Set([...OWN_CODES, ...ATTRIBUTION_CODES])];

/// The suffix for a run of a schedule whose creator tagged its transaction
/// (Phase 6, builder codes): ours first, then up to three of theirs, so
/// Celo credits the volume to both. If the two don't fit in one suffix, ours
/// alone: a run is never left untagged for an integrator's sake.
export function runSuffix(theirs: readonly string[] = [], ours: readonly string[] = ATTRIBUTION_CODES): `0x${string}` | undefined {
  const extra = integratorCodes(theirs, [...OUR_CODES, ...ours]);
  return (extra.length ? suffixFor([...ours, ...extra]) : undefined) ?? suffixFor(ours);
}
