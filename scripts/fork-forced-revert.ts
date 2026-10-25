/// Step 1b's "done when", on a local fork of Celo mainnet: a run that reverts
/// on-chain is reported as a revert, never as a delivery.
///
///   anvil --fork-url https://forno.celo.org --port 8546        # another terminal
///   deno run --allow-env --allow-read --allow-write --allow-net scripts/fork-forced-revert.ts
///
/// On the fork only:
///   1. impersonates V5 schedule #1's sender (it still holds 0.287 USA₮),
///      approves V5 and creates a Direct schedule of 0.1 USA₮, due at once;
///   2. signs two executeRun transactions for it with the real code
///      (`signRun`) while it is still due, so both simulate cleanly, the way
///      a race between two senders would;
///   3. mines both in one block: the first pays, the second reverts NotDue;
///   4. checks that `confirmRun` calls the first a delivery of 0.09975 USA₮,
///      after the 25bps fee, and the second a revert, and that the recovery
///      lookups agree.
///
/// It signs with the real executor key, so it refuses to run against anything
/// but anvil on this machine, and checks that before importing anything that
/// can sign. The reverted receipt is written to `--out` for
/// `receipt.test.ts`.
import { encodeFunctionData, type Hex, keccak256, parseAbi, toHex } from "npm:viem@2";

const RPC = "http://127.0.0.1:8546";
const OUT = Deno.args.find((a) => a.startsWith("--out="))?.slice(6);

const env: Record<string, string> = {};
for (const line of (await Deno.readTextFile(".env")).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
}

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

const client = await rpc<string>("web3_clientVersion").catch(() => "");
if (!/anvil/i.test(client)) {
  console.error(`refusing: ${RPC} is not anvil (${client || "no answer"}). Start the fork first.`);
  Deno.exit(1);
}

// Only now: celo.ts reads these at import, and signs with the executor key.
Deno.env.set("CELO_RPC_URL", RPC);
Deno.env.set("EXECUTOR_PRIVATE_KEY", env.EXECUTOR_PRIVATE_KEY);
Deno.env.set("REMESSO_EXECUTOR_ADDRESS", env.REMESSO_EXECUTOR_ADDRESS);
const { broadcast, confirmRun, executorAccount, findOwnRunSince, lookupRunTx, signRun } = await import(
  "../supabase/functions/_shared/celo.ts"
);

const V5 = env.REMESSO_EXECUTOR_ADDRESS as Hex;
const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";
const SENDER = "0x5b156fe262B54c236563428c56839D8457A5542c";
const DEST = "0xFd1a3980f7473bdFE7461e78ADDe78c33d7b006b";
const AMOUNT = 100_000n; // 0.1 USA₮

const abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function createSchedule(address destination, uint128 amountIn, uint64 interval, uint96 minRateE6, uint32 maxRuns, uint64 expiresAt, uint64 firstRunAt, uint8 payoutType, address token, address payoutToken, address trigger, uint16 triggersLeft) returns (uint256)",
  "function nextScheduleId() view returns (uint256)",
]);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

async function sendAs(from: string, to: string, data: Hex) {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from, to, data }]);
  // Polled: right after a change of mining mode the receipt can lag a moment.
  for (let i = 0; i < 50; i++) {
    const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`setup transaction ${hash} failed`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`setup transaction ${hash} was never mined`);
}

// --- 1. a schedule that is due now ---------------------------------------
// A block per transaction, whatever mode the last script left the fork in.
await rpc("evm_setIntervalMining", [0]);
await rpc("evm_setAutomine", [true]);
await rpc("anvil_impersonateAccount", [SENDER]);
await rpc("anvil_setBalance", [SENDER, toHex(10n ** 18n)]);
await sendAs(SENDER, USAT, encodeFunctionData({ abi, functionName: "approve", args: [V5, AMOUNT * 2n] }));
const block = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
const now = BigInt(block.timestamp);
await sendAs(
  SENDER,
  V5,
  encodeFunctionData({
    abi,
    functionName: "createSchedule",
    args: [DEST, AMOUNT, 300n, 0n, 3, now + 86_400n, 0n, 2, USAT, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0],
  }),
);
const next = BigInt(await rpc<Hex>("eth_call", [{ to: V5, data: encodeFunctionData({ abi, functionName: "nextScheduleId" }) }, "latest"]));
const id = next - 1n;
console.log(`fork: schedule #${id} created, 0.1 USA₮ every 5 minutes, due now`);

// --- 2. two runs signed while both would succeed ---------------------------
// Both signed before either is sent, so both simulate and estimate against a
// schedule that is still due. The second takes its nonce from the floor, as a
// run after a lease release would.
const before = Date.now() - 60_000;
const first = await signRun("executeRun", id, 0n, null);
const second = await signRun("executeRun", id, 0n, first.nonce + 1);
check(second.nonce === first.nonce + 1, `signed at consecutive nonces (${first.nonce}, ${second.nonce})`);
await rpc("evm_setAutomine", [false]);
await broadcast(first);
await broadcast(second);

// --- 3. one block ------------------------------------------------------
await rpc("evm_mine");
await rpc("evm_setAutomine", [true]);

// --- 4. what the code makes of it --------------------------------------
const a = await confirmRun(first.hash, id, { confirmations: 1, timeoutMs: 15_000 });
const b = await confirmRun(second.hash, id, { confirmations: 1, timeoutMs: 15_000 });
check(a.outcome.ok && a.outcome.run.amountOut === 99_750n, "the first run is a delivery of 99,750 (0.1 USA₮ less 25bps)");
check(b.receipt.status === "reverted", "the second run reverted on-chain");
check(!b.outcome.ok && b.outcome.reason === `run reverted on-chain in ${second.hash}`, "and is reported as a revert, not a delivery");

const seenA = await lookupRunTx(first.hash, id);
check(seenA.kind === "mined" && seenA.outcome.ok, "recovery: the first hash settles as delivered");
const seenB = await lookupRunTx(second.hash, id);
check(seenB.kind === "mined" && !seenB.outcome.ok, "recovery: the second hash fails as reverted");
const nobody = keccak256(toHex(`no such transaction ${Date.now()}`));
check((await lookupRunTx(nobody, id)).kind === "unknown_tx", "recovery: an unknown hash is unknown");
const found = await findOwnRunSince(id, before);
check(found.kind === "mined" && found.hash === first.hash, "recovery: a row with no hash finds our own executeRun");
check((await findOwnRunSince(id, Date.now() + 3_600_000)).kind === "never_sent", "recovery: nothing since a later row");
check(executorAccount().address.toLowerCase() === "0xa351d65c15b8a342b6ecbc7f2b9efe62b17cdb21", "signed by the V5 executor");

if (OUT) {
  const r = b.receipt;
  await Deno.writeTextFile(
    OUT,
    JSON.stringify({ status: r.status, transactionHash: r.transactionHash, blockNumber: Number(r.blockNumber), logs: r.logs }, null, 2),
  );
  console.log(`reverted receipt written to ${OUT}`);
}

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
Deno.exit(failures ? 1 : 0);
