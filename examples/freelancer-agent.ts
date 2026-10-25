/// A freelancer's agent: bills a client in wARS every month, and writes a
/// receipt each time a payment lands.
///
/// The whole loop: request, answer, payment, webhook.
///   1. `request` asks the client's wallet for AMOUNT wARS a month and prints
///      a link for the client.
///   2. The client answers. Either they open the link in their wallet's
///      browser and sign in the Remesso app, or their own code calls
///      `schedules.create({ request: id })`. The link carries the request id,
///      so the schedule they sign answers this request.
///   3. Remesso's executor sends each payment when it's due.
///   4. `serve` hears every payment by signed webhook and writes a receipt,
///      marked final once Celo's finalized block passes it.
///
///   npm install remesso-sdk viem
///   FREELANCER_KEY=0x… CLIENT=0x… npx tsx freelancer-agent.ts request
///   FREELANCER_KEY=0x… PUBLIC_URL=https://….trycloudflare.com npx tsx freelancer-agent.ts serve
///   FREELANCER_KEY=0x… npx tsx freelancer-agent.ts status
///
/// PUBLIC_URL is any https address that reaches PORT (default 8787) on this
/// machine. For a test, `cloudflared tunnel --url http://localhost:8787`
/// prints one, with no account needed.
///
/// Inside the Remesso repo, before remesso-sdk is published:
///   deno run -A --config examples/sdk.deno.json --unstable-sloppy-imports examples/freelancer-agent.ts <role>
///
/// What it costs: asking and receiving are free. The freelancer needs no gas
/// and no balance. The client pays Remesso's 0.25% fee on top, so the full
/// amount arrives, plus about 0.05 CELO of gas to sign the schedule.
///
/// wARS is Ripio's Argentine peso, 18 decimals. Remesso's executor sends 1,500
/// to 1,500,000 wARS per payment; outside that, a schedule never runs. The
/// client needs wARS (Ripio's ramp sells it), and the freelancer needs a
/// wallet that shows it: MiniPay doesn't.
///
/// The contracts are live on Celo mainnet and haven't been audited by a
/// person. Start with small amounts.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
import {
  createRemesso,
  formatAmount,
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

const role = process.argv[2];
if (!["request", "serve", "status"].includes(role)) {
  console.error("usage: freelancer-agent.ts request | serve | status");
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

const key = env("FREELANCER_KEY");
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
  console.error("FREELANCER_KEY must be a 32-byte hex private key");
  process.exit(2);
}
const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
const remesso = createRemesso({ account });

/// Everything the agent remembers, in one folder: the request, the webhook
/// secret, the deliveries already handled, and the receipts.
const DIR = env("STATE_DIR", "./freelancer-agent");
const files = {
  request: `${DIR}/request.json`,
  webhook: `${DIR}/webhook.json`,
  seen: `${DIR}/seen.json`,
  receipts: `${DIR}/receipts`,
};
const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
};
/// Written 0600: the webhook secret is what proves a delivery came from Remesso.
async function writePrivate(path: string, body: unknown) {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

type SavedRequest = { id: string; reference: string; client: string; amount: string; createdAt: string };

async function request() {
  const client = env("CLIENT");
  const amount = env("AMOUNT", "150000");
  const runs = Number(env("RUNS", "12"));
  const wars = token("wARS");
  // The executor runs nothing under its minimum. What the client sends is a
  // little more than what you ask (the fee goes on top), so asking at least
  // the minimum is enough.
  const { min } = runLimits(wars);
  if (toUnits(amount, wars) < min) {
    console.error(`ask for at least ${formatAmount(min, wars)} a month: below that the executor never sends it`);
    process.exit(2);
  }
  const made = await remesso.requests.create({
    payer: client,
    amount,
    token: "wARS",
    every: "month",
    runs,
    from: env("FROM", "Freelancer"),
    note: env("NOTE", "Monthly invoice"),
  });
  await writePrivate(files.request, { id: made.id, reference: made.reference, client, amount, createdAt: new Date().toISOString() } satisfies SavedRequest);
  console.log(`asked ${client} for ${amount} wARS a month, ${runs} times.`);
  console.log(`request ${made.id}: it's in their Remesso inbox now.\n`);
  console.log("Send them this link. It opens their form filled in, and they sign in their own wallet:");
  console.log(`  ${made.link}\n`);
  console.log(`Then run \`serve\` to hear each payment and write its receipt.`);
}

async function status() {
  const saved = await readJson<SavedRequest>(files.request);
  if (!saved) throw new Error("no request yet: run `request` first");
  const r = await remesso.requests.get(saved.id);
  console.log(`request ${r.id}: ${r.status}`);
  if (!r.payment) return console.log("not answered yet");
  console.log(`payment: ${r.payment.state}${r.payment.reason ? ` (${r.payment.reason})` : ""}`);
  for (const tx of r.payment.txs) console.log(`  ${tx.blockTime}  ${formatAmount(tx.amount, "wARS")}  https://celoscan.io/tx/${tx.txHash}${tx.final ? "  final" : ""}`);
}

async function serve() {
  const saved = await readJson<SavedRequest>(files.request);
  if (!saved) throw new Error("no request yet: run `request` first");
  const url = env("PUBLIC_URL");
  const port = Number(env("PORT", "8787"));
  let webhook = await readJson<{ url: string; secret: string }>(files.webhook);
  const seen = new Set(await readJson<string[]>(files.seen) ?? []);

  async function onPayment(m: WebhookMessage) {
    // The same webhook-id comes on every retry: handle each one once.
    if (seen.has(m.id)) return;
    if (!m.data.schedule) return; // a policy payment: no schedule answers a request that way here

    // Only a payment from a schedule that answers this request gets a receipt.
    const r = await remesso.requests.get(saved!.id);
    if (!r.payment?.schedule) {
      // The answer may not be recorded yet. Throwing makes Remesso retry later.
      throw new Error(`request ${saved!.id} isn't answered yet`);
    }
    if (r.payment.schedule.id !== m.data.schedule || r.payment.schedule.contract.toLowerCase() !== m.data.contract.toLowerCase()) {
      console.log(`a payment from schedule ${m.data.schedule} isn't for this request: ignored`);
      seen.add(m.id);
      return;
    }
    await writeReceipt(saved!, m);
    seen.add(m.id);
    await writePrivate(files.seen, [...seen].slice(-1000));
  }

  const handle = webhookHandler({
    // Read on every delivery: the secret only exists once the endpoint has
    // answered Remesso's challenge, a moment after this server starts.
    secret: () => webhook?.url === url ? webhook.secret : undefined,
    recipient: account.address,
    onPayment,
  });
  const server = createServer(toNodeListener(handle));
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`listening on :${port}, public at ${url}`);

  if (webhook?.url !== url) {
    try {
      const sub = await remesso.webhooks.subscribe({ url });
      webhook = { url, secret: sub.secret };
    } catch (e) {
      // Subscribed before, with the secret lost: a new one replaces it. The
      // old one keeps signing alongside it for a day.
      if (!(e instanceof RemessoError && e.code === "conflict")) throw e;
      webhook = { url, secret: (await remesso.webhooks.rotate({ url })).secret };
    }
    await writePrivate(files.webhook, webhook);
    console.log(`subscribed: payments to ${account.address} are announced at ${url}`);
  } else {
    console.log(`already subscribed at ${url}`);
  }
  console.log(`waiting for payments on request ${saved.id}. Ctrl-C to stop.`);
}

