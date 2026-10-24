/// Pins `runOutcome` to real receipts.
///
/// The success case is V5's first run, schedule #1 on 2026-10-16: 1 USA₮ in,
/// 0.9975 out after the 25bps commission. `runs` recorded 1.0 for it, the
/// quote, which is the bug the event's `amountOut` fixes.
///
///   deno test supabase/functions/_shared/receipt.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ReceiptLike, runOutcome } from "./receipt.ts";

const V5 = "0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8";
const V4 = "0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009";

/// `cast receipt 0x4ef1b459…2e72` on Celo mainnet, block 80,271,047. Logs:
/// the fee to the treasury and the net to the recipient (USA₮ Transfer and
/// Approval pairs), FeeCharged, then RunExecuted.
const V5_RUN: ReceiptLike = {
  status: "success",
  transactionHash: "0x4ef1b4595e20b4184be736ef7399ad958cd9c42ed248ecaeb0567c7703922e72",
  logs: [
    {
      address: "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000005b156fe262b54c236563428c56839d8457a5542c",
        "0x0000000000000000000000002da4cd408bd8051385b5dd113f8bed56e4f9f134",
      ],
      data: "0x00000000000000000000000000000000000000000000000000000000000009c4",
    },
    {
      address: "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
      topics: [
        "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
        "0x0000000000000000000000005b156fe262b54c236563428c56839d8457a5542c",
        "0x0000000000000000000000003c357af3300f383ea49b6d6ed8e084199a92bed8",
      ],
      data: "0x00000000000000000000000000000000000000000000000000000000000f387c",
    },
    {
      address: "0x3c357af3300f383ea49b6d6ed8e084199a92bed8",
      topics: [
        "0x7f4361467af1084d366aacf23c0607d11742c55d3472543b6d5f03a9aee9faf4",
        "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x000000000000000000000000d2ab3c9a02dbbab236bfec45d1d755df4267f771",
      ],
      data: "0x00000000000000000000000000000000000000000000000000000000000009c4",
    },
    {
      address: "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000005b156fe262b54c236563428c56839d8457a5542c",
        "0x000000000000000000000000fd1a3980f7473bdfe7461e78adde78c33d7b006b",
      ],
      data: "0x00000000000000000000000000000000000000000000000000000000000f387c",
    },
    {
      address: "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
      topics: [
        "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
        "0x0000000000000000000000005b156fe262b54c236563428c56839d8457a5542c",
        "0x0000000000000000000000003c357af3300f383ea49b6d6ed8e084199a92bed8",
      ],
      data: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      address: "0x3c357af3300f383ea49b6d6ed8e084199a92bed8",
      topics: [
        "0x950cfba98d7a616c7497f589d2638709b616af197f194d953e0c6f2fb9a18155",
        "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x0000000000000000000000005b156fe262b54c236563428c56839d8457a5542c",
        "0x000000000000000000000000fd1a3980f7473bdfe7461e78adde78c33d7b006b",
      ],
      data:
        "0x00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000f387c0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006ad26049",
    },
  ],
};

Deno.test("a real V5 run: delivered, and the amount is what arrived, not what was sent", () => {
  const out = runOutcome(V5_RUN, V5, 1n);
  assert(out.ok, "the receipt succeeded and holds RunExecuted for #1");
  assertEquals(out.run.id, 1n);
  assertEquals(out.run.amountIn, 1_000_000n);
  assertEquals(out.run.amountOut, 997_500n, "1 USA₮ less the 25bps commission");
  assertEquals(out.run.runsExecuted, 1);
  assertEquals(out.run.destination.toLowerCase(), "0xfd1a3980f7473bdfe7461e78adde78c33d7b006b");
  assertEquals(out.run.sender.toLowerCase(), "0x5b156fe262b54c236563428c56839d8457a5542c");
});

/// A real reverted `executeRun`, from `scripts/fork-forced-revert.ts` on a
/// fork of mainnet at block 80,973,001: the second of two runs signed while
/// the schedule was due, mined just after the first, so it hit `NotDue`. What
/// viem hands back for it, without throwing: a status and no logs.
const V5_REVERTED: ReceiptLike = {
  status: "reverted",
  transactionHash: "0xfd56023cb66770cba326ebabf517914aaaa3a986d180525e38b85f70f497a131",
  logs: [],
};

Deno.test("a reverted receipt is never a delivery", () => {
  const out = runOutcome(V5_REVERTED, V5, 2n);
  assert(!out.ok);
  assertEquals(out.reason, `run reverted on-chain in ${V5_REVERTED.transactionHash}`);

  // And a revert stays a revert even if logs were somehow attached.
  assert(!runOutcome({ ...V5_RUN, status: "reverted" }, V5, 1n).ok);
});

Deno.test("success without RunExecuted for THIS schedule is not a delivery", () => {
  const out = runOutcome(V5_RUN, V5, 2n);
  assert(!out.ok);
  assertEquals(out.reason, `run ${V5_RUN.transactionHash} mined without a RunExecuted for schedule 2`);
});

Deno.test("RunExecuted from another contract does not count", () => {
  // The same event shape from V4, or from anything at all that emits it.
  assert(!runOutcome(V5_RUN, V4, 1n).ok);

  const spoofed: ReceiptLike = {
    ...V5_RUN,
    logs: V5_RUN.logs.map((l) => ({ ...l, address: "0x000000000000000000000000000000000000dead" })),
  };
  assert(!runOutcome(spoofed, V5, 1n).ok);
});
