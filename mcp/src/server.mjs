// Remesso agent wallet — the MCP server the Claude plugin ships, also
// published to npm as `remesso-wallet` for Codex, Cursor and any other MCP host.
//
// The agent gets an address of its own. It can spend from its human's wallet
// only through a RemessoAgentAllowance policy the human created: one token, a
// cap per payment, a cap per day, an expiry, optionally an allowlist. Those
// caps live in the contract, so a prompt-injected agent hits the same wall as
// an honest one.
//
// The agent key never reaches the model. It is generated here, stored in a
// 0600 file under ~/.remesso-agent, and no tool returns it.

import { McpServer, z } from "./mcp.mjs";
import { createClient, http, parseAbi, getAddress, isAddress, formatUnits, parseUnits } from "viem";
import { readContract, getBalance, simulateContract, writeContract, waitForTransactionReceipt } from "viem/actions";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { celo } from "viem/chains";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RPC = process.env.REMESSO_RPC_URL || "https://forno.celo.org";
const FUNCTIONS = "https://engaboljiqudghvzmebq.supabase.co/functions/v1";
const APP = "https://remesso.xyz";
// RemessoAgentAllowance on Celo mainnet, deployed 2026-10-19 (verified, ownerless).
// The env override exists for tests against a fork.
const ALLOWANCE = process.env.REMESSO_ALLOWANCE_ADDRESS || "0xA6351fAeEb097698289586C4D6188530300DB209";
const ERC8004 = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const HOME = process.env.REMESSO_AGENT_HOME || join(homedir(), ".remesso-agent");

// Dollar stablecoins only: all 6dp, all with a Celo fee-currency adapter so the
// agent can pay gas in the token it holds instead of needing CELO.
const TOKENS = {
  USDT: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6, feeCurrency: "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72", label: "USD₮" },
  USDC: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, feeCurrency: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B", label: "USDC" },
  USAT: { address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", decimals: 6, feeCurrency: "0x0357EE22278c922e1D36cFe6b899269b161880C4", label: "USA₮" },
};
const tokenKey = (s) => String(s || "").toUpperCase().replace("₮", "T").replace("USD T", "USDT");
const tokenByAddress = (a) => Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === String(a).toLowerCase());

// ERC-8021 Schema 0 suffix carrying `remesso` and the Agents on Open Rails code,
// the same bytes the backend and the web app append (attribution.test.ts pins
// them to @celo/attribution-tags). The EVM ignores trailing calldata.
const ATTRIBUTION = "0x72656d6573736f2c63656c6f5f356364333563613535626166190080218021802180218021802180218021";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const AA = parseAbi([
  "struct Policy { address owner; address agent; address token; uint64 expiresAt; bool allowlistOnly; bool revoked; uint128 perPayment; uint128 perDay; uint128 spentInWindow; uint64 windowStart; }",
  "function policy(uint256) view returns (Policy)",
  "function remainingToday(uint256) view returns (uint256)",
  "function allowed(uint256,address) view returns (bool)",
  "function nextPolicyId() view returns (uint256)",
  "function pay(uint256 id, address to, uint256 amount, bytes32 memo)",
  // The contract's errors, so a refused simulation names its reason instead of
  // "execution reverted".
  "error NotAgent()",
  "error Revoked()",
  "error Expired()",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error SelfPayment()",
  "error OverPerPayment()",
  "error OverPerDay()",
  "error RecipientNotAllowed()",
  "error SafeERC20FailedOperation(address token)",
]);
const REGISTRY = parseAbi(["function getAgentWallet(uint256) view returns (address)"]);

// ---- local state: the key and which policies this agent spends under ----

function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
}
function loadKey() {
  ensureHome();
  const f = join(HOME, "agent-key.json");
  if (!existsSync(f)) {
    writeFileSync(f, JSON.stringify({ privateKey: generatePrivateKey(), createdAt: new Date().toISOString() }), { mode: 0o600 });
  }
  chmodSync(f, 0o600);
  return JSON.parse(readFileSync(f, "utf8")).privateKey;
}
const cfgFile = () => join(HOME, "config.json");
function loadConfig() {
  ensureHome();
  try { return JSON.parse(readFileSync(cfgFile(), "utf8")); } catch { return { policies: [] }; }
}
function saveConfig(c) {
  writeFileSync(cfgFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

const account = privateKeyToAccount(loadKey());
// A bare client plus the five actions used, rather than createPublicClient and
// createWalletClient, which attach every action viem has and roughly double
// the bundle the plugin ships.
const client = createClient({ chain: celo, transport: http(RPC), account });
const pub = {
  readContract: (a) => readContract(client, a),
  getBalance: (a) => getBalance(client, a),
  simulateContract: (a) => simulateContract(client, a),
  waitForTransactionReceipt: (a) => waitForTransactionReceipt(client, a),
};
const wallet = { writeContract: (a) => writeContract(client, a) };

// ---- helpers ----

const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });
const fmt = (units, t) => `${formatUnits(units, t.decimals)} ${t.label}`;

