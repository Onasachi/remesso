// Remesso agent wallet — the MCP server the Claude plugin ships.
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
const APP = "https://remesso.crackedstudios.xyz";
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
  "function pay(uint256 id, address to, uint256 amount, bytes32 memo)",
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

async function policyFor(symbol) {
  const cfg = loadConfig();
  const want = TOKENS[tokenKey(symbol)];
  if (!want) throw new Error(`token must be one of ${Object.keys(TOKENS).join(", ")}`);
  for (const id of cfg.policies) {
    const d = await describePolicy(id);
    if (d._raw.active && d._raw.p.token.toLowerCase() === want.address.toLowerCase()) return d;
  }
  throw new Error(`no active policy for ${want.label}. Ask your human to create one (run the "wallet" tool for the steps) and then call link_policy.`);
}

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

const server = new McpServer({ name: "remesso-wallet", version: "0.2.2" });

server.tool(
  "wallet",
  "This agent's own Celo address, what it holds, and the policies it may spend under. Start here. If no policy is linked, it returns the steps the human must take in their own wallet.",
  {},
  async () => {
    const cfg = loadConfig();
    const celoBal = await pub.getBalance({ address: account.address });
    const held = {};
    for (const [k, t] of Object.entries(TOKENS)) {
      held[k] = fmt(await pub.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [account.address] }), t);
    }
    const out = {
      address: account.address,
      network: "Celo mainnet (42220)",
      holds: { CELO: formatUnits(celoBal, 18), ...held },
      policies: [],
    };
    const missing = needAllowance();
    if (missing) out.note = missing;
    else {
      for (const id of cfg.policies) out.policies.push(strip(await describePolicy(id)));
      if (!out.policies.length) {
        out.setupLink = `${APP}/agent-wallet?agent=${account.address}`;
        out.setup = [
          `Give your human setupLink. They open it in MiniPay or a browser wallet, set the limits, and tell you the policy number; then call link_policy.`,
          `By hand instead, from THEIR wallet:`,
          `1. approve(${ALLOWANCE}, <amount>) on the token (USD₮ ${TOKENS.USDT.address}, USDC ${TOKENS.USDC.address} or USA₮ ${TOKENS.USAT.address})`,
          `2. createPolicy(agent=${account.address}, token, perPayment, perDay, expiresAt, allowlistOnly, recipients) on ${ALLOWANCE}`,
          `Then call link_policy with the policy id from the PolicyCreated event. They can revoke() at any time.`,
        ];
      }
    }
    return ok(out);
  },
);

server.tool(
  "link_policy",
  "Record a RemessoAgentAllowance policy id the human created for this agent. Verified on-chain: refused unless the policy names this agent's address.",
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
    const cfg = loadConfig();
    const list = [];
    for (const id of cfg.policies) list.push(strip(await describePolicy(id)));
    return ok(list.length ? list : "no policies linked — run the wallet tool for setup steps");
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
      return fail(String(e?.shortMessage || e?.message || e));
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
      body: JSON.stringify({ payer, to: account.address, amount, token, every, note, from: "Claude agent" }),
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
