// The run limits /agent publishes are the ones the executor applies: for every
// token, `runLimits` must sit exactly on `runAmountProblem`'s edges.
//   deno test --allow-env supabase/functions/_shared/config.test.ts
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { DIRECT_TOKENS, runAmountProblem, runLimits } from "./config.ts";

Deno.test("runLimits are runAmountProblem's edges, for every token", () => {
  for (const t of DIRECT_TOKENS) {
    const { min, max } = runLimits(t);
    assertEquals(runAmountProblem(t.address, min), null, `${t.symbol} min should run`);
    assertEquals(runAmountProblem(t.address, max), null, `${t.symbol} max should run`);
    assertNotEquals(runAmountProblem(t.address, min - 1n), null, `${t.symbol} under the min should be refused`);
    assertNotEquals(runAmountProblem(t.address, max + 1n), null, `${t.symbol} over the max should be refused`);
  }
});

Deno.test("a dollar to a thousand dollars, in each token's own units", () => {
  const usdt = DIRECT_TOKENS.find((t) => t.symbol === "USDT")!;
  assertEquals(runLimits(usdt), { min: 1_000_000n, max: 1_000_000_000n });
  const cngn = DIRECT_TOKENS.find((t) => t.symbol === "cNGN")!;
  assertEquals(runLimits(cngn), { min: 1_300_000_000n, max: 1_300_000_000_000n });
});
