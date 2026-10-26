/// The developer kit's "done when", on Celo mainnet with real money: a request
/// answered by a schedule, the payment and its signed webhook, an agent's
/// policy payment retried with its key, then a one-off request paid from the
/// payer's own wallet with `remittances.send`. All through remesso-sdk, from source.
///
///   deno run --allow-all --config packages/remesso-sdk/deno.json --unstable-sloppy-imports scripts/e2e-sdk.ts          # reads only
///   deno run --allow-all --config packages/remesso-sdk/deno.json --unstable-sloppy-imports scripts/e2e-sdk.ts --send   # moves money
///
/// It pays in USDT; `--token USDC` pays in USDC instead. `--wallet-only` runs
/// just the webhook and the wallet-funded payment, about 1 of the token.
/// Without `--send` it is a dry run: balances, addresses, the plan and what it
/// would spend, and nothing signed. With it, about 2.03 of the token and a few cents of CELO
/// leave the test wallet, and the receiver spends a few cents of the token it
/// received on gas, paid in that token because it holds no CELO: the SDK's
/// fee-currency path, which a local fork can't run (anvil has no CIP-64).
///   - the payer is the test wallet, TESTING_KEY_AGENT_WORKFLOW in .env;
///   - the receiver and the agent are keys derived from it (keccak256 of the
///     key and a label), so whatever they're sent can always be recovered by
///     deriving them again.
///
/// The receiver's webhook URL is a cloudflared quick tunnel (no account), so
/// cloudflared must be installed. SDK-created schedules are adopted by the
/// backend's sync within five minutes, so the first payment can take that long.
import { verifyTx } from "npm:@celo/attribution-tags@0.5.0";
import {
  concat,
  createPublicClient,
  createWalletClient,
  formatEther,
  type Hex,
  http,
  keccak256,
  parseAbiItem,
  parseEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import {
  ALLOWANCE,
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
const walletOnly = Deno.args.includes("--wallet-only");
/// What it pays in: USDT, or the token `--token` names. The amounts below are
/// in 6-decimal units and stage 5 pays gas in it, so it must be a 6-decimal
/// dollar token Celo takes gas in.
const tokenFlag = Deno.args.indexOf("--token");
const TOKEN = token(tokenFlag >= 0 ? Deno.args[tokenFlag + 1] ?? "" : "USDT");
if (TOKEN.decimals !== 6 || TOKEN.currency !== "USD" || !TOKEN.feeCurrency) {
  console.error(`--token ${TOKEN.symbol}: this run needs a 6-decimal dollar token Celo takes gas in, such as USDT or USDC`);
  Deno.exit(2);
}
const SYM = TOKEN.symbol;
/// A builder code standing in for an integrator's (Phase 6). Not registered
/// with Celo: it shows a code riding from the schedule's transaction onto its run.
const BUILDER_CODE = "remesso_e2e";
const OURS = ["remesso", "celo_5cd35ca55baf"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
/// The codes Celo's own attribution SDK reads from a transaction.
const codesOf = async (hash: Hex) => (await verifyTx({ client: chain as never, hash }))?.codes ?? null;
const tokensOf = (who: `0x${string}`) => chain.readContract({ address: TOKEN.address, abi: erc20Abi, functionName: "balanceOf", args: [who] });
/// Whether `read` comes to satisfy `ok` within `ms`. Right after a transaction
/// lands, forno can answer from a node a block behind, so a balance read once
/// can show the money before it moved: the first mainnet run failed checks
/// that way while paying correctly.
async function settles<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (ok(await read())) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
/// A balance of the token at a block. A node that hasn't reached it answers "block is
/// out of range", so the read is retried until one has.
async function tokensAt(who: `0x${string}`, blockNumber: bigint): Promise<bigint> {
  for (let i = 0; ; i++) {
    try {
      return await chain.readContract({ address: TOKEN.address, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber });
    } catch (e) {
      if (i >= 15) throw e;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

// --- the plan, and what it would cost -----------------------------------------
const scheduleGross = grossFor(1_000_000n, FEE_BPS); // 1 asked: the recipient gets exactly 1
const policyPayment = 20_000n; // 0.02
/// The one-off paid from the payer's own wallet: 1 arrives, the fee on top.
const walletGross = grossFor(1_000_000n, FEE_BPS);
const PAID = parseAbiItem("event Paid(uint256 indexed id, address indexed to, uint256 amount, bytes32 memo)");
const gasPrice = await chain.getGasPrice();
/// The payer's writes (approve + schedule, approve + policy, a CELO transfer,
/// a revoke), the wallet payment's (schedule, approval, run) and the agent's
/// payment, in gas, measured on our own transactions and rounded up.
const GAS = { payer: 50_000n + 230_000n + 50_000n + 160_000n + 25_000n + 35_000n, wallet: 230_000n + 50_000n + 120_000n, agent: 120_000n };
// The agent gets enough CELO for its payment with room to spare, at today's price.
const agentGas = (() => {
  const need = GAS.agent * gasPrice * 3n;
  return need > parseEther("0.01") ? need : parseEther("0.01");
})();
const [payerTokens, payerCelo, receiverTokens, agentCelo] = await Promise.all([
  tokensOf(payerAccount.address),
  chain.getBalance({ address: payerAccount.address }),
  tokensOf(receiverAccount.address),
  chain.getBalance({ address: agentAccount.address }),
]);
/// What the agent is sent: only what it's short of, when earlier runs left it some.
const agentTopUp = agentCelo >= agentGas ? 0n : agentGas - agentCelo;
const tokensNeeded = walletOnly ? walletGross : scheduleGross + policyPayment + walletGross;
const celoNeeded = ((walletOnly ? 0n : GAS.payer) + GAS.wallet) * gasPrice * 2n + (walletOnly ? 0n : agentTopUp);

console.log(`payer     ${payerAccount.address}  ${formatAmount(payerTokens, TOKEN)}, ${formatEther(payerCelo)} CELO`);
console.log(`receiver  ${receiverAccount.address}  ${formatAmount(receiverTokens, TOKEN)}  (derived: "receiver")`);
console.log(`agent     ${agentAccount.address}  ${formatEther(agentCelo)} CELO  (derived: "agent")`);
console.log(`\nplan${walletOnly ? " (--wallet-only: steps 1, 9, 10 and 11)" : ""}:
  1. the receiver serves a webhook behind a cloudflared quick tunnel and subscribes
  2. the receiver asks the payer for 1 ${SYM}, weekly, once
  3. the payer answers with a schedule: ${formatAmount(scheduleGross, TOKEN)} sent so 1 ${SYM} arrives (${FEE_BPS}bps on top),
     its transaction tagged with the builder code ${BUILDER_CODE}
  4. wait for payment.received for that schedule (the sync adopts it within 5 minutes), then the request reads paid,
     and the run carries ${BUILDER_CODE} after ours
  5. gas in ${SYM}: the receiver, holding the 1 ${SYM} and no CELO, creates and revokes a 0.01 policy;
     the SDK pays that gas in ${SYM} through Celo's fee abstraction, the path a fork can't test
  6. the payer gives the agent a policy (0.05 a payment, 0.10 a day, 1 day, budget 0.10) and ${agentTopUp ? `${formatEther(agentTopUp)} CELO for gas` : `no CELO: it holds ${formatEther(agentCelo)}, enough for its gas`}
  7. the agent pays the receiver 0.02 ${SYM} with an idempotency key; the same key again pays nothing
  8. wait for payment.received for the policy payment
  9. the receiver asks the payer for 1 ${SYM}, once, and the payer pays it from its own wallet with remittances.send:
     a one-run schedule it approves and runs itself, ${formatAmount(walletGross, TOKEN)} sent so 1 ${SYM} arrives; the same key again sends nothing
  10. wait for payment.received for that payment, then the request reads paid
  11. revoke the policy and the webhook subscription
spends: ${formatAmount(tokensNeeded, TOKEN)} (it stays with the derived receiver), about ${formatEther(celoNeeded)} CELO at ${Number(gasPrice) / 1e9} gwei,
        and a few cents of the receiver's own ${SYM} for step 5's gas (none of it from the payer)`);

const short = [
  payerTokens < tokensNeeded ? `the payer holds ${formatAmount(payerTokens, TOKEN)}, under ${formatAmount(tokensNeeded, TOKEN)}` : null,
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
/// How many times the payer's client sent `answer`: once means the backend
/// bound the request on its own, without the SDK retrying a 409.
let answerCalls = 0;
const payer = createRemesso({
  account: payerAccount,
  builderCodes: [BUILDER_CODE],
  fetch: (input, init) => {
    if (typeof init?.body === "string" && init.body.includes('"action":"answer"')) answerCalls++;
    return fetch(input, init);
  },
});
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
    console.log(`  webhook: ${m.type} ${m.data.schedule ? `schedule ${m.data.schedule}` : `policy ${m.data.policy}`} ${formatAmount(m.data.amount, TOKEN)} (${m.id})`);
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
let gasInToken = "not reached";
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

  // --wallet-only goes straight to the wallet-funded payment.
  if (!walletOnly) {
    const req = await stage(`2. the receiver asks the payer for 1 ${SYM}`, async () => {
      const r = await receiver.requests.create({ payer: payerAccount.address, amount: "1", token: TOKEN.symbol, every: "week", runs: 1, from: "remesso-sdk e2e", note: "SDK end-to-end test" });
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
      check(s.amountIn === scheduleGross && s.recipientGets >= 1_000_000n, `schedule #${s.id}: sends ${formatAmount(s.amountIn, TOKEN)}, ${formatAmount(s.recipientGets, TOKEN)} arrives`);
      check(!!s.request && "status" in s.request && s.request.status === "accepted", `the request reads ${s.request && "status" in s.request ? s.request.status : JSON.stringify(s.request)}`);
      console.log(`  the answer took ${answerCalls} call(s)${answerCalls === 1 ? ": the backend bound it on the first" : ": the SDK retried while the backend couldn't see the schedule"}`);
      check(same(await codesOf(s.hash), [...OURS, BUILDER_CODE]), `its createSchedule carries ${[...OURS, BUILDER_CODE].join(", ")} (verifyTx)`);
      return s;
    });

    await stage("4. the payment, its webhook, and the request paid", async () => {
      const m = await waitForDelivery((d) => d.type === "payment.received" && d.data.schedule === schedule.id.toString(), 12 * 60_000);
      txs.push(link(m.data.txHash));
      check(BigInt(m.data.amount) >= 1_000_000n, `webhook payment.received: ${formatAmount(m.data.amount, TOKEN)} arrived, signature verified`);
      console.log(`  ${Math.round((Date.now() - started) / 1000)}s from the start of this run to the first payment's webhook`);
      let status = await receiver.requests.get(req.id);
      for (let i = 0; i < 24 && status.payment?.state !== "paid"; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        status = await receiver.requests.get(req.id);
      }
      check(status.payment?.state === "paid" && status.payment.txs.some((t) => t.txHash === m.data.txHash), `the request's payment reads ${status.payment?.state}, with that transaction`);
      // Builder codes (Phase 6): the executor's run carries the code the
      // schedule's own transaction did, read back from where the indexer stored it.
      check(same(await codesOf(m.data.txHash), [...OURS, BUILDER_CODE]), `the run carries ${BUILDER_CODE} after ours (verifyTx)`);
      const created = (await payer.events.list({ role: "from", kinds: ["schedule_created"], limit: 500 })).events
        .find((e) => e.refId === schedule.id.toString());
      check(same(created?.details?.builderCodes, [BUILDER_CODE]), `its schedule_created event lists builderCodes ${JSON.stringify(created?.details?.builderCodes)}`);
    });

    await stage(`5. gas paid in ${SYM}: the receiver, with no CELO, creates and revokes a policy`, async () => {
      const celoBefore = await chain.getBalance({ address: receiverAccount.address });
      if (celoBefore !== 0n) {
        gasInToken = `skipped: the receiver holds ${formatEther(celoBefore)} CELO`;
        console.log(`  ${gasInToken}, so its gas wouldn't be paid in ${SYM}`);
        return;
      }
      const tokensBefore = await tokensOf(receiverAccount.address);
      const hashes: Hex[] = [];
      // A failure here is the answer this stage exists for, so it is a failed
      // check with the SDK's own words, and the run carries on.
      try {
        const pol = await receiver.policies.create({ agent: agentAccount.address, token: TOKEN.symbol, perPayment: "0.01", perDay: "0.01", days: 1, budget: "0.01" });
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
      // Each one mined, succeeded, and named the token's fee currency: the evidence
      // the gas went through fee abstraction rather than CELO.
      for (const h of hashes) {
        txs.push(link(h));
        const [tx, r] = await Promise.all([chain.getTransaction({ hash: h }), chain.getTransactionReceipt({ hash: h })]);
        const fc = (tx as { feeCurrency?: string | null }).feeCurrency ?? null;
        check(
          r.status === "success" && fc?.toLowerCase() === TOKEN.feeCurrency?.toLowerCase(),
          `${link(h)}: ${r.status}, gas paid through ${fc ?? "CELO"} (${r.gasUsed} gas)`,
        );
      }
      // Read at the last transaction's block or later: a node a block behind
      // would show less gas spent than was.
      // A node that hasn't reached that block answers "block is out of range",
      // so the pinned read is retried until one has.
      const lastBlock = hashes.length ? (await chain.waitForTransactionReceipt({ hash: hashes[hashes.length - 1] })).blockNumber : 0n;
      const pinned = async () => {
        for (let i = 0; ; i++) {
          try {
            return await chain.readContract({ address: TOKEN.address, abi: erc20Abi, functionName: "balanceOf", args: [receiverAccount.address], blockNumber: lastBlock > 0n ? lastBlock : undefined });
          } catch (e) {
            if (i >= 15) throw e;
            await new Promise((r) => setTimeout(r, 2_000));
          }
        }
      };
      const [celoAfter, tokensAfter] = await Promise.all([chain.getBalance({ address: receiverAccount.address }), pinned()]);
      check(celoAfter === 0n, `the receiver still holds no CELO (${formatEther(celoAfter)})`);
      // Approving, creating and revoking move no tokens, so the whole drop is gas.
      const spent = tokensBefore - tokensAfter;
      const ok = check(hashes.length > 0 && spent > 0n && spent < 100_000n, `gas paid in ${SYM}: ${formatAmount(spent, TOKEN)} for ${hashes.length} transaction(s)`);
      gasInToken = ok && receiverPolicy == null && hashes.length === 3
        ? `${formatAmount(spent, TOKEN)} for 3 transactions, no CELO`
        : `incomplete: ${hashes.length} of 3 transactions went out, ${formatAmount(spent, TOKEN)} spent`;
    });

    const paid = await stage("6. a policy for the agent, and its payment retried once", async () => {
      const pol = await payer.policies.create({ agent: agentAccount.address, token: TOKEN.symbol, perPayment: "0.05", perDay: "0.10", days: 1, budget: "0.10" });
      policyId = pol.id;
      txs.push(link(pol.approveHash), link(pol.hash));
      console.log(`  policy #${pol.id}`);
      if (agentTopUp > 0n) {
        const gasTx = await wallet.sendTransaction({ to: agentAccount.address, value: agentTopUp, data: ATTRIBUTION });
        const gasReceipt = await chain.waitForTransactionReceipt({ hash: gasTx });
        txs.push(link(gasTx));
        check(gasReceipt.status === "success", `${formatEther(agentTopUp)} CELO to the agent for gas`);
      } else {
        console.log(`  the agent already holds ${formatEther(agentCelo)} CELO for its gas, so none is sent`);
      }

      // The policy named outright: step 5 may have left the receiver's own policy
      // for this agent live, and paying its owner from it is refused.
      const key = `e2e-${new Date().toISOString()}`;
      // Counted, not read off balances: stage 5 just spent the receiver's tokens on
      // gas, and a balance read straight after a transaction can come from a
      // node a block behind. The derived agent is reused across runs, so its
      // nonce is compared with what it was, and the policy is this run's own.
      const nonceBefore = await chain.getTransactionCount({ address: agentAccount.address });
      const fromBlock = (await chain.getBlockNumber()) - 100n;
      const paidEvents = async () =>
        (await chain.getLogs({ address: ALLOWANCE, event: PAID, args: { id: pol.id, to: receiverAccount.address }, fromBlock, toBlock: "latest" }))
          .filter((l) => l.args.amount === policyPayment).length;
      const first = await agent.pay({ to: receiverAccount.address, amount: "0.02", token: TOKEN.symbol, policyId: pol.id, idempotencyKey: key, memo: "sdk e2e" });
      txs.push(link(first.hash));
      check(first.status === "confirmed", `the agent paid 0.02 ${SYM}: ${first.hash}`);
      check(await settles(paidEvents, (n) => n === 1), `0.02 ${SYM} arrived: one Paid event for this policy`);
      const again = await agent.pay({ to: receiverAccount.address, amount: "0.02", token: TOKEN.symbol, policyId: pol.id, idempotencyKey: key, memo: "sdk e2e" });
      check(again.repeat === true && again.hash === first.hash, "the same key again: the first payment's hash, nothing new sent");
      await new Promise((r) => setTimeout(r, 6_000));
      check(
        await settles(() => chain.getTransactionCount({ address: agentAccount.address }), (n) => n === nonceBefore + 1) && (await paidEvents()) === 1,
        "after the retry: the agent sent one transaction in all, and there is still one payment",
      );
      return first;
    });

    await stage("7. the policy payment's webhook", async () => {
      const m = await waitForDelivery((d) => d.type === "payment.received" && d.data.txHash.toLowerCase() === paid.hash.toLowerCase(), 5 * 60_000);
      check(m.data.policy === String(policyId) && m.data.amount === policyPayment.toString() && m.data.memoText === "sdk e2e", `webhook payment.received for policy ${m.data.policy}: ${formatAmount(m.data.amount, TOKEN)}, memo "${m.data.memoText}"`);
    });
  }

  const oneOff = await stage("8. a one-off request paid from the payer's own wallet (remittances.send)", async () => {
    const request = await receiver.requests.create({ payer: payerAccount.address, amount: "1", token: TOKEN.symbol, from: "remesso-sdk e2e", note: "wallet-funded remittance" });
    console.log(`  request ${request.id}, one payment`);
    const input = { funding: "wallet" as const, to: receiverAccount.address, amount: "1", token: TOKEN.symbol, requestId: request.id, idempotencyKey: `e2e-wallet-${new Date().toISOString()}` };
    const nonceBefore = await chain.getTransactionCount({ address: payerAccount.address });
    const answersBefore = answerCalls;
    // Pending may still be paid, and the documented move is the same call
    // again: it continues the same payment from the journal, never a second.
    let sent = await payer.remittances.send(input);
    for (let i = 0; i < 6 && sent.status === "pending"; i++) {
      console.log(`  pending at ${sent.stage}${sent.cancellationHash ? `, cancellation ${sent.cancellationHash}` : ""}; the same call again`);
      sent = await payer.remittances.send(input);
    }
    for (const h of [sent.createHash, sent.approvalHash, sent.executionHash, sent.cancellationHash]) if (h) txs.push(link(h));
    if (sent.status !== "confirmed" || !sent.hash || sent.scheduleId == null || !sent.createHash) {
      throw new Error(`the wallet payment is still ${sent.status} at ${sent.stage}${sent.scheduleId != null ? ` (schedule #${sent.scheduleId})` : ""}`);
    }
    const hash = sent.hash;
    const id = sent.scheduleId;
    check(sent.amount === 1_000_000n && sent.amountIn === grossFor(1_000_000n, sent.feeBps), `schedule #${id} sent ${formatAmount(sent.amountIn, TOKEN)}, so 1 ${SYM} arrives (${sent.feeBps}bps on top)`);
    check(hash.toLowerCase() === sent.executionHash?.toLowerCase(), "the payer's own runNow paid it, not the executor's fallback an hour later");
    check(sent.request?.bound === true, `the request named schedule #${id} before the money moved (${answerCalls - answersBefore} answer call(s))`);
    check(same(await codesOf(sent.createHash), [...OURS, BUILDER_CODE]) && same(await codesOf(hash), [...OURS, BUILDER_CODE]), `its createSchedule and runNow carry ${[...OURS, BUILDER_CODE].join(", ")} (verifyTx)`);
    // Read until it shows the run: a node a block behind still has it unrun.
    const ran = await settles(() => payer.schedules.get(id), (s) => s.runsExecuted === 1);
    const s = await payer.schedules.get(id);
    check(ran && s.maxRuns === 1 && s.sender.toLowerCase() === payerAccount.address.toLowerCase() && s.to.toLowerCase() === receiverAccount.address.toLowerCase(), `schedule #${id}: one run of one, payer to receiver, so nothing more can be taken from it`);
    // What moved in the run's own block, whatever a lagging node says about now.
    const block = (await chain.waitForTransactionReceipt({ hash })).blockNumber;
    const [toBefore, toAfter, fromBefore, fromAfter] = await Promise.all([
      tokensAt(receiverAccount.address, block - 1n), tokensAt(receiverAccount.address, block),
      tokensAt(payerAccount.address, block - 1n), tokensAt(payerAccount.address, block),
    ]);
    check(toAfter - toBefore === 1_000_000n && fromBefore - fromAfter === sent.amountIn, `in block ${block}: the receiver got exactly 1 ${SYM} and the payer paid ${formatAmount(sent.amountIn, TOKEN)}`);
    const again = await payer.remittances.send(input);
    check(again.repeat === true && again.hash === hash && again.scheduleId === id, "the same key again: the same payment and schedule, nothing new");
    await new Promise((r) => setTimeout(r, 6_000));
    const writes = sent.approvalHash ? 3 : 2;
    check(
      await settles(() => chain.getTransactionCount({ address: payerAccount.address }), (n) => n === nonceBefore + writes),
      `after the retry: the payer sent ${writes} transactions in all (the schedule, ${sent.approvalHash ? "the approval, " : ""}the run)`,
    );
    const proof = await receiver.receipts.verify({ txHash: hash, from: payerAccount.address, to: receiverAccount.address, token: TOKEN.symbol, amount: "1", scheduleId: id, finality: "included" });
    check(proof.kind === "run" && proof.amount === 1_000_000n && proof.scheduleId === id, `the receiver verifies it from the chain alone: schedule #${id}, ${formatAmount(proof.amount, TOKEN)}`);
    return { requestId: request.id, hash, id };
  });

  await stage("9. its webhook, and the one-off request paid", async () => {
    const m = await waitForDelivery((d) => d.type === "payment.received" && d.data.txHash.toLowerCase() === oneOff.hash.toLowerCase(), 5 * 60_000);
    check(m.data.schedule === oneOff.id.toString() && m.data.amount === "1000000", `webhook payment.received for schedule ${m.data.schedule}: ${formatAmount(m.data.amount, TOKEN)}, signature verified`);
    const status = await receiver.requests.waitUntilPaid(oneOff.requestId, { timeoutMs: 2 * 60_000, intervalMs: 5_000 });
    check(status.payment?.state === "paid" && status.payment.txs.some((t) => t.txHash.toLowerCase() === oneOff.hash.toLowerCase()), `the request's payment reads ${status.payment?.state}, with that transaction`);
    const event = (await receiver.events.list({ role: "to", kinds: ["run"], limit: 500 })).events.find((e) => e.refId === oneOff.id.toString());
    check(event?.early === true && event.from === payerAccount.address.toLowerCase(), `its payment event: ${event ? `early ${event.early}, from ${event.from}` : "not found"}`);
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
    // expires within a day, allows 0.01 a day, and only the derived
    // agent can spend it.
    console.log(`  the receiver's policy #${receiverPolicy} is still live: it expires within a day, 0.01 ${SYM} a day, spendable only by the derived agent`);
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
console.log(`\ngas in ${SYM}: ${gasInToken}`);
console.log("\ntransactions");
for (const t of txs) console.log(`  ${t}`);
console.log(`\nthe receiver ${receiverAccount.address} and the agent ${agentAccount.address} keep what they were sent; derive them again from the test key to recover it.`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
