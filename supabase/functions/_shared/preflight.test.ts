// deno test supabase/functions/_shared/preflight.test.ts
//
// Pins what the pre-flight agent decides to tell a sender, and how urgently.
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { decide, dollarValueMovePct, type Facts } from "./preflight.ts";

const usdt = (n: number) => BigInt(Math.round(n * 1e6));
const base: Facts = {
  amountIn: usdt(20), balance: usdt(100), allowance: usdt(100), decimals: 6, symbol: "USDT",
  dueInSecs: 20 * 3600, runsLeft: 5, rateMovePct: null, usdNow: null,
};
const kinds = (f: Partial<Facts>) => decide({ ...base, ...f }).map((n) => `${n.kind}:${n.severity}`);

Deno.test("a healthy payment raises nothing", () => {
  assertEquals(kinds({}), []);
});

Deno.test("short balance: warn a day out, urgent within six hours", () => {
  assertEquals(kinds({ balance: usdt(15) }), ["balance_short:warn"]);
  assertEquals(kinds({ balance: usdt(15), dueInSecs: 2 * 3600 }), ["balance_short:urgent"]);
  const [n] = decide({ ...base, balance: usdt(15) });
  assertEquals(n.details.shortBy, 5);
});

Deno.test("allowance too low for the next payment", () => {
  assertEquals(kinds({ allowance: usdt(10) }), ["allowance_short:warn"]);
});

Deno.test("allowance covers the next payment but not the one after", () => {
  assertEquals(kinds({ allowance: usdt(30) }), ["allowance_ending:info"]);
  // …unless the next payment is the last one: nothing comes after it.
  assertEquals(kinds({ allowance: usdt(30), runsLeft: 1 }), []);
  // Unlimited schedules always have a payment after the next.
  assertEquals(kinds({ allowance: usdt(30), runsLeft: null }), ["allowance_ending:info"]);
});

Deno.test("both problems at once are two notices, two fixes", () => {
  assertEquals(kinds({ balance: usdt(1), allowance: usdt(1) }), ["balance_short:warn", "allowance_short:warn"]);
});

Deno.test("a peso payment's dollar value moving: 3% info, 8% warn, 2% nothing", () => {
  assertEquals(kinds({ rateMovePct: -2 }), []);
  assertEquals(kinds({ rateMovePct: -4.2 }), ["rate_moved:info"]);
  assertEquals(kinds({ rateMovePct: 9 }), ["rate_moved:warn"]);
});

Deno.test("a weaker peso is a fall in the payment's dollar value", () => {
  // 1,600 → 1,680 ARS per dollar: the same pesos buy ~4.8% fewer dollars.
  assertAlmostEquals(dollarValueMovePct(1600, 1680), -4.76, 0.01);
  assertAlmostEquals(dollarValueMovePct(1680, 1600), 5, 0.01);
});
