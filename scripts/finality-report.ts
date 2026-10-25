/// What Phase 3's finality rule is picked from: the `finality_samples` rows the
/// `measure-finality` cron writes every minute.
///
///   deno run --allow-env --allow-read --allow-net scripts/finality-report.ts
///
/// Reports how far `safe` and `finalized` ran behind `latest`, in blocks and in
/// seconds (p50, p95, p99, max), how stale the RPC's own head was, any gaps in
/// the sampling, and whether a block seen at any head was later replaced. That
/// last check compares each stored hash with the chain's hash at that height
/// now, for heights the chain has since finalised: the lags say how long
/// finality takes, a replaced hash says whether waiting for it ever mattered.
///
/// Read-only. The service role key is read from .env, sent only to Supabase,
/// and never printed.

const env: Record<string, string> = {};
for (const line of (await Deno.readTextFile(".env")).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
}
const SUPABASE = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const RPC = env.CELO_RPC_URL || "https://forno.celo.org";
if (!SUPABASE || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env");

const TAGS = ["latest", "safe", "finalized"] as const;
type Tag = typeof TAGS[number];
type Row = { id: number; sampled_at: string } & {
  [K in `${Tag}_number`]: number | null;
} & { [K in `${Tag}_hash`]: string | null } & { [K in `${Tag}_time`]: string | null };

async function samples(): Promise<Row[]> {
  const out: Row[] = [];
  for (let after = 0;;) {
    const q = new URLSearchParams({ select: "*", id: `gt.${after}`, order: "id.asc", limit: "1000" });
    const res = await fetch(`${SUPABASE}/rest/v1/finality_samples?${q}`, {
      headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) throw new Error(`supabase answered ${res.status}: ${await res.text()}`);
    const page = await res.json() as Row[];
    out.push(...page);
    if (page.length < 1000) return out;
    after = page[page.length - 1].id;
  }
}

/// Canonical hash per height, batched. Small batches, retried once: this is a
/// one-off read of a few thousand blocks, not worth tripping a rate limit for.
async function canonicalHashes(heights: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < heights.length; i += 20) {
    const chunk = heights.slice(i, i + 20);
    const body = JSON.stringify(chunk.map((n, id) => ({
      jsonrpc: "2.0", id, method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false],
    })));
    let replies: { id: number; result?: { hash: string } | null }[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.ok) {
        replies = await res.json();
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    for (const r of replies) if (r.result) out.set(chunk[r.id], r.result.hash);
  }
  return out;
}

async function finalizedNow(): Promise<number> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["finalized", false] }),
  });
  return Number(BigInt((await res.json()).result.number));
}

/// Nearest-rank percentile.
function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

const rows = await samples();
if (rows.length < 2) {
  console.log(`finality_samples: ${rows.length} rows, not enough to report on yet`);
  Deno.exit(0);
}

const t = (s: string | null) => (s ? Date.parse(s) : NaN);
const first = rows[0].sampled_at, last = rows[rows.length - 1].sampled_at;
const hours = (t(last) - t(first)) / 3_600_000;
const gaps = rows.slice(1).map((r, i) => (t(r.sampled_at) - t(rows[i].sampled_at)) / 1000).filter((s) => s > 90);
console.log(
  `finality_samples: ${rows.length} rows, ${first.slice(0, 16)}Z to ${last.slice(0, 16)}Z (${hours.toFixed(1)}h), ` +
    `${gaps.length} gap(s) over 90s${gaps.length ? `, longest ${Math.round(Math.max(...gaps) / 60)} min` : ""}`,
);

const series: [string, number[]][] = [];
for (const tag of ["safe", "finalized"] as const) {
  const ok = rows.filter((r) => r[`${tag}_number`] !== null);
  series.push([`${tag} behind (blocks)`, ok.map((r) => r.latest_number! - r[`${tag}_number`]!)]);
  series.push([`${tag} behind (seconds)`, ok.map((r) => (t(r.latest_time) - t(r[`${tag}_time`])) / 1000)]);
}
series.push(["RPC head age (seconds)", rows.map((r) => (t(r.sampled_at) - t(r.latest_time)) / 1000)]);

console.log(`\n${"".padEnd(28)}${["n", "p50", "p95", "p99", "max"].map((h) => h.padStart(8)).join("")}`);
for (const [name, xs] of series) {
  const cells = [xs.length, pct(xs, 50), pct(xs, 95), pct(xs, 99), Math.max(...xs)];
  console.log(`${name.padEnd(28)}${cells.map((c) => String(Math.round(c)).padStart(8)).join("")}`);
}

// Replaced since seen: only heights at or below today's finalized head, where
// the chain's answer can no longer change.
const fin = await finalizedNow();
const wanted = new Set<number>();
for (const r of rows) for (const tag of TAGS) {
  const n = r[`${tag}_number`];
  if (n !== null && n <= fin) wanted.add(n);
}
const canon = await canonicalHashes([...wanted].sort((a, b) => a - b));
console.log(`\nReplaced since seen (checked against heights now finalised, up to ${fin}):`);
for (const tag of TAGS) {
  let checked = 0, replaced = 0;
  const examples: string[] = [];
  for (const r of rows) {
    const n = r[`${tag}_number`], h = r[`${tag}_hash`];
    if (n === null || h === null || !canon.has(n)) continue;
    checked++;
    if (canon.get(n) !== h) {
      replaced++;
      if (examples.length < 3) examples.push(`#${n} at ${r.sampled_at.slice(0, 16)}Z`);
    }
  }
  console.log(`  ${tag.padEnd(10)} ${replaced} of ${checked}${examples.length ? `  e.g. ${examples.join(", ")}` : ""}`);
}
const unchecked = [...wanted].filter((n) => !canon.has(n)).length;
if (unchecked) console.log(`  (${unchecked} heights could not be read from the RPC and were skipped)`);
