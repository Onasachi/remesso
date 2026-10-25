/// Step 1b for runs already recorded: did every delivered run succeed on-chain,
/// and is its `amount_out` what actually arrived?
///
///   deno run --allow-env --allow-read --allow-net scripts/check-past-runs.ts           # reads only
///   deno run --allow-env --allow-read --allow-net scripts/check-past-runs.ts --write   # fixes amount_out
///
/// Until 2026-10-24 runs were recorded without reading the receipt's status,
/// and with the quote as `amount_out`. On the Direct rail the quote is the
/// amount sent, and the recipient got that minus the commission. This reads
/// each run's receipt, asks `receipt.ts` what it did, and reports:
///   - runs recorded as sent whose receipt reverted or holds no RunExecuted;
///   - runs whose `amount_out` differs from the event's `amountOut`.
///
/// `--write` fixes only the second kind. A recorded run that never happened is
/// reported and left for a person: it means a sender was told about money
/// that didn't move.
import { createPublicClient, type Hex, http } from "npm:viem@2";
import { celo } from "npm:viem@2/chains";
import { runOutcome } from "../supabase/functions/_shared/receipt.ts";

const WRITE = Deno.args.includes("--write");

const env: Record<string, string> = {};
for (const line of (await Deno.readTextFile(".env")).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
}
const SUPABASE = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env");
const headers = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const client = createPublicClient({ chain: celo, transport: http(env.CELO_RPC_URL || "https://forno.celo.org") });

type Row = {
  id: string;
  status: string;
  tx_hash: string;
  amount_out: string | null;
  started_at: string;
  schedules: { onchain_id: string | number; executor_address: string } | null;
};

const q = new URLSearchParams({
  // As text: PostgREST sends `numeric(78,0)` as a JSON number, and an 18dp
  // amount like 1000 wARS comes back as 1e+21.
  select: "id,status,tx_hash,amount_out::text,started_at,schedules(onchain_id,executor_address)",
  status: "in.(delivered,redeeming,paid_out)",
  tx_hash: "not.is.null",
  order: "started_at.asc",
});
const res = await fetch(`${SUPABASE}/rest/v1/runs?${q}`, { headers });
if (!res.ok) throw new Error(`supabase answered ${res.status}: ${await res.text()}`);
const rows = await res.json() as Row[];
console.log(`${rows.length} runs recorded as sent${WRITE ? "" : " (read-only; --write fixes amounts)"}\n`);

/// forno balances across nodes, and some answer null for an older receipt
/// another node has, so ask a few times.
async function receipt(hash: Hex) {
  for (let i = 0; i < 10; i++) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

let ok = 0, unreadable = 0, notRun = 0, wrongAmount = 0, fixed = 0;
for (const r of rows) {
  const s = r.schedules;
  const label = `${r.started_at.slice(0, 16)}Z #${s?.onchain_id} ${r.tx_hash.slice(0, 12)}…`;
  if (!s) {
    console.log(`  ?     ${label} has no schedule row`);
    unreadable++;
    continue;
  }
  const rec = await receipt(r.tx_hash as Hex);
  if (!rec) {
    console.log(`  ?     ${label} receipt not available from the RPC`);
    unreadable++;
    continue;
  }
  const out = runOutcome(rec, s.executor_address as Hex, BigInt(s.onchain_id));
  if (!out.ok) {
    console.log(`  NOT RUN  ${label} recorded ${r.status}: ${out.reason}`);
    notRun++;
    continue;
  }
  const arrived = out.run.amountOut.toString();
  if (r.amount_out === arrived) {
    ok++;
    continue;
  }
  wrongAmount++;
  console.log(`  amount ${label} recorded ${r.amount_out}, arrived ${arrived}`);
  if (WRITE) {
    const up = await fetch(`${SUPABASE}/rest/v1/runs?id=eq.${r.id}`, {
      method: "PATCH",
      headers: { ...headers, prefer: "return=minimal" },
      body: JSON.stringify({ amount_out: arrived }),
    });
    if (up.ok) fixed++;
    else console.log(`         could not fix: ${up.status} ${await up.text()}`);
  }
}

console.log(
  `\n${ok} correct, ${wrongAmount} with the wrong amount${WRITE ? ` (${fixed} fixed)` : ""}, ` +
    `${notRun} recorded but not run, ${unreadable} not checked`,
);
