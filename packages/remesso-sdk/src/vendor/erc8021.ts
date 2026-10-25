// Copied from supabase/functions/_shared/erc8021.ts by scripts/build-sdk.ts. Edit the original and re-run;
// `build-sdk.ts --check` fails while the two differ.
/// ERC-8021 Schema 0: writing a suffix, reading one back, and which of the
/// codes an integrator's transaction carries ride on the runs that follow it.
///
/// Pure, with no environment, so `remesso-sdk` carries an exact copy
/// (`scripts/build-sdk.ts`): a builder code the SDK accepts is one the backend
/// keeps. `attribution.ts` adds Remesso's own configured codes on top.
/// `attribution.test.ts` pins both directions to `@celo/attribution-tags`.

/// `[code:N][length:1][schema:1][marker:16]`
export const MARKER = "80218021802180218021802180218021";
const SCHEMA_0 = "00";

/// What Celo's SDK accepts in `toDataSuffix`.
export const CODE = /^[a-z0-9_]{1,32}$/;

/// Remesso's own codes, whether or not they're carried today. `remesso-sdk`
/// 0.1.0 writes both on every transaction, so a schedule created with it
/// after the event code leaves `ATTRIBUTION_CODE` must not hand that code
/// back to our runs as if it were an integrator's.
export const OWN_CODES: readonly string[] = ["remesso", "celo_5cd35ca55baf"];

/// How many of an integrator's codes ride on each run. Each costs calldata
/// gas on every run, and three cover an app, a wallet and one partner.
export const MAX_INTEGRATOR_CODES = 3;

/// The suffix for one code or several, or `undefined` if none is usable.
///
/// Never throws: a malformed tag must not be the reason a remittance fails to
/// go out. A bad code is dropped and the rest still tag — a typo in one must
/// not cost the other its credit, since an untagged transaction stays
/// untagged forever. A comma inside a single code is refused rather than read
/// as a list; a list is passed as an array.
export function suffixFor(codes: string | readonly string[]): `0x${string}` | undefined {
  const list = (typeof codes === "string" ? [codes] : codes).filter((code) => {
    if (CODE.test(code)) return true;
    console.error("attribution code must be 1-32 of [a-z0-9_]:", code);
    return false;
  });
  if (list.length === 0) return undefined;
  const field = list.join(",");
  // The length is one byte.
  if (field.length > 255) return undefined;
  const hex = [...new TextEncoder().encode(field)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const length = field.length.toString(16).padStart(2, "0");
  return `0x${hex}${length}${SCHEMA_0}${MARKER}`;
}

/// The codes in a transaction's Schema 0 suffix, read from the end the way
/// Celo's `fromDataSuffix` reads them: the marker, the schema byte, the length
/// byte, then that many bytes of comma-joined codes, returned as written.
///
/// Null when there is no suffix, when it is another schema (Schema 2's roles
/// aren't read), or when the length runs past the start of the input. ox
/// reads whatever bytes are there in that last case; nothing honest writes it.
export function parseSuffix(input: string): { codes: string[] } | null {
  const hex = input.toLowerCase().replace(/^0x/, "");
  if (hex.length % 2 !== 0 || hex.length < 36 || !/^[0-9a-f]*$/.test(hex)) return null;
  if (hex.slice(-32) !== MARKER || hex.slice(-34, -32) !== SCHEMA_0) return null;
  const length = parseInt(hex.slice(-36, -34), 16);
  if (length === 0 || hex.length < 36 + length * 2) return null;
  const field = hex.slice(-36 - length * 2, -36);
  const bytes = Uint8Array.from(field.match(/../g)!, (b) => parseInt(b, 16));
  return { codes: new TextDecoder().decode(bytes).split(",") };
}

/// Which of a creating transaction's codes ride on a schedule's runs: Celo's
/// charset, none of Remesso's own (they're carried anyway), no repeats, and
/// the first three in the order written.
export function integratorCodes(codes: readonly string[], own: readonly string[] = OWN_CODES): string[] {
  const out: string[] = [];
  for (const code of codes) {
    if (!CODE.test(code) || own.includes(code) || out.includes(code)) continue;
    out.push(code);
    if (out.length === MAX_INTEGRATOR_CODES) break;
  }
  return out;
}
