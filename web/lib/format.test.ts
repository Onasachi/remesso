// deno test --allow-env --unstable-sloppy-imports web/lib/format.test.ts
//
// Pins how the fee lines on the review screen show small amounts. Two
// decimals turned a 0.10 USDT schedule's 0.00025 fee into "0.00" and the
// recipient's 0.09975 into "0.09" — a cent that looked like it went missing.
import { assertEquals } from "jsr:@std/assert@1";
import { formatExact, formatUnits } from "./format";

Deno.test("small fees and payouts keep their real value", () => {
  assertEquals(formatExact(250n, 6), "0.00025"); // 0.25% of 0.10 USDT
  assertEquals(formatExact(99_750n, 6), "0.09975"); // what the recipient gets
  assertEquals(formatUnits(99_750n, 6), "0.09"); // the old display, for contrast
});

Deno.test("round amounts still read as money", () => {
  assertEquals(formatExact(2_500_000n, 6), "2.50");
  assertEquals(formatExact(997_500_000_000_000_000_000n, 18), "997.50"); // wARS
  assertEquals(formatExact(20_000_000_000n, 6), "20,000.00");
});

Deno.test("18dp tokens stop at six decimals", () => {
  assertEquals(formatExact(123_456_789_000_000n, 18), "0.000123");
});