function needAllowance() {
  if (!ALLOWANCE) return "RemessoAgentAllowance is not deployed yet (REMESSO_ALLOWANCE_ADDRESS is unset), so this agent cannot spend. It can still receive and ask to be paid.";
  return null;
}

async function readPolicy(id) {
  const [p, remaining] = await Promise.all([
    pub.readContract({ address: ALLOWANCE, abi: AA, functionName: "policy", args: [BigInt(id)] }),
    pub.readContract({ address: ALLOWANCE, abi: AA, functionName: "remainingToday", args: [BigInt(id)] }),
  ]);
  return { ...p, remaining };
}

async function describePolicy(id) {
  const p = await readPolicy(id);
  const entry = tokenByAddress(p.token);
  const t = entry ? entry[1] : { decimals: 6, label: p.token };
  const [bal, allow] = await Promise.all([
    pub.readContract({ address: p.token, abi: ERC20, functionName: "balanceOf", args: [p.owner] }),
    pub.readContract({ address: p.token, abi: ERC20, functionName: "allowance", args: [p.owner, ALLOWANCE] }),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const active = !p.revoked && now < p.expiresAt && p.agent.toLowerCase() === account.address.toLowerCase();
  let spendable = p.remaining;
  if (p.perPayment < spendable) spendable = p.perPayment;
  if (bal < spendable) spendable = bal;
  if (allow < spendable) spendable = allow;
  return {
    policyId: Number(id),
    token: entry ? entry[0] : p.token,
    active,
    revoked: p.revoked,
    expires: new Date(Number(p.expiresAt) * 1000).toISOString(),
    perPayment: fmt(p.perPayment, t),
    perDay: fmt(p.perDay, t),
    remainingToday: fmt(p.remaining, t),
    recipients: p.allowlistOnly ? "allowlist only" : "any address",
    ownerBalance: fmt(bal, t),
    ownerAllowance: fmt(allow, t),
    largestPaymentNow: active ? fmt(spendable, t) : fmt(0n, t),
    _raw: { p, spendable, active, t },
  };
}
const strip = ({ _raw, ...rest }) => rest;

// Policies are found, not typed in. The contract records the agent each policy
// names, so the wallet reads every id it has not seen yet and keeps the ones
// naming it; the human never has to relay a number. Ids are read one by one
// rather than PolicyCreated searched because forno answers getLogs over at
// most 5,000 blocks (~83 minutes), the same reason the setup page reads by id.
// A policy's agent never changes, so an id read once is never read again, and
// a call reads at most SCAN_LIMIT new ids so a busy contract cannot stall it.
const SCAN_LIMIT = 500;
async function discoverPolicies() {
  const cfg = loadConfig();
  const next = Number(await pub.readContract({ address: ALLOWANCE, abi: AA, functionName: "nextPolicyId" }));
  const start = (cfg.scannedTo ?? 0) + 1;
  const end = Math.min(next - 1, start + SCAN_LIMIT - 1);
  const found = [];
  for (let i = start; i <= end; i += 25) {
    const ids = Array.from({ length: Math.min(25, end - i + 1) }, (_, k) => i + k);
    const ps = await Promise.all(ids.map((id) => pub.readContract({ address: ALLOWANCE, abi: AA, functionName: "policy", args: [BigInt(id)] })));
    ps.forEach((p, k) => { if (p.agent.toLowerCase() === account.address.toLowerCase()) found.push(ids[k]); });
  }
  if (end >= start) {
    cfg.policies = [...new Set([...(cfg.policies ?? []), ...found])];
    cfg.scannedTo = end;
    saveConfig(cfg);
  }
  return found;
}

async function policyFor(symbol) {
  const want = TOKENS[tokenKey(symbol)];
  if (!want) throw new Error(`token must be one of ${Object.keys(TOKENS).join(", ")}`);
  await discoverPolicies();
  for (const id of loadConfig().policies) {
    const d = await describePolicy(id);
    if (d._raw.active && d._raw.p.token.toLowerCase() === want.address.toLowerCase()) return d;
  }
  throw new Error(`no active policy for ${want.label}. Run the "wallet" tool: it gives the setup link for your human and says what is missing.`);
}

// Why a payment through this policy would be refused, in words a person can
// act on. Errors the contract does not name (a token's own revert) fall
// through to viem's short message.
function refusal(e) {
  const name = e?.cause?.data?.errorName ?? e?.data?.errorName ?? e?.cause?.cause?.data?.errorName;
  return ({
    NotAgent: "the policy names a different agent",
    Revoked: "the human revoked this policy",
    Expired: "the policy has expired",
    OverPerPayment: "the amount is over the per-payment cap",
    OverPerDay: "today's cap is used up; it resets 24 hours after the day's first payment",
    RecipientNotAllowed: "the recipient is not on the policy's allowlist",
    SelfPayment: "a policy cannot pay its own owner",
    SafeERC20FailedOperation: "the token refused the transfer: the human's balance or approval is too low",
  })[name] ?? String(e?.shortMessage || e?.message || e);
}

const DAY = 86_400;
const short = (d) => `${d.perPayment} per payment, ${d.perDay} a day, until ${d.expires.slice(0, 10)}`;

// One answer to "can this agent pay right now, and if not, what is the next
// thing to do?" Every line is read from the chain, and the last one simulates
// a payment of one unit without sending it, which exercises the policy, the
// approval and the human's balance together.
async function readiness() {
  await discoverPolicies();
  const cfg = loadConfig();
  const all = [];
  for (const id of cfg.policies) all.push(await describePolicy(id));
  // Prefer a live policy that can move something now.
  const live = all.filter((d) => d._raw.active).sort((a, b) => (b._raw.spendable > a._raw.spendable ? 1 : -1));
  const d = live[0];
  const checks = [];
  const warnings = [];
  const add =(ok, step, detail, next) => checks.push({ ok, step, detail, ...(ok ? {} : { next }) });
  const setupLink = `${APP}/agent-wallet?agent=${account.address}`;

  add(true, "Agent key", `${account.address}, on this machine only`);
  if (!d) {
    const dead = all.map((x) => `#${x.policyId} ${x.revoked ? "revoked" : "expired"}`).join(", ");
    add(false, "Spending policy", dead ? `no live policy (${dead})` : "none yet",
      `Give your human the setup link; they set the limits in their own wallet. Then call await_setup.`);
  } else {
    add(true, "Spending policy", `#${d.policyId}: ${short(d)}, ${d.recipients}`);
    const { p, t } = d._raw;
    const owner = await Promise.all([
      pub.readContract({ address: p.token, abi: ERC20, functionName: "balanceOf", args: [p.owner] }),
      pub.readContract({ address: p.token, abi: ERC20, functionName: "allowance", args: [p.owner, ALLOWANCE] }),
    ]);
    const canMove = owner[0] < owner[1] ? owner[0] : owner[1];
    add(canMove > 0n, "Human's funds", `${fmt(owner[0], t)} in their wallet, ${fmt(owner[1], t)} approved`,
      owner[1] === 0n ? "The approval is used up or was removed: your human approves more on the setup page."
        : `Your human's wallet holds no ${t.label}: they add some.`);
    const left = Number(p.expiresAt) - Math.floor(Date.now() / 1000);
    if (left < 3 * DAY) warnings.push(`The policy ends ${d.expires}; your human can create a new one on the setup page before then.`);
  }

  const celoBal = await pub.getBalance({ address: account.address });
  const sym = d ? d.token : "USDT";
  const t = TOKENS[sym] ?? TOKENS.USDT;
  const tokBal = await pub.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  const gas = celoBal > parseUnits("0.002", 18) ? `${formatUnits(celoBal, 18)} CELO`
    : tokBal >= 10_000n ? `paid in ${t.label} (${fmt(tokBal, t)} held)` : null;
  add(Boolean(gas), "Network fees", gas ?? "the agent holds no CELO and almost no tokens",
    `Send the agent (${account.address}) 0.10 ${t.label}, or 0.05 CELO. It pays fees in either.`);

  if (d) {
    try {
      await pub.simulateContract({ address: ALLOWANCE, abi: AA, functionName: "pay",
        args: [BigInt(d.policyId), account.address, 1n, `0x${"0".repeat(64)}`], account });
      add(true, "Test payment", "a 1-unit payment simulates cleanly (nothing was sent)");
    } catch (e) {
      const why = refusal(e);
      // The simulation pays the agent itself; an allowlist that leaves the agent
      // out refuses that, which says nothing about real recipients.
      const allowlistOnly = e?.cause?.data?.errorName === "RecipientNotAllowed";
      add(allowlistOnly, "Test payment", allowlistOnly ? "simulates up to the allowlist, which is working as set" : `refused: ${why}`,
        `Refused: ${why}.`);
    }
  }

  const failing = checks.find((c) => !c.ok);
  return {
    ready: !failing,
    checklist: checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.step}: ${c.detail}`),
    next: failing ? failing.next : "Ready. Ask what to pay, or run limits to see what is left today.",
    ...(warnings.length ? { warnings } : {}),
    ...(d ? {} : { setupLink }),
    _policies: all.map(strip),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gas: CELO if the agent has any, else the token itself through Celo's fee
// abstraction. The agent may hold nothing at first; then the human sends it a
// little CELO, or the first x402 top-up leaves it a few cents of token.
async function gasOptions(tokenSym) {
  const celoBal = await pub.getBalance({ address: account.address });
  if (celoBal > parseUnits("0.002", 18)) return {};
  const t = TOKENS[tokenKey(tokenSym)];
  const bal = await pub.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  if (bal >= 10_000n) return { feeCurrency: t.feeCurrency }; // >= 0.01
  throw new Error(`the agent wallet ${account.address} has no gas: send it about 0.05 CELO, or 0.10 ${t.label}.`);
}

async function payThroughPolicy(d, to, units, memo) {
  const memo32 = memo ? `0x${Buffer.from(memo.slice(0, 32)).toString("hex").padEnd(64, "0")}` : `0x${"0".repeat(64)}`;
  const gas = await gasOptions(d.token);
  const { request } = await pub.simulateContract({
    address: ALLOWANCE, abi: AA, functionName: "pay", args: [BigInt(d.policyId), to, units, memo32],
    account, dataSuffix: ATTRIBUTION, ...gas,
  });
  const hash = await wallet.writeContract({ ...request, dataSuffix: ATTRIBUTION, ...gas });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return hash;
}

// ---- the server ----

// The brand mark, for MCP hosts that show a server's icon (MCP 2025-11-25).
const server = new McpServer({
  name: "remesso-wallet",
  version: "0.3.1",
  icons: [{ src: `${APP}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }],
});

