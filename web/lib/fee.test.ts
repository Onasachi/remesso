// deno test --allow-env --unstable-sloppy-imports web/lib/fee.test.ts
//
// Pins the gross-up to V5's own arithmetic. A requested amount is what the
// recipient receives, and the contract rounds its commission UP, so a gross
// one unit short nets one unit short: the invoice would arrive underpaid.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { feeOf, grossFor, netOf } from "./fee";

Deno.test("the fee rounds up, as V5 rounds it", () => {
  assertEquals(feeOf(1_000_000n, 25), 2_500n); // V5's first run: 1 USA₮ in, 0.9975 out
  assertEquals(netOf(1_000_000n, 25), 997_500n);
  assertEquals(feeOf(100_001n, 25), 251n); // 250.0025 rounds up
  assertEquals(feeOf(1n, 25), 1n); // the smallest amount still pays a unit
});

Deno.test("5 USDT requested: send 5.012532, and exactly 5 arrives", () => {
  assertEquals(grossFor(5_000_000n, 25), 5_012_532n);
  assertEquals(netOf(5_012_532n, 25), 5_000_000n);
  assert(netOf(5_012_531n, 25) < 5_000_000n, "one unit less nets short");
});

Deno.test("small and large amounts, and 18dp tokens", () => {
  assertEquals(grossFor(100_000n, 25), 100_251n); // 0.10 USDT
  assertEquals(netOf(100_251n, 25), 100_000n);
  const wars = 1_000n * 10n ** 18n; // 1,000 wARS
  const g = grossFor(wars, 25);
  assert(netOf(g, 25) >= wars && netOf(g - 1n, 25) < wars);
  assertEquals(g, 1_002_506_265_664_160_401_003n);
});

Deno.test("always the smallest gross that covers the request", () => {
  for (const bps of [1, 25, 50]) {
    for (let net = 1n; net < 30_000n; net += 7n) {
      const g = grossFor(net, bps);
      assert(netOf(g, bps) >= net, `${net} at ${bps}bps: ${g} nets short`);
      assert(netOf(g - 1n, bps) < net, `${net} at ${bps}bps: ${g} is not the smallest`);
    }
  }
});

Deno.test("no fee, nothing, or a nonsense fee", () => {
  assertEquals(grossFor(5_000_000n, 0), 5_000_000n);
  assertEquals(grossFor(0n, 25), 0n);
  assertThrows(() => grossFor(1n, 10_000));
  assertThrows(() => grossFor(1n, -1));
});
