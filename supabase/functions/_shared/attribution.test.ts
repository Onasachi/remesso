/// Pins our ERC-8021 encoder to the output of Celo's own SDK.
///
/// The expected values below were produced by `@celo/attribution-tags` 0.5.0
/// (`toDataSuffix(code)`), which the frontend imports directly. The backend
/// encodes the suffix itself — see attribution.ts — so this is what keeps the
/// two identical: one wrong byte and Celo's indexer sees no tag at all, which
/// fails silently and forever.
///
///   deno test --allow-env supabase/functions/_shared/attribution.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { ATTRIBUTION_CODES, attributionSuffix, parseSuffix, runSuffix, suffixFor } from "./attribution.ts";
import { integratorCodes } from "./erc8021.ts";

Deno.test("matches the SDK byte for byte", () => {
  assertEquals(suffixFor("remesso"), "0x72656d6573736f070080218021802180218021802180218021");
  assertEquals(
    suffixFor("celo_test1234"),
    "0x63656c6f5f74657374313233340d0080218021802180218021802180218021",
  );
  // The code Loops issued for Agents on Open Rails, alone — equal to the
  // `celo.dataSuffix` that `loops project get` returns for the entry.
  assertEquals(
    suffixFor("celo_5cd35ca55baf"),
    "0x63656c6f5f356364333563613535626166110080218021802180218021802180218021",
  );
});

Deno.test("carries several codes the way the SDK does", () => {
  // `toDataSuffix(["remesso", "celo_5cd35ca55baf"])` from 0.5.0, which
  // `fromDataSuffix` decodes back to both codes. This is what every Remesso
  // transaction carries during the hackathon.
  assertEquals(
    suffixFor(["remesso", "celo_5cd35ca55baf"]),
    "0x72656d6573736f2c63656c6f5f356364333563613535626166190080218021802180218021802180218021",
  );
  assertEquals(suffixFor([]), undefined);
  assertEquals(
    suffixFor(["remesso", "Bad"]),
    suffixFor("remesso"),
    "a bad code is dropped, not allowed to untag the rest",
  );
});

Deno.test("carries the marker and schema the indexer looks for", () => {
  const s = suffixFor("remesso")!;
  assertEquals(s.slice(-32), "80218021802180218021802180218021", "16-byte ERC-8021 marker");
  assertEquals(s.slice(-34, -32), "00", "schema 0");
  assertEquals(s.slice(-36, -34), "07", "length of 'remesso'");
});

Deno.test("refuses a code the encoder cannot represent", () => {
  // Uppercase, punctuation, spaces and over-long codes are all rejected by the
  // spec's charset. Returning undefined leaves the transaction untagged rather
  // than writing bytes an indexer would discard anyway.
  for (const bad of ["Remesso", "remesso pay", "remesso,app", "", "x".repeat(33)]) {
    assertEquals(suffixFor(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---- reading a suffix back (Phase 6: builder codes) ----
//
// Each input below was written by `@celo/attribution-tags` 0.5.0, and each
// expected list is what its `fromDataSuffix` returned for it, except where a
// comment says we read less on purpose.

Deno.test("reads codes back as the SDK does", () => {
  // toDataSuffix("acme_app")
  assertEquals(parseSuffix("0x61636d655f617070080080218021802180218021802180218021")?.codes, ["acme_app"]);
  // toDataSuffix(["remesso", "celo_5cd35ca55baf", "acme_app"])
  assertEquals(
    parseSuffix("0x72656d6573736f2c63656c6f5f3563643335636135356261662c61636d655f617070220080218021802180218021802180218021")?.codes,
    ["remesso", "celo_5cd35ca55baf", "acme_app"],
  );
  // A call's input with toDataSuffix(["acme_app", "other_app"]) after it: the
  // suffix is read from the end, whatever comes before.
  const call = `0x5f0c3c4a${"00".repeat(31)}01${"ab".repeat(32)}`;
  assertEquals(parseSuffix(`${call}61636d655f6170702c6f746865725f617070120080218021802180218021802180218021`)?.codes, ["acme_app", "other_app"]);
  assertEquals(parseSuffix(call), null, "no suffix");
  assertEquals(parseSuffix(suffixFor(["remesso", "celo_5cd35ca55baf"])!)?.codes, ["remesso", "celo_5cd35ca55baf"], "our own, round trip");
});

Deno.test("returns codes as written, and reads Schema 0 only", () => {
  // A hand-made suffix with a capital letter: the SDK decodes it as written,
  // and so do we. Which codes count is decided after (integratorCodes).
  assertEquals(parseSuffix("0x41636d652c6f6b5f636f64650c0080218021802180218021802180218021")?.codes, ["Acme", "ok_code"]);
  // toRoleDataSuffix({ app: "acme_app" }): Schema 2, which the SDK decodes to
  // ["acme_app"]. We read Schema 0 only, the one toDataSuffix and
  // withAttribution write; the developer page says so.
  assertEquals(parseSuffix("0xa161616861636d655f617070000c0280218021802180218021802180218021"), null);
  // A length byte (9) longer than what precedes it. ox reads the 2 bytes that
  // are there ("ab"); a suffix like this is malformed, so it reads as none.
  assertEquals(parseSuffix("0x6162090080218021802180218021802180218021"), null);
  assertEquals(parseSuffix("0x0080218021802180218021802180218021"), null, "shorter than a suffix");
  assertEquals(parseSuffix("0x000080218021802180218021802180218021"), null, "a length of zero names no codes");
  assertEquals(parseSuffix("not hex"), null);
});

Deno.test("an integrator's codes: valid, not ours, no repeats, at most three", () => {
  assertEquals(integratorCodes(["remesso", "celo_5cd35ca55baf", "acme_app"]), ["acme_app"], "ours are carried anyway");
  assertEquals(integratorCodes(["Acme", "acme app", "x".repeat(33), "", "ok_code"]), ["ok_code"], "Celo's charset only");
  assertEquals(integratorCodes(["a", "b", "a", "c", "d"]), ["a", "b", "c"], "the first three, in order, once each");
  assertEquals(integratorCodes([]), []);
});

Deno.test("a run carries its schedule's integrator codes after ours", () => {
  if (ATTRIBUTION_CODES.join(",") === "remesso,celo_5cd35ca55baf") {
    // Byte for byte what toDataSuffix(["remesso", "celo_5cd35ca55baf", "acme_app"]) writes.
    assertEquals(
      runSuffix(["acme_app"]),
      "0x72656d6573736f2c63656c6f5f3563643335636135356261662c61636d655f617070220080218021802180218021802180218021",
    );
  }
  assertEquals(runSuffix([]), attributionSuffix, "no integrator: exactly what every run carried before");
  assertEquals(runSuffix(["remesso", "Bad"]), attributionSuffix, "nothing of theirs left to carry");
  assertEquals(parseSuffix(runSuffix(["acme_app", "acme_app", "b", "c", "d"])!)?.codes, [...ATTRIBUTION_CODES, "acme_app", "b", "c"]);
  // The event code is ours even after it stops being carried: a schedule
  // made with remesso-sdk 0.1.0 doesn't hand it back to our runs.
  assertEquals(runSuffix(["celo_5cd35ca55baf", "acme_app"], ["remesso"]), suffixFor(["remesso", "acme_app"]));
  // Ours and theirs past the one-byte length: ours alone, never untagged.
  const long = Array.from({ length: 7 }, (_, i) => `${i}`.repeat(32));
  assertEquals(runSuffix(["x".repeat(32), "y".repeat(32), "z".repeat(32)], long), suffixFor(long));
});