server.tool(
  "wallet",
  "Start here. This agent's Celo address, what it holds, and a readiness checklist read from the chain: spending policy, the human's funds, network fees, and a simulated test payment, with the one next step if anything is missing. Policies naming this agent are found and linked automatically.",
  {},
  async () => {
    const celoBal = await pub.getBalance({ address: account.address });
    const held = {};
    for (const [k, t] of Object.entries(TOKENS)) {
      held[k] = fmt(await pub.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [account.address] }), t);
    }
    const out = {
      address: account.address,
      network: "Celo mainnet (42220)",
      holds: { CELO: formatUnits(celoBal, 18), ...held },
    };
    const missing = needAllowance();
    if (missing) return ok({ ...out, note: missing });
    try {
      const { _policies, ...r } = await readiness();
      return ok({ ...out, ...r, policies: _policies });
    } catch (e) {
      return fail(`could not read the chain: ${String(e?.shortMessage || e?.message || e)}`);
    }
  },
);

server.tool(
  "await_setup",
  "Wait while the human sets up this agent's spending policy from the setup link, then report readiness. Call it right after giving them the link. It returns as soon as a policy naming this agent is live on-chain, or after timeout_seconds; if it times out, ask whether they are done and call it again.",
  { timeout_seconds: z.number().int().positive().default(55).describe("how long to wait; keep under the host's tool timeout (Codex: 60s)") },
  async ({ timeout_seconds }) => {
    const missing = needAllowance();
    if (missing) return fail(missing);
    const started = Date.now();
    const deadline = started + Math.min(timeout_seconds, 600) * 1000;
    for (;;) {
      try {
        await discoverPolicies();
        for (const id of loadConfig().policies) {
          if ((await describePolicy(id))._raw.active) {
            const { _policies, ...r } = await readiness();
            return ok({ found: true, waitedSeconds: Math.round((Date.now() - started) / 1000), ...r });
          }
        }
      } catch {
        // A failed read while waiting is a reason to try again, not to stop.
      }
      if (Date.now() + 5000 > deadline) break;
      await sleep(5000);
    }
    return ok({
      found: false,
      waitedSeconds: Math.round((Date.now() - started) / 1000),
      setupLink: `${APP}/agent-wallet?agent=${account.address}`,
      next: "No policy yet. Ask your human whether they finished both wallet steps, then call await_setup again.",
    });
  },
);

