/// The developer kit's "done when", on Celo mainnet with real money: a request
/// answered by a schedule, the payment and its signed webhook, then an agent's
/// policy payment retried with its key. All through remesso-sdk, from source.
///
///   deno run --allow-all --config packages/remesso-sdk/deno.json --unstable-sloppy-imports scripts/e2e-sdk.ts          # reads only
///   deno run --allow-all --config packages/remesso-sdk/deno.json --unstable-sloppy-imports scripts/e2e-sdk.ts --send   # moves money
///
/// Without `--send` it is a dry run: balances, addresses, the plan and what it
/// would spend, and nothing signed. With it, about 1.03 USDT and a few cents of
/// CELO leave the test wallet, and the receiver spends a few cents of the USDT
/// it received on gas, paid in USDT because it holds no CELO: the SDK's
/// fee-currency path, which a local fork can't run (anvil has no CIP-64).
///   - the payer is the test wallet, TESTING_KEY_AGENT_WORKFLOW in .env;
///   - the receiver and the agent are keys derived from it (keccak256 of the
///     key and a label), so whatever they're sent can always be recovered by
///     deriving them again.
///
/// The receiver's webhook URL is a cloudflared quick tunnel (no account), so
/// cloudflared must be installed. SDK-created schedules are adopted by the
/// backend's sync within five minutes, so the first payment can take that long.
import {
  concat,
  createPublicClient,
  createWalletClient,
  formatEther,
  type Hex,
  http,
  keccak256,
  parseEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import {
  ATTRIBUTION,
  createRemesso,
  FEE_BPS,
  formatAmount,
  grossFor,
  memoryStore,
  RemessoError,
  token,
  webhookHandler,
  type WebhookMessage,
} from "../packages/remesso-sdk/src/index.ts";
import { erc20Abi } from "../packages/remesso-sdk/src/abi.ts";

const RPC = "https://forno.celo.org";
const send = Deno.args.includes("--send");
const USDT = token("USDT");

// --- keys: parsed from .env, never sourced or printed ------------------------
const envText = await Deno.readTextFile(new URL("../.env", import.meta.url));
const raw = envText.match(/^TESTING_KEY_AGENT_WORKFLOW=(.*)$/m)?.[1]?.trim() ?? "";
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
  console.error("TESTING_KEY_AGENT_WORKFLOW in .env must be a 32-byte hex key");
  Deno.exit(2);
}
const testKey = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
const derive = (label: string) => keccak256(concat([testKey, toHex(`remesso-sdk e2e: ${label}`)]));
const payerAccount = privateKeyToAccount(testKey);
const receiverAccount = privateKeyToAccount(derive("receiver"));
const agentAccount = privateKeyToAccount(derive("agent"));

const chain = createPublicClient({ chain: celo, transport: http(RPC) });
const chainId = await chain.getChainId();
if (chainId !== 42220) {
  console.error(`refusing: ${RPC} answers chain ${chainId}, not Celo mainnet`);
  Deno.exit(1);
}
const usdtOf = (who: `0x${string}`) => chain.readContract({ address: USDT.address, abi: erc20Abi, functionName: "balanceOf", args: [who] });

// --- the plan, and what it would cost -----------------------------------------
const scheduleGross = grossFor(1_000_000n, FEE_BPS); // 1 USDT asked: the recipient gets exactly 1
const policyPayment = 20_000n; // 0.02 USDT
const gasPrice = await chain.getGasPrice();
/// The payer's writes (approve + schedule, approve + policy, a CELO transfer,
/// a revoke) and the agent's payment, in gas, measured on our own
/// transactions and rounded up.
const GAS = { payer: 50_000n + 230_000n + 50_000n + 160_000n + 25_000n + 35_000n, agent: 120_000n };
// The agent gets enough CELO for its payment with room to spare, at today's price.
const agentGas = (() => {
  const need = GAS.agent * gasPrice * 3n;
  return need > parseEther("0.01") ? need : parseEther("0.01");
})();
const [payerUsdt, payerCelo, receiverUsdt, agentCelo] = await Promise.all([
  usdtOf(payerAccount.address),
  chain.getBalance({ address: payerAccount.address }),
  usdtOf(receiverAccount.address),
  chain.getBalance({ address: agentAccount.address }),
]);
const usdtNeeded = scheduleGross + policyPayment;
const celoNeeded = GAS.payer * gasPrice * 2n + agentGas;

