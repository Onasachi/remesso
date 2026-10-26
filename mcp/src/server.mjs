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
import { createRemesso } from "../../packages/remesso-sdk/src/client.ts";
import { fileStore, fileRemittanceStore } from "../../packages/remesso-sdk/src/node.ts";
import { ALLOWANCE as SDK_ALLOWANCE, token as sdkToken } from "../../packages/remesso-sdk/src/deployment.ts";
import { createAgentTools, redactUrls } from "../../packages/remesso-sdk/src/tools.ts";
import { gasNeeded, PAY_GAS } from "../../packages/remesso-sdk/src/context.ts";
import { RemessoError } from "../../packages/remesso-sdk/src/errors.ts";
import { payeeProfile, uriSource } from "./payee-profile.mjs";
import { safeFetchText } from "./safe-fetch.mjs";
import { createClient, http, parseAbi, getAddress, isAddress, formatUnits, parseUnits } from "viem";
import {
  readContract, getBalance, getGasPrice, simulateContract, getChainId,
} from "viem/actions";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { celo } from "viem/chains";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RPC = process.env.REMESSO_RPC_URL || "https://forno.celo.org";
// The override exists for tests against a local backend, like the two above it.
const FUNCTIONS = process.env.REMESSO_FUNCTIONS_URL || "https://engaboljiqudghvzmebq.supabase.co/functions/v1";
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
const REGISTRY = parseAbi([
  "function getAgentWallet(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
]);

// A payer's decline of a payment request, as request-payment checks it
// (supabase/functions/_shared/request-decline.ts, copied: the bundle can't
// import it). The agent signs under its human's live policy.
const DECLINE_DOMAIN = { name: "Remesso", version: "1", chainId: 42220 };
const DECLINE_TYPES = {
  PaymentRequestAction: [
    { name: "request", type: "string" },
    { name: "action", type: "string" },
    { name: "expiry", type: "uint64" },
  ],
};

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
// One section per chain and allowance contract. Policy ids restart at 1 in
// every deployment, so the next contract must not inherit this one's policy
// list or scan position (`scannedTo`): it would skip its own first policies.
const DEPLOYMENT = `${celo.id}:${ALLOWANCE.toLowerCase()}`;
const MAINNET_ALLOWANCE = "0xa6351faeeb097698289586c4d6188530300db209";
const cfgFile = () => join(HOME, "config.json");
function loadState() {
  ensureHome();
  let s = {};
  try { s = JSON.parse(readFileSync(cfgFile(), "utf8")); } catch { /* first run */ }
  if (s.version === 2) return s;
  // Until 2026-10-25 the file held one deployment's state, and that was always
  // mainnet's allowance contract: the override exists for fork tests.
  const v2 = { version: 2, deployments: {} };
  if (Array.isArray(s.policies)) {
    v2.deployments[`${celo.id}:${MAINNET_ALLOWANCE}`] = { policies: s.policies, ...(s.scannedTo != null ? { scannedTo: s.scannedTo } : {}) };
  }
  writeFileSync(cfgFile(), JSON.stringify(v2, null, 2), { mode: 0o600 });
  return v2;
}
function loadConfig() {
  return loadState().deployments[DEPLOYMENT] ?? { policies: [] };
}
function saveConfig(c) {
  const s = loadState();
  s.deployments[DEPLOYMENT] = c;
  writeFileSync(cfgFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

const account = privateKeyToAccount(loadKey());
// A bare client plus the actions used, rather than createPublicClient and
// createWalletClient, which attach every action viem has and roughly double
// the bundle the plugin ships.
const client = createClient({ chain: celo, transport: http(RPC), account });
const pub = {
  readContract: (a) => readContract(client, a),
  getBalance: (a) => getBalance(client, a),
  getGasPrice: () => getGasPrice(client),
  simulateContract: (a) => simulateContract(client, a),
};

// The RPC can be overridden (REMESSO_RPC_URL), so nothing else guarantees it
// is Celo mainnet. Checked before the first signature: on another chain every
// read before it, the policy, the balances and the simulation, would describe
// money that isn't the human's.
let chainCheck = null;
function assertChain() {
  chainCheck ??= getChainId(client).then((id) => {
    if (id !== celo.id) throw new Error(`the RPC ${RPC} is chain ${id}, not Celo mainnet (${celo.id}), so this wallet won't sign`);
  }).catch((e) => {
    chainCheck = null; // ask again next time: the RPC may have been down, or fixed
    throw e;
  });
  return chainCheck;
}

// ---- helpers ----

const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
// An RPC's key can sit in its URL's path, and viem quotes the URL in errors.
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: redactUrls(String(msg)) }] });
const fmt = (units, t) => `${formatUnits(units, t.decimals)} ${t.label}`;