server.tool(
  "link_policy",
  "Link a RemessoAgentAllowance policy by id. Rarely needed: wallet, limits and await_setup find and link every policy naming this agent on their own. Verified on-chain: refused unless the policy names this agent's address.",
  { policy_id: z.number().int().positive() },
  async ({ policy_id }) => {
    const missing = needAllowance();
    if (missing) return fail(missing);
    const d = await describePolicy(policy_id);
    if (d._raw.p.agent.toLowerCase() !== account.address.toLowerCase()) {
      return fail(`policy ${policy_id} is for agent ${d._raw.p.agent}, not this agent (${account.address}).`);
    }
    const cfg = loadConfig();
    if (!cfg.policies.includes(policy_id)) cfg.policies.push(policy_id);
    saveConfig(cfg);
    return ok({ linked: policy_id, ...strip(d) });
  },
);

server.tool(
  "limits",
  "What this agent may still spend right now, per policy: caps, today's remainder, expiry, and the owner's balance and allowance. Read from the chain.",
  {},
  async () => {
    const missing = needAllowance();
    if (missing) return fail(missing);
    await discoverPolicies();
    const list = [];
    for (const id of loadConfig().policies) list.push(strip(await describePolicy(id)));
    return ok(list.length ? list : "no policy names this agent yet: run the wallet tool for the setup link");
  },
);

