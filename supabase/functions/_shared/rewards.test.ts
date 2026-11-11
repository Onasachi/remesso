// deno test --allow-env supabase/functions/_shared/rewards.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { decideReward, minimumFor, phonePersons, type RewardFacts } from "./rewards.ts";

const USDT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const WARS = "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const OURS = "0x3697261d15fb3c0b945120450773f7b27d4344d2";
const START = new Date("2026-11-11T00:00:00Z");

type Over = Partial<Omit<RewardFacts, "payment">> & { payment?: Partial<RewardFacts["payment"]> };

function facts(over: Over = {}): RewardFacts {
  const { payment, ...rest } = over;
  return {
    payment: {
      kind: "run",
      from: ALICE,
      to: BOB,
      token: USDT,
      amount: 997_500n,
      amountIn: 1_000_000n,
      blockTime: new Date("2026-11-12T10:00:00Z"),
      final: true,
      removed: false,
      ...payment,
    },
    campaign: { startsAt: START, endsAt: null },
    excluded: new Set([OURS]),
    payerPerson: "phone:0xabc",
    recipientPersons: [],
    paidBack: false,
    ...rest,
  };
}

Deno.test("a verified person's $1 run to someone else earns it, keyed by the person", () => {
  assertEquals(decideReward(facts()), { ok: true, personKey: "phone:0xabc" });
});

Deno.test("a policy payment counts, measured on its amount (no fee, no amountIn)", () => {
  const d = decideReward(facts({ payment: { kind: "policy_payment", amountIn: null, amount: 1_000_000n } }));
  assertEquals(d, { ok: true, personKey: "phone:0xabc" });
});

Deno.test("a schedule being created, or a policy, is not a payment", () => {
  for (const kind of ["schedule_created", "policy_created", "policy_revoked"]) {
    assertEquals(decideReward(facts({ payment: { kind } })), { ok: false, reason: "not_a_payment" });
  }
});

Deno.test("only final, unremoved events count", () => {
  assertEquals(decideReward(facts({ payment: { final: false } })), { ok: false, reason: "not_final" });
  assertEquals(decideReward(facts({ payment: { removed: true } })), { ok: false, reason: "not_final" });
});

Deno.test("payments before the campaign, or after it ends, don't count", () => {
  assertEquals(
    decideReward(facts({ payment: { blockTime: new Date("2026-11-10T23:59:59Z") } })),
    { ok: false, reason: "outside_campaign" },
  );
  assertEquals(
    decideReward(facts({ campaign: { startsAt: START, endsAt: new Date("2026-11-12T10:00:00Z") } })),
    { ok: false, reason: "outside_campaign" },
  );
});

Deno.test("our own wallets never earn one, on either side", () => {
  assertEquals(decideReward(facts({ payment: { from: OURS } })), { ok: false, reason: "excluded" });
  assertEquals(decideReward(facts({ payment: { to: OURS } })), { ok: false, reason: "excluded" });
});

Deno.test("paying the same wallet is refused", () => {
  assertEquals(decideReward(facts({ payment: { to: ALICE } })), { ok: false, reason: "self_payment" });
});

Deno.test("under the $1 minimum is refused, judged on the gross for a run", () => {
  assertEquals(decideReward(facts({ payment: { amountIn: 999_999n } })), { ok: false, reason: "too_small" });
  // The net is under $1 after the fee, but the gross clears it: that counts.
  assertEquals(decideReward(facts({ payment: { amountIn: 1_000_000n, amount: 997_500n } })).ok, true);
});

Deno.test("the minimum is in the token's own units: 1,500 wARS, not 1", () => {
  assertEquals(minimumFor(WARS), 1500n * 10n ** 18n);
  const wars = (n: bigint) => facts({ payment: { token: WARS, amountIn: n, amount: n } });
  assertEquals(decideReward(wars(1499n * 10n ** 18n)), { ok: false, reason: "too_small" });
  assertEquals(decideReward(wars(1500n * 10n ** 18n)).ok, true);
});

Deno.test("a token the backend doesn't know is refused, never assumed", () => {
  assertEquals(
    decideReward(facts({ payment: { token: "0x9999999999999999999999999999999999999999" } })),
    { ok: false, reason: "unknown_token" },
  );
});

Deno.test("no phone and no passport: no reward (yet)", () => {
  assertEquals(decideReward(facts({ payerPerson: null })), { ok: false, reason: "no_identity" });
});

Deno.test("paying another wallet of the same person is refused", () => {
  assertEquals(
    decideReward(facts({ recipientPersons: ["phone:0xabc"] })),
    { ok: false, reason: "same_person" },
  );
});

Deno.test("two wallets passing money back and forth are refused", () => {
  assertEquals(decideReward(facts({ paidBack: true })), { ok: false, reason: "paid_back" });
});

Deno.test("phone identifiers become lowercased person keys", () => {
  assertEquals(phonePersons(["0xABC", "0xdef"]), ["phone:0xabc", "phone:0xdef"]);
});
