/// Commit to paying someone on a schedule, as an agent, from your own wallet.
///
/// The counterpart to `pay-remesso.ts`. That one pays per call: you ask, you
/// are quoted, you sign, it is over. This one signs a MANDATE — a standing
/// authorisation to move a fixed amount to a fixed address on a fixed rhythm,
/// which the executor then carries out without asking you again.
///
/// That is a different kind of promise, so read what it can and cannot do:
///
///   - the recipient, the amount and the cadence are fixed HERE, at signing.
///     Nothing can change them afterwards — not Remesso, not the contract
///     owner, not you. Cancelling is the only edit.
///   - it can never move more than `AMOUNT` per interval, never more than
///     `RUNS` times, and never past the expiry.
///   - it spends through an ERC-20 allowance you grant below. That allowance
///     is the real ceiling: revoke it and every future run fails.
///   - `TRIGGER=remesso` additionally lets Remesso's executor bring a payment
///     forward — same recipient, same amount, consuming a scheduled payment
///     rather than adding one. Leave it unset and only the clock moves money.
///
/// Unlike paying, this needs CELO for gas: two transactions, an approval and
/// the schedule itself. Roughly 0.06 CELO at the time of writing.
///
///   deno run --allow-env --allow-net create-schedule.ts
///
/// Needs PAYER_KEY (or PRIVATE_KEY), TO, and AMOUNT. Everything else has a
/// default:
///   TO=0x…            who gets paid                        (required)
///   AMOUNT=0.05       per transfer, in whole tokens        (required)
///   TOKEN=USDT        USDT | USDC | USDm | USAT | wARS | wBRL | wCOP  (default USDT)
///   EVERY=week        week | fortnight | month | quarter   (default week)
///   RUNS=2            how many transfers                   (default 2)
///   TRIGGER=remesso   allow early sending                  (default: none)
///   MAX_TOTAL=1       refuse if AMOUNT × RUNS exceeds this (default 1),
///                     in TOKEN's own units — 1 wARS is one peso, so a
///                     peso schedule needs this raised deliberately
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, parseUnits } from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";

const RPC = Deno.env.get("CELO_RPC_URL") ?? "https://forno.celo.org";
const EXECUTOR = (Deno.env.get("EXECUTOR") ??
  "0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8") as `0x${string}`;

/// Decimals are NOT uniform: USDm is 18dp while USDT and USDC are 6dp, so a
/// fixed 6 is wrong by 10^12 for a third of this table. Addresses are the
/// identity — several Celo tokens have fee-currency adapters reporting the
/// same symbol with different decimals.
const TOKENS: Record<string, { address: `0x${string}`; decimals: number }> = {
  USDT: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
  USDC: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6 },
  // Mento's dollar, formerly cUSD — still accepted under the old name.
  USDM: { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18 },
  CUSD: { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18 },
  USAT: { address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", decimals: 6 },
  // Ripio's local-currency stablecoins, allowed on V4 2026-10-06. 18dp, and
  // not dollars: amounts are pesos and reais.
  WARS: { address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", decimals: 18 },
  WBRL: { address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0", decimals: 18 },
  WCOP: { address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76", decimals: 18 },
};

const CADENCE: Record<string, number> = {
  week: 7 * 86400,
  fortnight: 14 * 86400,
  month: 30 * 86400,
  quarter: 90 * 86400,
};

/// Parsed rather than passed as strings: viem encodes calldata from a real ABI
/// object, and a bare string array reaches `readContract` as something it
/// cannot encode.
const abi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function executor() view returns (address)",
  "function directTokenAllowed(address) view returns (bool)",
  "function createSchedule(address destination,uint128 amountIn,uint64 interval,uint96 minRateE6,uint32 maxRuns,uint64 expiresAt,uint64 firstRunAt,uint8 payoutType,address token,address payoutToken,address trigger,uint16 triggersLeft) returns (uint256)",
  "event ScheduleCreated(uint256 indexed id, address indexed sender, address indexed destination, uint128 amountIn, uint64 interval, uint96 minRateE6, uint32 maxRuns, uint64 expiresAt, uint8 payoutType)",
]);

const key = (Deno.env.get("PAYER_KEY") ?? Deno.env.get("PRIVATE_KEY") ?? "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
  console.error("set PAYER_KEY (or PRIVATE_KEY) to a 32-byte hex private key");
  Deno.exit(2);
}
const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);

