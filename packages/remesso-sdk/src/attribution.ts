/// ERC-8021 attribution, after the calldata where the EVM ignores it:
/// Remesso's code plus the one Loops issued for Agents on Open Rails. It
/// credits the app that caused a transaction and changes nothing it does.
/// The same suffix the Remesso app and the plugin wallet put on every write.
/// Byte-identical to `toDataSuffix(["remesso", "celo_5cd35ca55baf"])` from
/// `@celo/attribution-tags`; `test/basics.test.ts` pins it to the backend's
/// own encoder.
import type { Hex } from "viem";
import { RemessoError } from "./errors.js";
import { CODE, MAX_INTEGRATOR_CODES, OWN_CODES, suffixFor } from "./vendor/erc8021.js";

export const ATTRIBUTION =
  "0x72656d6573736f2c63656c6f5f356364333563613535626166190080218021802180218021802180218021" as const;

/// What `ATTRIBUTION` carries.
const OURS = ["remesso", "celo_5cd35ca55baf"] as const;

/// The suffix with your own builder codes after ours. Put on the transaction
/// that creates a schedule, they ride on every run of it too: Remesso's
/// executor reads them and tags each run with them, so Celo counts the volume
/// for you as well as for us.
///
/// Checked by the rules the backend applies (`vendor/erc8021.ts`), so a code
/// accepted here is one the runs carry: Celo's charset, none of Remesso's own,
/// no repeats, at most three. `ours: false` leaves our codes out.
export function attributionFor(builderCodes: readonly string[] = [], ours = true): Hex | undefined {
  for (const code of builderCodes) {
    if (!CODE.test(code)) {
      throw new RemessoError("invalid", `builder code ${JSON.stringify(code)}: 1 to 32 of a-z, 0-9 and _, as Celo's attribution codes are`);
    }
    if (OWN_CODES.includes(code)) throw new RemessoError("invalid", `${code} is Remesso's own code: pass yours`);
  }
  if (new Set(builderCodes).size !== builderCodes.length) throw new RemessoError("invalid", "a builder code is repeated");
  if (builderCodes.length > MAX_INTEGRATOR_CODES) {
    throw new RemessoError("invalid", `at most ${MAX_INTEGRATOR_CODES} builder codes ride on a schedule's runs`);
  }
  const codes = [...(ours ? OURS : []), ...builderCodes];
  return codes.length ? suffixFor(codes) : undefined;
}
