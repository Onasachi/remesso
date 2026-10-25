/// A family allowance: a parent's agent pays cNGN every week, and the child
/// hears each payment with a link to cash it out to their own bank.
///
/// The whole loop: request, answer, payment, webhook.
///   1. `child` asks the parent's wallet for AMOUNT cNGN a week, then listens
///      for payments by signed webhook.
///   2. `parent` lists the requests sent to the parent's wallet and answers
///      one with a weekly schedule. The request's terms fill it in, and the
///      SDK adds Remesso's fee on top so the child receives the amount asked.
///      It asks before signing: this moves real money.
///   3. Remesso's executor sends each payment when it's due.
///   4. The child's agent hears it and prints how much arrived, with the
///      Textile link to withdraw it.
///
///   npm install remesso-sdk viem
///   CHILD_KEY=0x… PARENT=0x… PUBLIC_URL=https://….trycloudflare.com npx tsx family-allowance-agent.ts child
///   PARENT_KEY=0x… npx tsx family-allowance-agent.ts parent
///
/// PUBLIC_URL is any https address that reaches PORT (default 8788) on the
/// child's machine. For a test, `cloudflared tunnel --url http://localhost:8788`
/// prints one, with no account needed.
///
/// Inside the Remesso repo, before remesso-sdk is published:
///   deno run -A --config examples/sdk.deno.json --unstable-sloppy-imports examples/family-allowance-agent.ts <role>
///
/// What it costs: the child needs no gas and no balance. The parent pays
/// Remesso's 0.25% fee on top of each payment, plus about 0.05 CELO of gas to
/// sign the schedule once. Remesso's executor pays the gas of every weekly
/// payment after that.
///
/// cNGN is the Nigerian naira stablecoin, 6 decimals. Remesso's executor sends
/// 1,300 to 1,300,000 cNGN per payment; outside that, a schedule never runs.
/// Cashing out is Textile's "Withdraw NGN": the child withdraws to a bank
/// account in their own name, from their own wallet. Remesso pays out no
/// naira itself.
///
/// The contracts are live on Celo mainnet and haven't been audited by a
/// person. Start with small amounts.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  createRemesso,
  FEE_BPS,
  formatAmount,
  grossFor,
  RemessoError,
  runLimits,
  token,
  toUnits,
  webhookHandler,
  type WebhookMessage,
} from "remesso-sdk";
import { toNodeListener } from "remesso-sdk/node";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TEXTILE_WITHDRAW = "https://app.textilecredit.com/s/sell?chainId=42220";

const role = process.argv[2];
if (!["child", "parent"].includes(role)) {
  console.error("usage: family-allowance-agent.ts child | parent");
  process.exit(2);
}

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim() || fallback;
  if (v == null) {
    console.error(`set ${name} (see the top of this file)`);
    process.exit(2);
  }
  return v;
};
const accountFrom = (name: string) => {
  const key = env(name);
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    console.error(`${name} must be a 32-byte hex private key`);
    process.exit(2);
  }
  return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
};