console.log(`payer     ${payerAccount.address}  ${formatAmount(payerUsdt, USDT)}, ${formatEther(payerCelo)} CELO`);
console.log(`receiver  ${receiverAccount.address}  ${formatAmount(receiverUsdt, USDT)}  (derived: "receiver")`);
console.log(`agent     ${agentAccount.address}  ${formatEther(agentCelo)} CELO  (derived: "agent")`);
console.log(`\nplan:
  1. the receiver serves a webhook behind a cloudflared quick tunnel and subscribes
  2. the receiver asks the payer for 1 USDT, weekly, once
  3. the payer answers with a schedule: ${formatAmount(scheduleGross, USDT)} sent so 1 USDT arrives (${FEE_BPS}bps on top)
  4. wait for payment.received for that schedule (the sync adopts it within 5 minutes), then the request reads paid
  5. gas in USDT: the receiver, holding the 1 USDT and no CELO, creates and revokes a 0.01 policy;
     the SDK pays that gas in USDT through Celo's fee abstraction, the path a fork can't test
  6. the payer gives the agent a policy (0.05 a payment, 0.10 a day, 1 day, budget 0.10) and ${formatEther(agentGas)} CELO for gas
  7. the agent pays the receiver 0.02 USDT with an idempotency key; the same key again pays nothing
  8. wait for payment.received for the policy payment
  9. revoke the policy and the webhook subscription
spends: ${formatAmount(usdtNeeded, USDT)} (it stays with the derived receiver), about ${formatEther(celoNeeded)} CELO at ${Number(gasPrice) / 1e9} gwei,
        and a few cents of the receiver's own USDT for step 5's gas (none of it from the payer)`);

const short = [
  payerUsdt < usdtNeeded ? `the payer holds ${formatAmount(payerUsdt, USDT)}, under ${formatAmount(usdtNeeded, USDT)}` : null,
  payerCelo < celoNeeded ? `the payer holds ${formatEther(payerCelo)} CELO, under about ${formatEther(celoNeeded)}` : null,
].filter(Boolean);
const tunnel = await new Deno.Command("cloudflared", { args: ["--version"], stdout: "null", stderr: "null" }).output().then((o) => o.success).catch(() => false);
if (!tunnel) short.push("cloudflared isn't installed: it gives the webhook a public URL");
for (const s of short) console.log(`short: ${s}`);

if (!send) {
  console.log(`\ndry run: nothing signed. ${short.length ? "Fix the above, then pass" : "Pass"} --send to run it with real money.`);
  Deno.exit(short.length ? 1 : 0);
}
if (short.length) {
  console.error("\nrefusing to send: see above");
  Deno.exit(1);
}

// --- the run --------------------------------------------------------------------
const payer = createRemesso({ account: payerAccount });
const receiver = createRemesso({ account: receiverAccount });
const agent = createRemesso({ account: agentAccount, store: memoryStore() });
const wallet = createWalletClient({ account: payerAccount, chain: celo, transport: http(RPC) });

