/// ERC-8021 attribution, after the calldata where the EVM ignores it:
/// Remesso's code plus the one Loops issued for Agents on Open Rails. It
/// credits the app that caused a transaction and changes nothing it does.
/// The same suffix the Remesso app and the plugin wallet put on every write.
/// Byte-identical to `toDataSuffix(["remesso", "celo_5cd35ca55baf"])` from
/// `@celo/attribution-tags`; `test/attribution.test.ts` pins it to the
/// backend's own encoder.
export const ATTRIBUTION =
  "0x72656d6573736f2c63656c6f5f356364333563613535626166190080218021802180218021802180218021" as const;