const DIR = env("STATE_DIR", "./family-allowance-agent");
const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
};
async function writePrivate(path: string, body: unknown) {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

/// The child's side: ask once, then listen.
async function child() {
  const account = accountFrom("CHILD_KEY");
  const remesso = createRemesso({ account });
  const url = env("PUBLIC_URL");
  const port = Number(env("PORT", "8788"));
  const cngn = token("cNGN");

  let req = await readJson<{ id: string; parent: string }>(`${DIR}/request.json`);
  if (!req) {
    const parent = env("PARENT");
    const amount = env("AMOUNT", "5000");
    const { min } = runLimits(cngn);
    if (toUnits(amount, cngn) < min) {
      console.error(`ask for at least ${formatAmount(min, cngn)} a week: below that the executor never sends it`);
      process.exit(2);
    }
    const made = await remesso.requests.create({
      payer: parent,
      amount,
      token: "cNGN",
      every: "week",
      runs: Number(env("RUNS", "12")),
      from: env("FROM", "Your child"),
      note: env("NOTE", "Weekly allowance"),
    });
    req = { id: made.id, parent };
    await writePrivate(`${DIR}/request.json`, req);
    console.log(`asked ${parent} for ${amount} cNGN a week (request ${made.id}).`);
    console.log("It's in their Remesso inbox, and their agent sees it with `parent`. The link, if they'd rather use the app:");
    console.log(`  ${made.link}\n`);
  }

  let webhook = await readJson<{ url: string; secret: string }>(`${DIR}/webhook.json`);
  const seen = new Set<string>();
  const handle = webhookHandler({
    secret: () => webhook?.url === url ? webhook.secret : undefined,
    recipient: account.address,
    onPayment: async (m: WebhookMessage) => {
      if (seen.has(m.id) || !m.data.schedule) return;
      const r = await remesso.requests.get(req!.id);
      if (!r.payment?.schedule) throw new Error("the allowance isn't answered yet"); // Remesso retries
      if (r.payment.schedule.id !== m.data.schedule) return; // some other payment to this wallet
      seen.add(m.id);
      const amount = formatAmount(m.data.amount ?? "0", m.data.token ?? "cNGN");
      if (m.type === "payment.received") {
        console.log(`\nAllowance received: ${amount} (week ${m.data.runNumber}).`);
        console.log(`  https://celoscan.io/tx/${m.data.txHash}`);
        console.log(`  Cash it out to your own bank on Textile ("Withdraw NGN"): ${TEXTILE_WITHDRAW}`);
      } else if (m.type === "payment.finalized") {
        console.log(`Week ${m.data.runNumber}'s ${amount} is final.`);
      } else {
        console.log(`Week ${m.data.runNumber}'s payment was undone by a reorg: nothing arrived. Don't withdraw it.`);
      }
    },
  });
  const server = createServer(toNodeListener(handle));
  await new Promise<void>((resolve) => server.listen(port, resolve));

  if (webhook?.url !== url) {
    try {
      webhook = { url, secret: (await remesso.webhooks.subscribe({ url })).secret };
    } catch (e) {
      if (!(e instanceof RemessoError && e.code === "conflict")) throw e;
      webhook = { url, secret: (await remesso.webhooks.rotate({ url })).secret }; // the old secret was lost
    }
    await writePrivate(`${DIR}/webhook.json`, webhook);
  }
  console.log(`listening for the allowance at ${url}. Ctrl-C to stop.`);
}

/// The parent's side: answer a request with a weekly schedule, after a yes.
async function parent() {
  const account = accountFrom("PARENT_KEY");
  const remesso = createRemesso({ account });
  const waiting = (await remesso.requests.list()).filter((r) => r.token === "cNGN");
  if (!waiting.length) return console.log(`no cNGN requests are waiting for ${account.address}`);

  waiting.forEach((r, i) => {
    const every = r.intervalSeconds ? `every ${Math.round(r.intervalSeconds / 86_400)} days` : "";
    console.log(`${i + 1}. ${r.from ?? "someone"} asks for ${r.amount} cNGN ${every}, ${r.runs ?? "?"} times: "${r.note ?? ""}"  (${r.id})`);
  });
  const ask = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pick = waiting.length === 1 ? 1 : Number(await ask.question(`Which one? [1-${waiting.length}] `));
    const r = waiting[pick - 1];
    if (!r?.amount || !r.runs) return console.log("nothing chosen");

    // What will be signed: the child receives the amount asked, and the fee
    // goes on top.
    const cngn = token("cNGN");
    const each = grossFor(toUnits(r.amount, cngn), FEE_BPS);
    console.log(`\n${r.from ?? "They"} receive ${r.amount} cNGN a week, ${r.runs} times.`);
    console.log(`You send ${formatAmount(each, cngn)} each week (Remesso's ${FEE_BPS / 100}% on top), at most ${formatAmount(each * BigInt(r.runs), cngn)} in all.`);
    console.log("You approve that total once; cancelling the schedule stops it at any time.");
    if ((await ask.question("Sign it? [y/N] ")).trim().toLowerCase() !== "y") return console.log("not signed");

    const s = await remesso.schedules.create({ request: r.id });
    console.log(`\nschedule #${s.id} is live: https://celoscan.io/tx/${s.hash}`);
    console.log(s.request && "status" in s.request ? `the request reads ${s.request.status}` : `the request didn't take the answer: ${s.request && "error" in s.request ? s.request.error : "unknown"}`);
    for (const w of s.warnings) console.log(`note: ${w}`);
    console.log("The first payment goes out within a few minutes, then weekly.");
  } finally {
    ask.close();
  }
}

const roles: Record<string, () => Promise<void>> = { child, parent };
try {
  await roles[role]();
} catch (e) {
  console.error(e instanceof RemessoError ? `${e.code}: ${e.message}` : (e as Error).message ?? e);
  process.exit(1);
}