server.tool(
  "pay",
  "Send stablecoins from the human's wallet to an address, within the on-chain policy. The contract refuses anything over the per-payment or daily cap, after expiry, after revocation, or (if set) to an address not on the allowlist.",
  {
    to: z.string().describe("recipient 0x address"),
    amount: z.string().describe('decimal, e.g. "2.50"'),
    token: z.enum(["USDT", "USDC", "USAT"]).default("USDT"),
    memo: z.string().max(32).optional().describe("up to 32 chars, recorded on-chain in the Paid event"),
  },
  async ({ to, amount, token, memo }) => {
    const missing = needAllowance();
    if (missing) return fail(missing);
    if (!isAddress(to, { strict: false })) return fail(`not an address: ${to}`);
    try {
      const d = await policyFor(token);
      const t = TOKENS[token];
      const units = parseUnits(amount, t.decimals);
      if (units > d._raw.spendable) return fail(`${amount} ${t.label} is over what this policy allows right now (${d.largestPaymentNow}). Nothing sent.`);
      const hash = await payThroughPolicy(d, getAddress(to), units, memo);
      return ok({ sent: `${amount} ${t.label}`, to: getAddress(to), policyId: d.policyId, tx: hash, explorer: `https://celoscan.io/tx/${hash}` });
    } catch (e) {
      return fail(`Nothing sent: ${refusal(e)}`);
    }
  },
);

