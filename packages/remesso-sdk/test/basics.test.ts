// The SDK's pure parts: tokens, limits, fees, links, memos, ids from recorded
// mainnet receipts, and the attribution bytes.
//   deno test --config packages/remesso-sdk/deno.json --unstable-sloppy-imports --allow-read --allow-env packages/remesso-sdk/test/
import { assertEquals, assertThrows } from "@std/assert";
import type { Log } from "viem";
import { suffixFor } from "../../../supabase/functions/_shared/attribution.ts";
import { creationCodes } from "../../../supabase/functions/_shared/builder-codes.ts";
import {
  ATTRIBUTION,
  attributionFor,
  createRemesso,
  FEE_BPS,
  findToken,
  formatAmount,
  grossFor,
  memo32,
  netOf,
  parsePayLink,
  payLink,
  RemessoError,
  runLimits,
  token,
  toUnits,
} from "../src/index.ts";
import { policyIdFrom } from "../src/policies.ts";
import { intervalOf, scheduleIdFrom } from "../src/schedules.ts";

const receipt = async (name: string) =>
  JSON.parse(await Deno.readTextFile(new URL(`./fixtures/${name}.receipt.json`, import.meta.url))) as { logs: Log[] };

Deno.test("tokens by symbol, alias or address; unknown ones refused", () => {
  assertEquals(token("usdt").decimals, 6);
  assertEquals(token("USAT").symbol, "USA₮");
  assertEquals(token("cUSD").symbol, "USDm");
  assertEquals(token("0xcebA9300f2b948710d2653dD7B07f33A8B32118C").symbol, "USDC");
  assertEquals(findToken("DOGE"), undefined);
  assertThrows(() => token("DOGE"), RemessoError, "unknown token");
});

Deno.test("amounts are strings at each token's own decimals", () => {
  assertEquals(toUnits("2.50", token("USDT")), 2_500_000n);
  assertEquals(toUnits("1", token("USDm")), 10n ** 18n);
  assertThrows(() => toUnits("0.0000001", token("USDT")), RemessoError, "6 decimals");
  assertThrows(() => toUnits("1e3", token("USDT")), RemessoError);
  assertEquals(formatAmount(997_500n, "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771"), "0.9975 USA₮");
});

Deno.test("per-run limits come from the manifest: a dollar to a thousand, per token", () => {
  assertEquals(runLimits(token("USDT")), { min: 1_000_000n, max: 1_000_000_000n });
  assertEquals(runLimits(token("cNGN")), { min: 1_300_000_000n, max: 1_300_000_000_000n });
  assertEquals(runLimits(token("wARS")).min, 1500n * 10n ** 18n);
});

Deno.test("fee: 25bps, rounded up; 5 USDT asked is 5.012532 sent", () => {
  assertEquals(FEE_BPS, 25);
  assertEquals(grossFor(5_000_000n, FEE_BPS), 5_012_532n);
  assertEquals(netOf(5_012_532n, FEE_BPS) >= 5_000_000n, true);
  assertEquals(netOf(1_000_000n, FEE_BPS), 997_500n);
});

Deno.test("cadences: the four names, their -ly forms, or seconds of at least an hour", () => {
  assertEquals(intervalOf("week"), 604_800);
  assertEquals(intervalOf("monthly"), 2_592_000);
  assertEquals(intervalOf(7200), 7200);
  assertThrows(() => intervalOf(60), RemessoError);
  assertThrows(() => intervalOf("daily"), RemessoError);
});

Deno.test("links: built to the app, parsed back, strangers' junk dropped", () => {
  const url = payLink({ to: "0xFd1a3980f7473bdFE7461e78ADDe78c33d7b006b", amount: "5", token: "usat", every: "month", runs: 3, request: "1ab0c6d4-0000-4000-8000-000000000001" });
  assertEquals(url.startsWith("https://remesso.xyz/schedules/new?to=0xFd1a"), true);
  assertEquals(parsePayLink(url), {
    to: "0xFd1a3980f7473bdFE7461e78ADDe78c33d7b006b",
    amount: "5",
    token: "USA₮",
    intervalSeconds: 2_592_000,
    runs: 3,
    request: "1ab0c6d4-0000-4000-8000-000000000001",
  });
  assertEquals(parsePayLink("?to=0xnope&amount=-1&token=DOGE&every=daily&runs=0&req=x"), {});
});

Deno.test("memos are bytes32, counted in bytes, padded right like the plugin wallet's", () => {
  const plugin = (m: string) => `0x${[...new TextEncoder().encode(m)].map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0")}`;
  assertEquals(memo32("invoice 42"), plugin("invoice 42"));
  assertEquals(memo32(), `0x${"0".repeat(64)}`);
  const reference = "bf0305f61ec54d429352a09c84aa5f18"; // a request's reference is exactly 32
  assertEquals(memo32(reference), plugin(reference));
  assertThrows(() => memo32("é".repeat(17)), RemessoError, "34 bytes");
});

Deno.test("ids come from the transaction's own log: recorded mainnet receipts", async () => {
  assertEquals(scheduleIdFrom((await receipt("schedule-created")).logs), 1n);
  assertEquals(policyIdFrom((await receipt("policy-created")).logs), 1n);
  // A receipt without the event names nothing, rather than a wrong id.
  assertEquals(scheduleIdFrom((await receipt("policy-paid")).logs), null);
  assertEquals(policyIdFrom((await receipt("run-executed")).logs), null);
});

Deno.test("attribution: the same bytes the backend's encoder writes", () => {
  assertEquals(ATTRIBUTION, suffixFor(["remesso", "celo_5cd35ca55baf"]));
  assertEquals(attributionFor(), ATTRIBUTION, "no builder codes: exactly what 0.1.0 wrote");
});

Deno.test("builder codes: after ours, by the backend's rules", () => {
  // toDataSuffix(["remesso", "celo_5cd35ca55baf", "acme_app"]) from @celo/attribution-tags 0.5.0
  assertEquals(
    attributionFor(["acme_app"]),
    "0x72656d6573736f2c63656c6f5f3563643335636135356261662c61636d655f617070220080218021802180218021802180218021",
  );
  // What the executor's runs will carry is what the backend reads back.
  assertEquals(creationCodes(`0x6f2e1b3b${attributionFor(["acme_app", "partner_2"])!.slice(2)}`), ["acme_app", "partner_2"]);
  assertEquals(attributionFor(["acme_app"], false), suffixFor("acme_app"), "attribution: false leaves ours out");
  assertEquals(attributionFor([], false), undefined);
  for (const bad of [["Acme"], ["acme app"], ["x".repeat(33)], [""], ["remesso"], ["celo_5cd35ca55baf"], ["a", "a"], ["a", "b", "c", "d"]]) {
    assertThrows(() => attributionFor(bad), RemessoError, undefined, JSON.stringify(bad));
  }
  assertThrows(() => createRemesso({ builderCodes: ["Acme"] }), RemessoError, "builder code");
});