const to = (Deno.env.get("TO") ?? "").trim() as `0x${string}`;
if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
  console.error("set TO to the address you want to pay");
  Deno.exit(2);
}
if (to.toLowerCase() === account.address.toLowerCase()) {
  // Allowed by the contract, pointless in practice: the money returns to you
  // minus the fee, and any balance check you run afterwards shows nothing.
  console.error("TO is this wallet. A schedule paying itself only loses the fee.");
  Deno.exit(2);
}

const token = TOKENS[(Deno.env.get("TOKEN") ?? "USDT").toUpperCase()];
if (!token) {
  console.error(`TOKEN must be one of ${Object.keys(TOKENS).join(", ")}`);
  Deno.exit(2);
}
const interval = CADENCE[(Deno.env.get("EVERY") ?? "week").toLowerCase()];
if (!interval) {
  console.error(`EVERY must be one of ${Object.keys(CADENCE).join(", ")}`);
  Deno.exit(2);
}

const runs = Number(Deno.env.get("RUNS") ?? "2");
const amountText = (Deno.env.get("AMOUNT") ?? "").trim();
if (!/^\d{1,12}(\.\d{1,18})?$/.test(amountText) || Number(amountText) <= 0) {
  console.error("set AMOUNT to a positive decimal, e.g. AMOUNT=0.05");
  Deno.exit(2);
}
if (!Number.isInteger(runs) || runs < 1 || runs > 4294967295) {
  console.error("RUNS must be a whole number of transfers");
  Deno.exit(2);
}

const amountIn = parseUnits(amountText, token.decimals);
const total = amountIn * BigInt(runs);

// The whole commitment, checked before anything is signed. A mandate is worth
// a ceiling more than a single payment is: this one number is what the
// schedule can cost you in total, and it is the last moment it is cheap to
// notice it is wrong.
const maxTotal = parseUnits(Deno.env.get("MAX_TOTAL") ?? "1", token.decimals);
if (total > maxTotal) {
  console.error(
    `refused: ${amountText} × ${runs} = ${Number(total) / 10 ** token.decimals} ` +
      `exceeds MAX_TOTAL of ${Number(maxTotal) / 10 ** token.decimals}.`,
  );
  Deno.exit(1);
}

const publicClient = createPublicClient({ chain: celo, transport: http(RPC) });
// ERC-8021 attribution, after the calldata where the EVM ignores it: Remesso's
// own code plus the one Loops issued for Agents on Open Rails. It credits the
// app that caused the transaction and changes nothing about what it does —
// the same suffix the Remesso web app puts on every write a sender signs.
// Byte-identical to `toDataSuffix(["remesso", "celo_5cd35ca55baf"])` from
// `@celo/attribution-tags`, pinned in `_shared/attribution.test.ts`.
const ATTRIBUTION =
  "0x72656d6573736f2c63656c6f5f356364333563613535626166190080218021802180218021802180218021";
const wallet = createWalletClient({ account, chain: celo, transport: http(RPC), dataSuffix: ATTRIBUTION });
const read = (functionName: string, args: unknown[], address = token.address) =>
  publicClient.readContract({ address, abi, functionName, args } as never);

// Refuse early on the things the contract would revert on anyway, because a
// revert costs gas and says less.
const [allowed, balance, celoBalance] = await Promise.all([
  read("directTokenAllowed", [token.address], EXECUTOR) as Promise<boolean>,
  read("balanceOf", [account.address]) as Promise<bigint>,
  publicClient.getBalance({ address: account.address }),
]);
if (!allowed) {
  console.error(`refused: the executor does not accept ${Deno.env.get("TOKEN")} as a payout asset.`);
  Deno.exit(1);
}
if (celoBalance === 0n) {
  console.error("refused: this wallet has no CELO, and creating a schedule costs gas.");
  console.error("Paying per call needs none; committing to a schedule does. Send it ~0.06 CELO.");
  Deno.exit(1);
}