const started = Date.now();
const stages: { name: string; seconds: number; ok: boolean; note?: string }[] = [];
const txs: string[] = [];
const link = (h: string) => `https://celoscan.io/tx/${h}`;
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
  return ok;
};
async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n${name}`);
  const t = Date.now();
  try {
    const out = await fn();
    stages.push({ name, seconds: (Date.now() - t) / 1000, ok: true });
    return out;
  } catch (e) {
    stages.push({ name, seconds: (Date.now() - t) / 1000, ok: false, note: (e as Error).message });
    throw e;
  }
}

// Deliveries the receiver's server verified, in arrival order.
const delivered: WebhookMessage[] = [];
let secret: string | undefined;
const handler = webhookHandler({
  secret: () => secret,
  recipient: receiverAccount.address,
  onPayment: (m) => {
    console.log(`  webhook: ${m.type} ${m.data.schedule ? `schedule ${m.data.schedule}` : `policy ${m.data.policy}`} ${formatAmount(m.data.amount, USDT)} (${m.id})`);
    delivered.push(m);
  },
});
const waitForDelivery = async (match: (m: WebhookMessage) => boolean, timeoutMs: number): Promise<WebhookMessage> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const m = delivered.find(match);
    if (m) return m;
    if (Date.now() > until) throw new RemessoError("timeout", "no matching webhook in time");
    await new Promise((r) => setTimeout(r, 2000));
  }
};

const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handler);
const port = server.addr.port;
let cloudflared: Deno.ChildProcess | null = null;
let url = "";
let policyId: bigint | null = null;
let subscribed = false;
/// Step 5's policy, owned by the receiver, while it is still live.
let receiverPolicy: bigint | null = null;
let gasInUsdt = "not reached";
const describe = (e: unknown) => `${e instanceof RemessoError ? `${e.code}: ` : ""}${(e as Error).message}`;

try {
  url = await stage("1. a public webhook URL, and the subscription", async () => {
    cloudflared = new Deno.Command("cloudflared", {
      args: ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
      stdout: "null",
      stderr: "piped",
    }).spawn();
    // cloudflared prints the quick tunnel's URL in its log, on stderr.
    const lines = cloudflared.stderr.pipeThrough(new TextDecoderStream()).getReader();
    let found = "";
    const deadline = Date.now() + 60_000;
    let buf = "";
    while (!found && Date.now() < deadline) {
      const { value, done } = await lines.read();
      if (done) break;
      buf += value;
      found = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? "";
    }
    // Keep draining it, or cloudflared blocks on a full pipe.
    (async () => {
      try {
        while (!(await lines.read()).done) { /* discard */ }
      } catch { /* closed */ }
    })();
    if (!found) throw new Error("cloudflared printed no trycloudflare.com URL");
    // A new tunnel takes a few seconds to route. Our handler answers GET with
    // 405, so a 405 means the request came through.
    for (let i = 0; i < 45; i++) {
      const status = await fetch(found).then((r) => r.status).catch(() => 0);
      if (status === 405) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Remesso's side resolves the new name too, which can lag ours: retried.
    for (let attempt = 1; ; attempt++) {
      try {
        const sub = await receiver.webhooks.subscribe({ url: found });
        secret = sub.secret;
        subscribed = true;
        check(sub.state === "active", `subscribed at ${found}`);
        return found;
      } catch (e) {
        if (attempt >= 6 || !(e instanceof RemessoError && e.code === "invalid")) throw e;
        console.log(`  the challenge didn't get through yet (${e.message.slice(0, 80)}); retrying`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  });

  const req = await stage("2. the receiver asks the payer for 1 USDT", async () => {
    const r = await receiver.requests.create({ payer: payerAccount.address, amount: "1", token: "USDT", every: "week", runs: 1, from: "remesso-sdk e2e", note: "SDK end-to-end test" });
    console.log(`  request ${r.id}`);
    // Informational until request-payment's req= fix is deployed: the payer
    // here answers from code, which binds either way.
    console.log(r.link.includes(`req=${r.id}`) ? "  its link carries the request id" : "  note: its link doesn't carry req= yet (request-payment's fix isn't deployed)");
    return r;
  });

  const schedule = await stage("3. the payer answers with a schedule", async () => {
    const s = await payer.schedules.create({ request: req.id });
    if (s.approveHash) txs.push(link(s.approveHash));
    txs.push(link(s.hash));
    check(s.amountIn === scheduleGross && s.recipientGets >= 1_000_000n, `schedule #${s.id}: sends ${formatAmount(s.amountIn, USDT)}, ${formatAmount(s.recipientGets, USDT)} arrives`);
    check(!!s.request && "status" in s.request && s.request.status === "accepted", `the request reads ${s.request && "status" in s.request ? s.request.status : JSON.stringify(s.request)}`);
    return s;
  });

  await stage("4. the payment, its webhook, and the request paid", async () => {
    const m = await waitForDelivery((d) => d.type === "payment.received" && d.data.schedule === schedule.id.toString(), 12 * 60_000);
    txs.push(link(m.data.txHash));
    check(BigInt(m.data.amount) >= 1_000_000n, `webhook payment.received: ${formatAmount(m.data.amount, USDT)} arrived, signature verified`);
    console.log(`  ${Math.round((Date.now() - started) / 1000)}s from the start of this run to the first payment's webhook`);
    let status = await receiver.requests.get(req.id);
    for (let i = 0; i < 24 && status.payment?.state !== "paid"; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      status = await receiver.requests.get(req.id);
    }
    check(status.payment?.state === "paid" && status.payment.txs.some((t) => t.txHash === m.data.txHash), `the request's payment reads ${status.payment?.state}, with that transaction`);
  });

  await stage("5. gas paid in USDT: the receiver, with no CELO, creates and revokes a policy", async () => {
    const celoBefore = await chain.getBalance({ address: receiverAccount.address });
    if (celoBefore !== 0n) {
      gasInUsdt = `skipped: the receiver holds ${formatEther(celoBefore)} CELO`;
      console.log(`  ${gasInUsdt}, so its gas wouldn't be paid in USDT`);
      return;
    }
    const usdtBefore = await usdtOf(receiverAccount.address);
    const hashes: Hex[] = [];
    // A failure here is the answer this stage exists for, so it is a failed
    // check with the SDK's own words, and the run carries on.
    try {
      const pol = await receiver.policies.create({ agent: agentAccount.address, token: "USDT", perPayment: "0.01", perDay: "0.01", days: 1, budget: "0.01" });
      receiverPolicy = pol.id;
      hashes.push(pol.approveHash, pol.hash);
      console.log(`  policy #${pol.id}, owned by the receiver`);
    } catch (e) {
      check(false, `policies.create with no CELO: ${describe(e)}`);
    }
    if (receiverPolicy != null) {
      try {
        hashes.push(await receiver.policies.revoke(receiverPolicy));
        console.log(`  policy #${receiverPolicy} revoked`);
        receiverPolicy = null;
      } catch (e) {
        check(false, `policies.revoke with no CELO: ${describe(e)}`);
      }
    }
    // Each one mined, succeeded, and named USDT's fee currency: the evidence
    // the gas went through fee abstraction rather than CELO.
    for (const h of hashes) {
      txs.push(link(h));
      const [tx, r] = await Promise.all([chain.getTransaction({ hash: h }), chain.getTransactionReceipt({ hash: h })]);
      const fc = (tx as { feeCurrency?: string | null }).feeCurrency ?? null;
      check(
        r.status === "success" && fc?.toLowerCase() === USDT.feeCurrency?.toLowerCase(),
        `${link(h)}: ${r.status}, gas paid through ${fc ?? "CELO"} (${r.gasUsed} gas)`,
      );
    }
    const [celoAfter, usdtAfter] = await Promise.all([chain.getBalance({ address: receiverAccount.address }), usdtOf(receiverAccount.address)]);
    check(celoAfter === 0n, `the receiver still holds no CELO (${formatEther(celoAfter)})`);
    // Approving, creating and revoking move no tokens, so the whole drop is gas.
    const spent = usdtBefore - usdtAfter;
    const ok = check(hashes.length > 0 && spent > 0n && spent < 100_000n, `gas paid in USDT: ${formatAmount(spent, USDT)} for ${hashes.length} transaction(s)`);
    gasInUsdt = ok && receiverPolicy == null && hashes.length === 3
      ? `${formatAmount(spent, USDT)} for 3 transactions, no CELO`
      : `incomplete: ${hashes.length} of 3 transactions went out, ${formatAmount(spent, USDT)} spent`;
  });

  const paid = await stage("6. a policy for the agent, and its payment retried once", async () => {
    const pol = await payer.policies.create({ agent: agentAccount.address, token: "USDT", perPayment: "0.05", perDay: "0.10", days: 1, budget: "0.10" });
    policyId = pol.id;
    txs.push(link(pol.approveHash), link(pol.hash));
    console.log(`  policy #${pol.id}`);
    const gasTx = await wallet.sendTransaction({ to: agentAccount.address, value: agentGas, data: ATTRIBUTION });
    const gasReceipt = await chain.waitForTransactionReceipt({ hash: gasTx });
    txs.push(link(gasTx));
    check(gasReceipt.status === "success", `${formatEther(agentGas)} CELO to the agent for gas`);

    // The policy named outright: step 5 may have left the receiver's own policy
    // for this agent live, and paying its owner from it is refused.
    const key = `e2e-${new Date().toISOString()}`;
    const before = await usdtOf(receiverAccount.address);
    const first = await agent.pay({ to: receiverAccount.address, amount: "0.02", token: "USDT", policyId: pol.id, idempotencyKey: key, memo: "sdk e2e" });
    txs.push(link(first.hash));
    check(first.status === "confirmed" && (await usdtOf(receiverAccount.address)) - before === policyPayment, `the agent paid 0.02 USDT: ${first.hash}`);
    const mid = await usdtOf(receiverAccount.address);
    const again = await agent.pay({ to: receiverAccount.address, amount: "0.02", token: "USDT", policyId: pol.id, idempotencyKey: key, memo: "sdk e2e" });
    check(again.repeat === true && again.hash === first.hash && (await usdtOf(receiverAccount.address)) === mid, "the same key again: the first payment's hash, nothing new sent");
    return first;
  });

  await stage("7. the policy payment's webhook", async () => {
    const m = await waitForDelivery((d) => d.type === "payment.received" && d.data.txHash.toLowerCase() === paid.hash.toLowerCase(), 5 * 60_000);
    check(m.data.policy === String(policyId) && m.data.amount === policyPayment.toString() && m.data.memoText === "sdk e2e", `webhook payment.received for policy ${m.data.policy}: ${formatAmount(m.data.amount, USDT)}, memo "${m.data.memoText}"`);
  });
} catch (e) {
  failures++;
  console.error(`\nstopped: ${e instanceof RemessoError ? `${e.code}: ` : ""}${(e as Error).message}`);
} finally {
  console.log("\ncleanup");
  if (policyId != null) {
    try {
      txs.push(link(await payer.policies.revoke(policyId)));
      console.log(`  policy #${policyId} revoked`);
    } catch (e) {
      console.log(`  couldn't revoke policy #${policyId}: ${(e as Error).message}`);
    }
  }
  if (receiverPolicy != null) {
    // Revoking it needs gas the receiver doesn't hold. Left as it is: it
    // expires within a day, allows 0.01 USDT a day, and only the derived
    // agent can spend it.
    console.log(`  the receiver's policy #${receiverPolicy} is still live: it expires within a day, 0.01 USDT a day, spendable only by the derived agent`);
  }
  if (subscribed) {
    try {
      await receiver.webhooks.revoke({ url });
      console.log("  webhook subscription revoked");
    } catch (e) {
      console.log(`  couldn't revoke the webhook subscription: ${(e as Error).message}`);
    }
  }
  try {
    (cloudflared as Deno.ChildProcess | null)?.kill("SIGTERM");
  } catch { /* gone */ }
  await server.shutdown();
}

console.log("\nstages");
for (const s of stages) console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.seconds.toFixed(0).padStart(4)}s  ${s.name}${s.note ? ` (${s.note})` : ""}`);
console.log(`\ngas in USDT: ${gasInUsdt}`);
console.log("\ntransactions");
for (const t of txs) console.log(`  ${t}`);
console.log(`\nthe receiver ${receiverAccount.address} and the agent ${agentAccount.address} keep what they were sent; derive them again from the test key to recover it.`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
