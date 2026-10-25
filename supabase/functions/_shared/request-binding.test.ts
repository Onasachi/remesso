/// Pins what may answer a payment request: evidence about this request binds,
/// and the terms decide only between accepted and accepted with changes.
///
///   deno test --allow-env supabase/functions/_shared/request-binding.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { type Evidence, judge, type RequestRow, toUnits } from "./request-binding.ts";

const PAYER = "0x5b156fe262b54c236563428c56839d8457a5542c";
const PAYEE = "0xfd1a3980f7473bdfe7461e78adde78c33d7b006b";
const USDT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const USDC = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";

const request: RequestRow = {
  id: "3f2a9c1e-5b7d-4f60-a1b2-c3d4e5f60718",
  payer_address: PAYER,
  to_address: PAYEE,
  amount: "5",
  token_symbol: "USDT",
  interval_seconds: 2_592_000,
  max_runs: 12,
  status: "pending",
  created_at: "2026-10-25T10:00:00Z",
};
const schedule: Evidence = {
  kind: "schedule",
  contract: "0x3c357af3300f383ea49b6d6ed8e084199a92bed8",
  scheduleId: "9",
  from: PAYER,
  to: PAYEE,
  token: USDT,
  amount: "5000000", // what each run delivers, after the fee
  interval: "2592000",
  maxRuns: 12,
  at: "2026-10-25T10:05:00Z",
};

Deno.test("decimal amounts in base units, exactly", () => {
  assertEquals(toUnits("5", 6), 5_000_000n);
  assertEquals(toUnits("0.000001", 6), 1n);
  assertEquals(toUnits("1000.5", 18), 1_000_500_000_000_000_000_000n);
  assertEquals(toUnits("0.0000001", 6), null, "more places than the token has");
  assertEquals(toUnits("1e3", 6), null);
});

Deno.test("the schedule the request asked for: accepted", () => {
  const j = judge(request, schedule);
  assertEquals(j.ok && j.status, "accepted");
  assertEquals(j.ok && j.terms.changed, []);
});

Deno.test("evidence from another wallet, to another address, or from before the request never binds", () => {
  assertEquals(judge(request, { ...schedule, from: "0x00000000000000000000000000000000000000aa" }).ok, false);
  assertEquals(judge(request, { ...schedule, to: "0x00000000000000000000000000000000000000bb" }).ok, false);
  assertEquals(judge(request, { ...schedule, at: "2026-10-25T09:59:59Z" }).ok, false, "an older schedule between the same two wallets");
  assertEquals(judge(request, { ...schedule, at: request.created_at }).ok, false, "the same second is not after");
});

Deno.test("changed terms still answer, as accepted with changes, and say what changed", () => {
  const j = judge(request, { ...schedule, amount: "4987500", token: USDC, interval: "604800", maxRuns: 4 });
  assertEquals(j.ok && j.status, "accepted_with_changes");
  assertEquals(j.ok && j.terms.changed, ["token", "amount", "cadence", "runs"]);
});

Deno.test("a pay link's old meaning, the gross, reads as a changed amount", () => {
  // 5 USDT sent before the fee delivers 4.9875: the requester is owed 5.
  const j = judge(request, { ...schedule, amount: "4987500" });
  assertEquals(j.ok && j.terms.changed, ["amount"]);
});

Deno.test("a policy payment has no cadence to compare", () => {
  const j = judge(request, { kind: "policy_payment", contract: "0xa6351f", txHash: "0x1", from: PAYER, to: PAYEE, token: USDT, amount: "5000000", at: "2026-10-25T11:00:00Z" });
  assertEquals(j.ok && j.status, "accepted");
});

Deno.test("a request that named no token reads its amount in the token paid", () => {
  const j = judge({ ...request, token_symbol: null }, { ...schedule, token: USDC });
  assertEquals(j.ok && j.status, "accepted");
});