/// Who, if anyone, may bring a payment forward. `remesso` is the contract's
/// CURRENT_EXECUTOR sentinel, address(1): "whoever is the executor now", so a
/// key rotation moves the grant. V5 refuses the executor's own address, and on
/// a converting (swap) payout it refuses any trigger but this one.
const triggerEnv = (Deno.env.get("TRIGGER") ?? "").trim();
const trigger = triggerEnv.toLowerCase() === "remesso"
  ? "0x0000000000000000000000000000000000000001" as const
  : /^0x[a-fA-F0-9]{40}$/.test(triggerEnv)
  ? triggerEnv as `0x${string}`
  : "0x0000000000000000000000000000000000000000" as const;
const triggersLeft = trigger === "0x0000000000000000000000000000000000000000" ? 0 : Math.min(runs, 65535);

// An hour past the last transfer, so a run that fires on the tick after its
// due time still lands inside the schedule's life.
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + runs * interval + 3600);

console.log(`paying as   : ${account.address}`);
console.log(`to          : ${to}`);
console.log(`amount      : ${amountText} ${Deno.env.get("TOKEN") ?? "USDT"} every ${Deno.env.get("EVERY") ?? "week"}`);
console.log(`transfers   : ${runs}  (total ${Number(total) / 10 ** token.decimals})`);
console.log(`early send  : ${triggersLeft ? `${trigger}, up to ${triggersLeft}` : "nobody"}`);
console.log(`balance     : ${Number(balance) / 10 ** token.decimals}  ·  gas ${Number(celoBalance) / 1e18} CELO`);
if (balance < amountIn) {
  console.log("\nnote: the balance is below one transfer. The schedule is still valid —");
  console.log("runs simply fail until it is funded. Nothing is lost by creating it.");
}

// 1. The allowance. This, not the schedule, is the real ceiling on what can
//    ever be taken: approve exactly what this schedule needs, ON TOP of what
//    is already approved, because `approve` replaces rather than adds and
//    another schedule may be relying on the existing figure.
const current = await read("allowance", [account.address, EXECUTOR]) as bigint;
console.log(`\napproving ${Number(current + total) / 10 ** token.decimals} (existing ${Number(current) / 10 ** token.decimals} + this schedule)…`);
const approveHash = await wallet.writeContract({
  address: token.address,
  abi,
  functionName: "approve",
  args: [EXECUTOR, current + total],
} as never);
const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
console.log(`  ${approveHash}`);
// A mined transaction is not a successful one. Carrying on after a reverted
// approval would create a schedule that can never move a token.
if (approveReceipt.status !== "success") {
  console.error("the approval reverted. Nothing was created.");
  Deno.exit(1);
}

// 2. The mandate. Direct (payoutType 2) forwards the funding asset itself, so
//    there is no conversion, no floor and no payout token — the contract zeroes
//    all three whatever is passed.
console.log("creating the schedule…");
const hash = await wallet.writeContract({
  address: EXECUTOR,
  abi,
  functionName: "createSchedule",
  args: [to, amountIn, BigInt(interval), 0n, runs, expiresAt, 0n, 2, token.address, "0x0000000000000000000000000000000000000000", trigger, triggersLeft],
} as never);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`  ${hash}  (${receipt.status})`);
if (receipt.status !== "success") {
  console.error("the schedule was not created. The approval above still stands —");
  console.error("set it back to 0 if you are not going to retry.");
  Deno.exit(1);
}

// The id comes from THIS transaction's own log, not from re-reading the
// counter. `nextScheduleId` is a read against whichever node answers, and a
// node one block behind returns the value from before this transaction — so
// the script would print somebody else's schedule id with total confidence.
// The receipt cannot lag itself.
const [created] = parseEventLogs({ abi, eventName: "ScheduleCreated", logs: receipt.logs });
if (!created) {
  console.error(`created, but no ScheduleCreated log in ${hash} — read the receipt yourself.`);
  Deno.exit(1);
}
const id = created.args.id;
console.log(`\nschedule #${id} is live.`);
console.log(`verify it: cast call ${EXECUTOR} "getSchedule(uint256)" ${id} --rpc-url ${RPC}`);