function needAllowance() {
  if (!ALLOWANCE) return "RemessoAgentAllowance is not deployed yet (REMESSO_ALLOWANCE_ADDRESS is unset), so this agent cannot spend. It can still receive and ask to be paid.";
  return null;
}
/// Payments go through the SDK, which signs only against the canonical
/// contract. Reading a policy on another one still works.
function needSpending() {
  const missing = needAllowance();
  if (missing) return missing;
  if (ALLOWANCE.toLowerCase() !== SDK_ALLOWANCE.toLowerCase()) return `SDK spending requires the canonical allowance contract ${SDK_ALLOWANCE}; REMESSO_ALLOWANCE_ADDRESS=${ALLOWANCE} is unsupported. No transaction was signed.`;
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

  const [celoBal, gasPrice] = await Promise.all([pub.getBalance({ address: account.address }), pub.getGasPrice()]);
  const sym = d ? d.token : "USDT";
  const t = TOKENS[sym] ?? TOKENS.USDT;
  const tokBal = await pub.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  // The same bar pay uses, so "Ready" is never followed by "no gas".
  const perPayment = gasNeeded(PAY_GAS, gasPrice, "payment");
  const gas = celoBal >= perPayment ? `${formatUnits(celoBal, 18)} CELO, about ${celoBal / (perPayment > 0n ? perPayment : 1n)} payments at today's gas price`
    : tokBal >= 10_000n ? `paid in ${t.label} (${fmt(tokBal, t)} held)` : null;
  add(Boolean(gas), "Network fees", gas ?? `the agent holds ${formatUnits(celoBal, 18)} CELO, under the ${formatUnits(perPayment, 18)} a payment needs, and almost no ${t.label}`,
    `Send the agent (${account.address}) 0.10 CELO, or 0.10 ${t.label}. It pays fees in either.`);

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

// ---- payments: the SDK owns signing, persistence and reconciliation ----
// The original MCP journal remains untouched. Adapt its symbols/number IDs
// as SDK records. Adopt a signer scope only after immutable policy.agent proof.
const WAIT_MS = 45_000;
const legacyPayFile = () => join(HOME, "payments.json");
const sdkStore = fileStore(join(HOME, "sdk-payments.json"));
function legacyPayments() {
  let data;
  try { data = JSON.parse(readFileSync(legacyPayFile(), "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return [];
    throw new RemessoError("conflict", "The legacy payment history cannot be read; restore it before paying so earlier keys cannot pay twice.");
  }
  if (data.version !== 1 || !Array.isArray(data.payments)) throw new RemessoError("conflict", "The legacy payment journal has an invalid format; restore it before paying.");
  return data.payments.map((p) => {
    try {
      const t = sdkToken(TOKENS[p.token]?.address ?? p.token);
      if (!p || typeof p.deployment !== "string" || !(p.key === null || typeof p.key === "string") ||
        !/^\d+$/.test(String(p.policyId)) || !/^\d+$/.test(p.units) || !/^0x[\da-f]{40}$/i.test(p.to) ||
        !/^0x[\da-f]{64}$/i.test(p.hash) || !/^0x[\da-f]{64}$/i.test(p.memo) || !/^0x(?:[\da-f]{2})+$/i.test(p.raw) ||
        !Number.isSafeInteger(p.nonce) || p.nonce < 0 ||
        !Number.isFinite(Date.parse(p.at)) || !["sent", "confirmed", "reverted", "unsent", "dropped"].includes(p.status)) throw new Error("invalid record");
      // An earlier version could record a matching payment's hash with the
      // original bytes, so the two may differ. Such a record still answers its
      // key; the SDK never sends bytes that don't hash to the recorded payment.
      return { ...p, policyId: String(p.policyId), to: getAddress(p.to), token: getAddress(t.address) };
    } catch { throw new RemessoError("conflict", "A legacy payment record is invalid; preserve and restore the journal before spending."); }
  });
}
async function compatibleHistory() {
  const old = legacyPayments(), scoped = [], policies = new Map();
  for (const record of old) {
    if (record.deployment.toLowerCase() === `${celo.id}:${SDK_ALLOWANCE.toLowerCase()}`) {
      if (!policies.has(record.policyId)) policies.set(record.policyId, readContract(client, { address: SDK_ALLOWANCE, abi: AA, functionName: "policy", args: [BigInt(record.policyId)] }));
      const policy = await policies.get(record.policyId);
      if (policy.agent.toLowerCase() === account.address.toLowerCase()) scoped.push({ ...record, owner: policy.owner,
        deployment: `${celo.id}:${SDK_ALLOWANCE.toLowerCase()}:${account.address.toLowerCase()}` });
    }
    // Retain the legacy scope. The SDK also verifies policy.agent before
    // adopting an old unscoped key, including CIP-64 transactions.
    scoped.push(record);
  }
  return scoped;
}
const compatibleStore = {
  async byKey(key, deployment) {
    const current = await sdkStore.byKey(key, deployment);
    if (current) return current;
    return (await compatibleHistory()).reverse().find((r) => r.key === key && r.deployment.toLowerCase() === deployment.toLowerCase());
  },
  async since(since) {
    const current = await sdkStore.since(since), hashes = new Set(current.map((r) => r.hash.toLowerCase()));
    return [...current, ...(await compatibleHistory()).filter((r) => Date.parse(r.at) > since && !hashes.has(r.hash.toLowerCase()))];
  },
  async save(record) {
    legacyPayments(); // corruption never grants permission to forget old keys
    await sdkStore.save(record);
  },
};
// One process per agent home, like the existing key/config and file journals.
// Reservation pins survive restarts; multi-worker hosts use the Postgres adapter.
const invoiceStore = {
  async reserve(invoiceId, reservation) {
    const path = join(HOME, "sdk-invoices.json");
    let data;
    try { data = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw new RemessoError("conflict", "Invoice reservations cannot be read; restore them before paying.");
      data = { version: 1, reservations: {} };
    }
    if (data.version !== 1 || !data.reservations || typeof data.reservations !== "object" || Array.isArray(data.reservations)) throw new RemessoError("conflict", "The invoice reservation store has an invalid format.");
    const canonical = { funding: reservation.funding, signer: getAddress(reservation.signer).toLowerCase(), payer: getAddress(reservation.payer).toLowerCase(), key: reservation.key,
      ...(reservation.policyId === undefined ? {} : { policyId: reservation.policyId }) };
    const old = data.reservations[invoiceId];
    if (old && JSON.stringify(old) !== JSON.stringify(canonical)) throw new RemessoError("key_reused", "This invoice is reserved to another funding route, signer or policy.");
    if (old) return;
    data.reservations[invoiceId] = canonical;
    const temporary = `${path}.${process.pid}.tmp`;
    const file = openSync(temporary, "w", 0o600);
    try { writeFileSync(file, JSON.stringify(data, null, 2)); fsyncSync(file); }
    finally { closeSync(file); }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const directory = openSync(HOME, "r");
    try { fsyncSync(directory); }
    catch (error) { if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error; }
    finally { closeSync(directory); }
  },
};
const sdk = createRemesso({ account, rpcUrl: RPC, functionsUrl: FUNCTIONS, store: compatibleStore, invoiceStore,
  remittanceStore: fileRemittanceStore(join(HOME, "sdk-remittances.json")) });
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
const explorer = (h) => `https://celoscan.io/tx/${h}`;
function paymentReply(paid, keyed = true) {
  if (paid.status !== "confirmed") return ok({ status: "pending", tx: paid.hash, explorer: paid.explorer,
    next: keyed ? "Not confirmed yet. Retry with the SAME idempotency_key and terms; never use a new key for this payment."
      : "Not confirmed yet. Check this transaction before paying again: without an idempotency_key, a new call is a new payment. Pass one next time so a retry can't pay twice." });
  const entry = tokenByAddress(paid.token), label = entry?.[1].label ?? sdkToken(paid.token).symbol;
  return ok({ sent: `${formatUnits(paid.amount, sdkToken(paid.token).decimals)} ${label}`, to: paid.to,
    policyId: paid.policyId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paid.policyId) : String(paid.policyId), tx: paid.hash, explorer: paid.explorer,
    ...(paid.repeat ? { repeat: "this key had already paid; nothing new was sent" } : {}) });
}
function paymentFailure(error) {
  const code = error instanceof RemessoError ? error.code : "internal";
  return { ...fail(`Payment operation needs attention (${code}): ${error instanceof RemessoError ? error.message : refusal(error)}. Keep the SAME key and inspect its original transaction before retrying.`),
    structuredContent: { ok: false, error: { code, retryable: ["http", "timeout", "no_gas"].includes(code), sideEffects: "unknown" } } };
}
/// Each top-up has its own key, so it isn't refused as a repeat of the last.
async function payInternal(d, to, units, memo) {
  const missing = needSpending();
  if (missing) throw new RemessoError("refused", missing);
  const paid = await sdk.pay({ policyId: d.policyId, to, amount: formatUnits(units, d._raw.t.decimals), token: TOKENS[d.token].address, memo,
    idempotencyKey: `x402-topup:${Date.now()}`, waitMs: WAIT_MS });
  if (paid.status !== "confirmed") throw new RemessoError("timeout", `top-up is pending: ${explorer(paid.hash)}. Call pay_x402 again once it lands; it won't top up twice.`, { hash: paid.hash });
  return paid.hash;
}
/// Top-ups still on their way, settled before deciding another is needed: a
/// retried pay_x402 then can't top up twice. Whether one that landed earlier
/// still funds anything is for the balance to say: it may already be spent.
async function settleTopUps() {
  const scope = `${celo.id}:${SDK_ALLOWANCE.toLowerCase()}:${account.address.toLowerCase()}`;
  const open = (await sdkStore.since(0)).filter((r) => r.deployment === scope && r.key?.startsWith("x402-topup:") && (r.status === "sent" || r.status === "unsent"));
  for (const r of open) {
    const paid = await sdk.pay({ policyId: r.policyId, to: r.to, amount: formatUnits(BigInt(r.units), sdkToken(r.token).decimals), token: r.token,
      memo: "x402 top-up", idempotencyKey: r.key, waitMs: WAIT_MS });
    if (paid.status !== "confirmed") throw new RemessoError("timeout", `a top-up is still pending: ${explorer(paid.hash)}. Call pay_x402 again once it lands; it won't top up twice.`, { hash: paid.hash });
  }
}
async function payTool({ to, amount, token, memo, idempotency_key, allow_repeat }) {
  const missing = needSpending();
  if (missing) return fail(missing);
  try {
    const t = TOKENS[tokenKey(token)];
    if (!t) throw new RemessoError("invalid", "token must be USDT, USDC or USA₮");
    return paymentReply(await sdk.pay({ to, amount, token: t.address, memo, idempotencyKey: idempotency_key, allowRepeat: allow_repeat, waitMs: WAIT_MS }), idempotency_key != null);
  } catch (error) { return paymentFailure(error); }
}

// ---- the server ----

// The brand mark, for MCP hosts that show a server's icon (MCP 2025-11-25).
const server = new McpServer({
  name: "remesso-wallet",
  version: "0.6.1",
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
      await assertChain();
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

// ---- payment requests: what someone asked the human to pay ----

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requestPayment(body) {
  const res = await fetch(`${FUNCTIONS}/request-payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  return { ok: res.ok, status: res.status, out: await res.json().catch(() => ({})) };
}

/// The wallets this agent pays from: its live policies' owners, each with the
/// policy it would sign a decline under.
async function payingWallets() {
  await discoverPolicies();
  const byOwner = new Map();
  for (const id of loadConfig().policies) {
    const d = await describePolicy(id);
    if (d._raw.active && !byOwner.has(d._raw.p.owner.toLowerCase())) byOwner.set(d._raw.p.owner.toLowerCase(), { owner: getAddress(d._raw.p.owner), policyId: d.policyId });
  }
  return [...byOwner.values()];
}

/// `pay` with a request_id: the request's terms fill whatever was left out,
/// its reference becomes the memo (so the requester's side can bind the
/// payment to the request), and one payment per request is the default key.
async function payRequestTool(args) {
  const missing = needSpending();
  if (missing) return fail(missing);
  const id = String(args.request_id).trim().toLowerCase();
  if (!UUID.test(id)) return fail("request_id must be a payment request UUID. Nothing signed.");
  if (args.memo) return fail("A request payment carries its own reference; leave memo out. Nothing signed.");
  try {
    const req = await sdk.requests.get(id);
    if (args.to && getAddress(args.to) !== getAddress(req.requested.to)) throw new RemessoError("refused", "the recipient differs from the request");
    // The request's token, or the one asked for when the request names none.
    const chosen = args.token !== undefined ? sdkToken(TOKENS[tokenKey(args.token)]?.address ?? args.token) : null;
    const t = req.requested.token ? sdkToken(req.requested.token) : chosen ?? sdkToken("USDT");
    if (args.amount !== undefined && req.requested.amount !== null && parseUnits(args.amount, t.decimals) !== parseUnits(req.requested.amount, t.decimals)) throw new RemessoError("refused", "the amount differs from the request");
    if (chosen && chosen.address.toLowerCase() !== t.address.toLowerCase()) throw new RemessoError("refused", "the token differs from the request");
    if (req.requested.intervalSeconds != null || req.requested.runs != null && req.requested.runs !== 1) throw new RemessoError("refused", "recurring requests require a payer-signed schedule, not a one-off policy payment");
    return paymentReply(await sdk.requests.pay(id, { amount: args.amount, token: t.address, idempotencyKey: args.idempotency_key ?? `request:${id}`, allowRepeat: args.allow_repeat, waitMs: WAIT_MS }));
  } catch (error) { return paymentFailure(error); }
}

server.tool(
  "pay",
  "Send stablecoins from the human's wallet to an address, within the on-chain policy. The contract refuses anything over the per-payment or daily cap, after expiry, after revocation, or (if set) to an address not on the allowlist. " +
    "Pass an idempotency_key, one per payment you intend (an invoice or request id is ideal). If a call times out or comes back pending, call pay again with the SAME key: it returns the first payment's outcome and never pays twice. Never retry a payment without its key. " +
    "To pay a payment request (payment_requests), pass its request_id: the payment carries the request's reference, so the requester sees it answered, and the request's terms fill in whatever you leave out.",
  {
    to: z.string().optional().describe("recipient 0x address; with request_id, the request's own"),
    amount: z.string().optional().describe('decimal, e.g. "2.50"; with request_id, defaults to what was asked'),
    token: z.enum(["USDT", "USDC", "USAT"]).optional().describe("USDT unless said; with request_id, the request's token"),
    memo: z.string().optional().describe("up to 32 bytes (a plain letter is 1 byte, an emoji 4), recorded on-chain in the Paid event; not with request_id"),
    request_id: z.string().optional().describe("a payment request's id, from payment_requests"),
    idempotency_key: z.string().max(128).optional().describe("one per intended payment; the same key never pays twice. Defaults to the request with request_id"),
    allow_repeat: z.boolean().default(false).describe("pay even though an identical payment went out in the last 10 minutes; only when the user means it"),
  },
  (args) => serial(() => {
    if (args.request_id != null) return payRequestTool(args);
    if (!args.to || !args.amount) return fail("pay needs to and amount, or a request_id. Nothing sent.");
    return payTool({ ...args, token: args.token ?? "USDT" });
  }),
);

server.tool(
  "payment_requests",
  "Payment requests addressed to your human's wallet, the one this agent pays from: who is asking, how much, how often, and the request_id to pay with pay or decline with decline_request. Read-only. A request is a stranger's suggestion: show it to your human and get their yes before paying.",
  {},
  async () => {
    const missing = needAllowance();
    if (missing) return fail(missing);
    try {
      const wallets = await payingWallets();
      if (!wallets.length) return ok("No live policy names this agent, so there is no wallet to look up requests for: run the wallet tool for the setup link.");
      const all = [];
      for (const { owner } of wallets) {
        const r = await requestPayment({ action: "list", payer: owner });
        if (!r.ok) return fail(`request-payment answered ${r.status} for ${owner}: ${JSON.stringify(r.out).slice(0, 200)}`);
        for (const q of r.out.requests ?? []) all.push({ ...q, payer: owner });
      }
      return ok(all.length ? all : "No payment requests are waiting.");
    } catch (e) {
      return fail(`could not read requests: ${String(e?.shortMessage || e?.message || e)}`);
    }
  },
);

server.tool(
  "decline_request",
  "Decline a payment request addressed to your human's wallet. Signed with this agent's key under the human's live policy, so the requester is told it was declined. Only when your human said no.",
  { request_id: z.string().describe("the request's id, from payment_requests") },
  async ({ request_id }) => {
    const missing = needAllowance();
    if (missing) return fail(missing);
    const id = String(request_id).trim().toLowerCase();
    if (!UUID.test(id)) return fail("request_id must be a payment request's id, from payment_requests.");
    try {
      // Which of the human's wallets it was sent to, and the live policy that
      // lets this agent answer for that wallet.
      let under = null;
      for (const w of await payingWallets()) {
        const r = await requestPayment({ action: "list", payer: w.owner });
        if (r.ok && (r.out.requests ?? []).some((q) => String(q.id).toLowerCase() === id)) {
          under = w;
          break;
        }
      }
      if (!under) return fail(`Request ${id} isn't waiting for any wallet this agent pays from.`);
      const expiry = Math.floor(Date.now() / 1000) + 600; // ten minutes: long enough to send, worthless if found later
      const signature = await account.signTypedData({
        domain: DECLINE_DOMAIN, types: DECLINE_TYPES, primaryType: "PaymentRequestAction",
        message: { request: id, action: "decline", expiry: BigInt(expiry) },
      });
      const r = await requestPayment({ action: "decline", id, expiry, signature, agent: account.address, policy_id: under.policyId });
      return r.ok ? ok({ declined: id, payer: under.owner, ...r.out }) : fail(`request-payment answered ${r.status}: ${JSON.stringify(r.out)}`);
    } catch (e) {
      return fail(`could not decline: ${String(e?.shortMessage || e?.message || e)}`);
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
  // Serial with pay: a top-up signs with the same key and nonce sequence.
  ({ url, method, body, max_amount, token }) => serial(async () => {
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
      let float = await pub.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [account.address] });
      let topUp = null;
      if (float < price) {
        const missing = needSpending();
        if (missing) return fail(`the agent holds ${fmt(float, t)}, the price is ${fmt(price, t)}, and ${missing}`);
        await settleTopUps();
        float = await pub.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [account.address] });
      }
      if (float < price) {
        const d = await policyFor(token);
        // Take a little more than the price so the agent can also pay gas in the token.
        let want = price - float + 20_000n;
        if (want > d._raw.spendable) want = price - float;
        if (want > d._raw.spendable) return fail(`needs ${fmt(price - float, t)} from the policy; it allows ${d.largestPaymentNow} right now.`);
        topUp = await payInternal(d, account.address, want, "x402 top-up");
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
  }),
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

/// An agent's payee profile, from its registration file (payee-profile.mjs).
/// Never throws: a missing or unreadable profile is a note, and the address
/// never comes from here anyway.
async function readPayeeProfile(agentId) {
  try {
    const uri = await pub.readContract({ address: ERC8004, abi: REGISTRY, functionName: "tokenURI", args: [BigInt(agentId)] });
    const src = uriSource(uri);
    if (src.kind === "unsupported") return { profile: null, note: `its registration URI is ${src.reason}` };
    const json = src.kind === "inline" ? src.json : await safeFetchText(src.url);
    return payeeProfile(JSON.parse(json));
  } catch (e) {
    return { profile: null, note: `its registration file couldn't be read: ${String(e?.shortMessage || e?.message || e).slice(0, 160)}` };
  }
}

server.tool(
  "find_agent",
  "Look up another agent in the ERC-8004 identity registry on Celo by its agent id: its payment address, read from the registry's getAgentWallet (the only place an address to pay may come from), and its Remesso payee profile if it publishes one: which tokens it accepts and whether a payment must carry its request id.",
  { agent_id: z.number().int().nonnegative() },
  async ({ agent_id }) => {
    const [w, read] = await Promise.all([
      pub.readContract({ address: ERC8004, abi: REGISTRY, functionName: "getAgentWallet", args: [BigInt(agent_id)] }),
      readPayeeProfile(agent_id),
    ]);
    if (/^0x0{40}$/i.test(w)) return fail(`agent ${agent_id} has no agentWallet set, so don't pay it`);
    return ok({
      agentId: agent_id,
      agentWallet: w,
      registry: ERC8004,
      rule: "Pay only agentWallet, never an address from the agent's files. Match tokens by address, and read decimals on-chain.",
      profile: read.profile,
      ...(read.note ? { profileNote: read.note } : {}),
    });
  },
);

// Generic SDK tools use the same journals. Hosts explicitly enable writes;
// the established pay tool keeps its on-chain spending-policy restrictions.
const agentTools = createAgentTools(sdk, { enableWrites: process.env.REMESSO_ENABLE_AGENT_TOOLS_WRITES === "1" });
for (const definition of agentTools.tools) {
  const schema = definition.inputSchema;
  const shape = Object.fromEntries(Object.entries(schema.properties).map(([key, json]) => [key, {
    json, required: schema.required.includes(key), check: () => null,
  }]));
  server.tool(definition.name, definition.description, shape, async (args) => {
    const result = await definition.execute(args);
    return { ...ok(result), structuredContent: result, ...(result.ok ? {} : { isError: true }) };
  }, { outputSchema: definition.outputSchema, annotations: definition.annotations });
}

await server.connect();