server.tool(
  "pay_x402",
  "Pay for an HTTP resource that answers 402 Payment Required (x402 v1 or v2, exact scheme, Celo). The price must be at or under max_amount. If the agent's own balance is short, it first tops itself up from the human's wallet through the policy, so every cent still passes the on-chain caps.",
  {
    url: z.string().url(),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.string().optional().describe("JSON body for POST"),
    max_amount: z.string().describe('the most you will pay, decimal, e.g. "0.05"'),
    token: z.enum(["USDT", "USDC", "USAT"]).default("USAT"),
  },
  async ({ url, method, body, max_amount, token }) => {
    const t = TOKENS[token];
    const maxUnits = parseUnits(max_amount, t.decimals);
    const init = { method, headers: { "content-type": "application/json" }, body: method === "POST" ? (body ?? "{}") : undefined };
    try {
      // 1. Read the price without paying.
      const probe = await fetch(url, init);
      if (probe.status !== 402) return ok({ status: probe.status, note: "no payment was asked for", body: await probe.text() });
      const hdr = probe.headers.get("PAYMENT-REQUIRED");
      const reqs = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : await probe.json();
      const accepts = reqs.accepts ?? [];
      const pick = accepts.find((a) => String(a.asset).toLowerCase() === t.address.toLowerCase() && String(a.network).match(/42220|celo/));
      if (!pick) return fail(`the seller does not take ${t.label} on Celo; it offers ${accepts.map((a) => `${a.asset} on ${a.network}`).join(", ")}`);
      const price = BigInt(pick.amount ?? pick.maxAmountRequired);
      if (price > maxUnits) return fail(`price ${fmt(price, t)} is above max_amount ${max_amount}. Nothing signed.`);

      // 2. Top up the agent's own float through the policy if it is short.
      const float = await pub.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [account.address] });
      let topUp = null;
      if (float < price) {
        const missing = needAllowance();
        if (missing) return fail(`the agent holds ${fmt(float, t)}, the price is ${fmt(price, t)}, and ${missing}`);
        const d = await policyFor(token);
        // Take a little more than the price so the agent can also pay gas in the token.
        let want = price - float + 20_000n;
        if (want > d._raw.spendable) want = price - float;
        if (want > d._raw.spendable) return fail(`needs ${fmt(price - float, t)} from the policy; it allows ${d.largestPaymentNow} right now.`);
        topUp = await payThroughPolicy(d, account.address, want, "x402 top-up");
      }

      // 3. Pay with the official client, held to the same asset and price.
      const select = (_v, list) => {
        const p = list.find((a) => String(a.asset).toLowerCase() === t.address.toLowerCase());
        if (!p || BigInt(p.amount ?? p.maxAmountRequired) > maxUnits) throw new Error("price changed above max_amount; nothing signed");
        return p;
      };
      const client = new x402Client(select);
      registerExactEvmScheme(client, { signer: account, paymentRequirementsSelector: select });
      const res = await wrapFetchWithPayment(fetch, client)(url, init);
      const receipt = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
      return ok({
        status: res.status,
        paid: fmt(price, t),
        topUpTx: topUp,
        receipt: receipt ? decodePaymentResponseHeader(receipt) : null,
        body: await res.text(),
      });
    } catch (e) {
      return fail(String(e?.shortMessage || e?.message || e));
    }
  },
);

// The payer sees who is asking on their home screen, so name the app the
// agent runs in, from the clientInfo it sent on initialize.
function hostName() {
  const n = server.client?.name ?? "";
  return /claude/i.test(n) ? "Claude" : /codex/i.test(n) ? "Codex" : /cursor/i.test(n) ? "Cursor" : "AI";
}

server.tool(
  "request_payment",
  "Ask a person or agent to pay this agent on a recurring schedule through Remesso. Free. Returns a link that opens the payer's Remesso form prefilled; only the payer can create the schedule.",
  {
    payer: z.string().describe("the wallet address being asked"),
    amount: z.string().optional(),
    token: z.string().optional().describe("e.g. USDT, USDC, USA₮"),
    every: z.enum(["week", "fortnight", "month", "quarter"]).optional(),
    note: z.string().max(120).optional(),
  },
  async ({ payer, amount, token, every, note }) => {
    if (!isAddress(payer, { strict: false })) return fail(`not an address: ${payer}`);
    const res = await fetch(`${FUNCTIONS}/request-payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payer, to: account.address, amount, token, every, note, from: `${hostName()} agent` }),
    });
    const out = await res.json().catch(() => ({}));
    return res.ok ? ok(out) : fail(`request-payment answered ${res.status}: ${JSON.stringify(out)}`);
  },
);

server.tool(
  "find_agent",
  "Look up another agent's payment address in the ERC-8004 identity registry on Celo by its agent id.",
  { agent_id: z.number().int().nonnegative() },
  async ({ agent_id }) => {
    const w = await pub.readContract({ address: ERC8004, abi: REGISTRY, functionName: "getAgentWallet", args: [BigInt(agent_id)] });
    if (/^0x0{40}$/i.test(w)) return fail(`agent ${agent_id} has no agentWallet set`);
    return ok({ agentId: agent_id, agentWallet: w, registry: ERC8004 });
  },
);

await server.connect();