/// One receipt per payment, rewritten when it becomes final or is undone.
async function writeReceipt(saved: SavedRequest, m: WebhookMessage) {
  const d = m.data;
  const path = `${files.receipts}/${saved.reference}-${String(d.runNumber ?? 0).padStart(2, "0")}.md`;
  const state = m.type === "payment.removed"
    ? "VOID: the block holding this payment was replaced. Nothing was received."
    : d.final
    ? "Final: past Celo's finalized block."
    : "Received. Not final yet: Celo finalizes in about half an hour.";
  const lines = [
    `# Receipt ${saved.reference.slice(0, 8)}-${d.runNumber ?? "?"}`,
    "",
    `Received: ${formatAmount(d.amount ?? "0", d.token ?? "wARS")}`,
    `From: ${d.from}`,
    `To: ${d.to}`,
    `Date: ${d.blockTime}`,
    `Payment ${d.runNumber} of the request ${saved.id}`,
    `Transaction: https://celoscan.io/tx/${d.txHash}`,
    "",
    state,
    "",
  ];
  await mkdir(files.receipts, { recursive: true });
  await writeFile(path, lines.join("\n"));
  console.log(`${m.type}: ${formatAmount(d.amount ?? "0", d.token ?? "wARS")}, payment ${d.runNumber}, receipt ${path}`);
}

const roles: Record<string, () => Promise<void>> = { request, serve, status };
try {
  await roles[role]();
} catch (e) {
  console.error(e instanceof RemessoError ? `${e.code}: ${e.message}` : (e as Error).message ?? e);
  process.exit(1);
}
