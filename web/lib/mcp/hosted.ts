/// The hosted agent: hands-free payments for someone signed in to the
/// connector, from Claude on any device.
///
/// Each person owns their agent wallet in Privy; Remesso is one of its signers,
/// limited to pay() on RemessoAgentAllowance, on Celo, with no CELO attached,
/// and only the person can remove it. No key reaches this code: Privy signs in
/// its own hardware. The money never sits with the agent either: each payment
/// moves from the person's own wallet through a policy they signed there, under
/// its per-payment and daily caps. Two walls, and the second is on-chain.
///
/// Off unless HOSTED_AGENT_ENABLED=1: holding keys that can move people's money,
/// even capped, waits on a legal answer.

import { PrivyClient } from "@privy-io/node";
import { toDataSuffix } from "@celo/attribution-tags";
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, formatUnits, getAddress, http,
  isAddress, parseAbi, parseUnits, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RPC_URL } from "@/lib/config";
import { refuse, text, type Tool } from "@/lib/mcp/protocol";

const celo = defineChain({
  id: 42220,
  name: "Celo",
  nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
  rpcUrls: { default: { http: [process.env.CELO_RPC_URL ?? RPC_URL] } },
});
const pub = createPublicClient({ chain: celo, transport: http() });

const ALLOWANCE = getAddress(process.env.NEXT_PUBLIC_AGENT_ALLOWANCE_ADDRESS ?? "0xA6351fAeEb097698289586C4D6188530300DB209");
const SUFFIX = toDataSuffix(
  (process.env.NEXT_PUBLIC_ATTRIBUTION_CODE ?? "remesso,celo_5cd35ca55baf").toLowerCase().split(",").map((c) => c.trim()).filter(Boolean),
) as Hex;

/// The tokens a policy can be for: the dollar stablecoins, all 6dp.
const TOKENS = {
  USDT: { address: getAddress("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"), decimals: 6, label: "USD₮" },
  USDC: { address: getAddress("0xcebA9300f2b948710d2653dD7B07f33A8B32118C"), decimals: 6, label: "USDC" },
  USAT: { address: getAddress("0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771"), decimals: 6, label: "USA₮" },
} as const;
type Sym = keyof typeof TOKENS;
const bySym = (s: unknown): Sym | undefined => {
  const k = String(s ?? "").toUpperCase().replace("₮", "T").replace("USD T", "USDT");
  return k in TOKENS ? (k as Sym) : undefined;
};
const byAddress = (a: string) => (Object.entries(TOKENS) as [Sym, (typeof TOKENS)[Sym]][]).find(([, t]) => t.address.toLowerCase() === a.toLowerCase());

const AA = parseAbi([
  "struct Policy { address owner; address agent; address token; uint64 expiresAt; bool allowlistOnly; bool revoked; uint128 perPayment; uint128 perDay; uint128 spentInWindow; uint64 windowStart; }",
  "function policy(uint256) view returns (Policy)",
  "function remainingToday(uint256) view returns (uint256)",
  "function nextPolicyId() view returns (uint256)",
  "function pay(uint256 id, address to, uint256 amount, bytes32 memo)",
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
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

// ---- Privy: each person owns their agent; Remesso is only a signer ----
//
// The person is a Privy user tied to their Remesso sign-in (custom auth: Privy
// verifies our Supabase tokens against the project's ES256 JWKS). Their agent
// is a wallet they OWN. Remesso is added to it as an additional signer whose
// override policy allows only pay() on RemessoAgentAllowance, on Celo.
//
// Measured 2026-10-20: as a signer, Remesso could not change the signers or
// export the key ("no valid authorization keys or user signing keys"); the
// person's own sign-in removed Remesso, after which Remesso could not sign.
// Adding Remesso back after a Stop needs the person's sign-in again.

let privyClient: PrivyClient | null = null;
export function privy(): PrivyClient {
  if (!privyClient) privyClient = new PrivyClient({ appId: setting("PRIVY_APP_ID"), appSecret: setting("PRIVY_APP_SECRET") });
  return privyClient;
}
/// A setting as typed into a dashboard: stray spaces, quotes or backticks are
/// dropped, because Privy rejects an id with any of them ("Invalid cuid2"),
/// and a bad paste should fail loudly here, not as a mystery at sign-in.
function setting(name: string, shape?: RegExp): string {
  const v = (process.env[name] ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!v) throw new Error(`${name} is not set`);
  if (shape && !shape.test(v)) throw new Error(`${name} does not look like a Privy id (check it for extra characters)`);
  return v;
}
const PRIVY_ID = /^[a-z][a-z0-9]{15,31}$/;

/// Remesso signing as itself, the signer: a request without this signature
/// is refused by Privy, so the app secret alone moves nothing.
const asRemesso = () => ({ authorization_private_keys: [setting("PRIVY_AUTHORIZATION_KEY")] });
const SIGNER = () => setting("PRIVY_SIGNER_QUORUM_ID", PRIVY_ID);
const remessoSigner = () => ({ signer_id: SIGNER(), override_policy_ids: [setting("PRIVY_AGENT_POLICY_ID", PRIVY_ID)] });

export type Agent = { walletId: string; address: `0x${string}`; privyUserId: string };
type PrivyUser = Awaited<ReturnType<ReturnType<PrivyClient["users"]>["_get"]>>;

async function findPerson(personId: string): Promise<PrivyUser | null> {
  try {
    return await privy().users().getByCustomAuthID({ custom_user_id: personId });
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}
function walletOf(user: PrivyUser): { id: string; address: string } | null {
  for (const a of user.linked_accounts) {
    const w = a as { type?: string; chain_type?: string; connector_type?: string; id?: string | null; address?: string };
    if (w.type === "wallet" && w.chain_type === "ethereum" && w.connector_type === "embedded" && w.id && w.address) {
      return { id: w.id, address: w.address };
    }
  }
  return null;
}

/// At sign-in, with the person's fresh token: make sure they exist in Privy,
/// own an agent, and have Remesso on it as a signer. Creating the person and
/// their wallet with the signer in one request is Privy's pregeneration; adding
/// Remesso back to an existing wallet (after a Stop) is an owner action, so it
/// carries the person's token.
export async function connectAgent(personId: string, personJwt: string): Promise<Agent> {
  let user = await findPerson(personId);
  if (!user) {
    user = await privy().users().create({
      linked_accounts: [{ type: "custom_auth", custom_user_id: personId }],
      wallets: [{ chain_type: "ethereum", additional_signers: [remessoSigner()] }],
    });
  }
  let w = walletOf(user);
  if (!w) {
    user = await privy().users().pregenerateWallets(user.id, { wallets: [{ chain_type: "ethereum", additional_signers: [remessoSigner()] }] });
    w = walletOf(user);
    if (!w) throw new Error("Privy did not create the agent wallet");
  }
  const wallet = await privy().wallets().get(w.id);
  const signers = wallet.additional_signers ?? [];
  if (!signers.some((s) => s.signer_id === SIGNER())) {
    await privy().wallets().update(w.id, {
      additional_signers: [...signers.map((s) => ({ signer_id: s.signer_id, override_policy_ids: s.override_policy_ids })), remessoSigner()],
      authorization_context: { user_jwts: [personJwt] },
    });
  }
  return { walletId: w.id, address: getAddress(w.address), privyUserId: user.id };
}

export class AgentStopped extends Error {}

/// At tool time: the person's agent, if Remesso is still one of its signers.
export async function agentFor(personId: string): Promise<Agent> {
  const user = await findPerson(personId);
  const w = user ? walletOf(user) : null;
  if (!user || !w) throw new AgentStopped("No Remesso agent for this sign-in yet. Disconnect and reconnect Remesso in Claude to create one.");
  const wallet = await privy().wallets().get(w.id);
  if (!(wallet.additional_signers ?? []).some((s) => s.signer_id === SIGNER())) {
    throw new AgentStopped("You stopped Remesso from paying for you. To use hands-free payments again, disconnect and reconnect Remesso in Claude.");
  }
  return { walletId: w.id, address: getAddress(w.address), privyUserId: user.id };
}

/// The person's Stop: removes Remesso as a signer, as the owner. Remesso
/// cannot do this alone, nor undo it without the person signing in again.
export async function stopAgent(personId: string, personJwt: string): Promise<{ stopped: boolean; address?: string }> {
  const user = await findPerson(personId);
  const w = user ? walletOf(user) : null;
  if (!user || !w) return { stopped: false };
  const wallet = await privy().wallets().get(w.id);
  const keep = (wallet.additional_signers ?? []).filter((s) => s.signer_id !== SIGNER());
  await privy().wallets().update(w.id, {
    additional_signers: keep.map((s) => ({ signer_id: s.signer_id, override_policy_ids: s.override_policy_ids })),
    authorization_context: { user_jwts: [personJwt] },
  });
  return { stopped: true, address: getAddress(w.address) };
}

// ---- reading the chain: policies naming the agent, and readiness ----

/// Read by id rather than by event search: forno answers getLogs over 5,000
/// blocks at most. Bounded so a busy contract cannot stall a tool call; move
/// to an index before the contract holds thousands of policies.
async function policiesFor(agent: `0x${string}`): Promise<number[]> {
  const next = Number(await pub.readContract({ address: ALLOWANCE, abi: AA, functionName: "nextPolicyId" }));
  const ids = Array.from({ length: Math.max(0, next - 1) }, (_, i) => i + 1).slice(-1000);
  const out: number[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    const ps = await Promise.all(batch.map((id) => pub.readContract({ address: ALLOWANCE, abi: AA, functionName: "policy", args: [BigInt(id)] })));
    ps.forEach((p, k) => { if (p.agent.toLowerCase() === agent.toLowerCase()) out.push(batch[k]); });
  }
  return out;
}

type Described = {
  id: number; sym: Sym | null; label: string; active: boolean; revoked: boolean; expires: string;
  perPayment: string; perDay: string; remainingToday: string; recipients: string;
  ownerBalance: string; ownerApproved: string; largestNow: string;
  _spendable: bigint; _owner: `0x${string}`; _token: `0x${string}`;
};

async function describe(id: number, agent: `0x${string}`): Promise<Described> {
  const [p, remaining] = await Promise.all([
    pub.readContract({ address: ALLOWANCE, abi: AA, functionName: "policy", args: [BigInt(id)] }),
    pub.readContract({ address: ALLOWANCE, abi: AA, functionName: "remainingToday", args: [BigInt(id)] }),
  ]);
  const entry = byAddress(p.token);
  const dec = entry ? entry[1].decimals : 6;
  const label = entry ? entry[1].label : p.token;
  const f = (u: bigint) => `${formatUnits(u, dec)} ${label}`;
  const [bal, appr] = await Promise.all([
    pub.readContract({ address: p.token, abi: ERC20, functionName: "balanceOf", args: [p.owner] }),
    pub.readContract({ address: p.token, abi: ERC20, functionName: "allowance", args: [p.owner, ALLOWANCE] }),
  ]);
  const active = !p.revoked && BigInt(Math.floor(Date.now() / 1000)) < p.expiresAt && p.agent.toLowerCase() === agent.toLowerCase();
  let spendable = remaining;
  for (const cap of [p.perPayment, bal, appr]) if (cap < spendable) spendable = cap;
  if (!active) spendable = 0n;
  return {
    id, sym: entry ? entry[0] : null, label, active, revoked: p.revoked,
    expires: new Date(Number(p.expiresAt) * 1000).toISOString(),
    perPayment: f(p.perPayment), perDay: f(p.perDay), remainingToday: f(remaining),
    recipients: p.allowlistOnly ? "only addresses on its list" : "any address",
    ownerBalance: f(bal), ownerApproved: f(appr), largestNow: f(spendable),
    _spendable: spendable, _owner: p.owner, _token: p.token,
  };
}
const strip = ({ _spendable, _owner, _token, ...rest }: Described) => rest;

function refusal(e: unknown): string {
  const err = e as { cause?: { data?: { errorName?: string } }; data?: { errorName?: string }; shortMessage?: string; message?: string };
  const name = err?.cause?.data?.errorName ?? err?.data?.errorName;
  return ({
    NotAgent: "the policy names a different agent",
    Revoked: "the person revoked this policy",
    Expired: "the policy has expired",
    OverPerPayment: "the amount is over the per-payment cap",
    OverPerDay: "today's cap is used up; it resets 24 hours after the day's first payment",
    RecipientNotAllowed: "the recipient is not on the policy's list",
    SelfPayment: "a policy cannot pay its own owner",
    SafeERC20FailedOperation: "the token refused: the person's balance or approval is too low",
  } as Record<string, string>)[name ?? ""] ?? String(err?.shortMessage ?? err?.message ?? e);
}

// ---- network fees: Privy signs standard transactions only, so CELO ----

const GAS_FLOOR = parseUnits("0.01", 18);
const GAS_TOP_UP = parseUnits("0.05", 18);

/// Remesso pays its agents' network fees (about $0.002 a payment) from a small
/// hot wallet that can do nothing else. Without one configured, the person is
/// asked to send the agent a little CELO.
async function ensureGas(agent: `0x${string}`): Promise<string | null> {
  const bal = await pub.getBalance({ address: agent });
  if (bal >= GAS_FLOOR) return null;
  const key = process.env.GAS_TANK_PRIVATE_KEY as Hex | undefined;
  if (!key) return `The agent (${agent}) needs about 0.05 CELO for network fees.`;
  const tank = createWalletClient({ chain: celo, transport: http(), account: privateKeyToAccount(key) });
  const hash = await tank.sendTransaction({ to: agent, value: GAS_TOP_UP, data: SUFFIX });
  await pub.waitForTransactionReceipt({ hash });
  return null;
}

// ---- the tools ----

const setupLinkFor = (origin: string, agent: string) => `${origin}/agent-wallet?agent=${agent}`;
const openIn = (url: string) => ({
  metamask: `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}`,
  trust: `https://link.trustwallet.com/open_url?coin_id=52752&url=${encodeURIComponent(url)}`,
});

async function readiness(origin: string, agent: Agent) {
  const all = await Promise.all((await policiesFor(agent.address)).map((id) => describe(id, agent.address)));
  const live = all.filter((d) => d.active).sort((a, b) => (b._spendable > a._spendable ? 1 : -1));
  const d = live[0];
  const lines: string[] = [];
  let next = "Ready. Ask what to pay.";
  let ready = true;
  const fail = (line: string, todo: string) => {
    lines.push(`✗ ${line}`);
    if (ready) next = todo;
    ready = false;
  };
  lines.push(`✓ Agent: ${agent.address}, owned by you; Remesso signs for it only within your policy (stop it any time: ${origin}/agent/stop)`);
  const link = setupLinkFor(origin, agent.address);
  if (!d) {
    fail(
      all.length ? `Spending policy: none live (${all.map((x) => `#${x.id} ${x.revoked ? "revoked" : "expired"}`).join(", ")})` : "Spending policy: none yet",
      `Open the setup link in your wallet's browser, set the limits and approve two steps; then I'll check again. Link: ${link}`,
    );
  } else {
    lines.push(`✓ Spending policy #${d.id}: ${d.perPayment} per payment, ${d.perDay} a day, until ${d.expires.slice(0, 10)}, to ${d.recipients}`);
    if (d._spendable === 0n) fail(`Funds: ${d.ownerBalance} in your wallet, ${d.ownerApproved} approved, ${d.remainingToday} left today`, "Add funds to your wallet, approve more on the setup page, or wait for tomorrow's limit.");
    else lines.push(`✓ Funds: ${d.ownerBalance} in your wallet, ${d.ownerApproved} approved; up to ${d.largestNow} in one payment now`);
  }
  const gas = await pub.getBalance({ address: agent.address });
  if (gas >= GAS_FLOOR) lines.push(`✓ Network fees: ${formatUnits(gas, 18)} CELO`);
  else if (process.env.GAS_TANK_PRIVATE_KEY) lines.push("✓ Network fees: Remesso tops the agent up before it pays");
  else fail("Network fees: the agent holds no CELO", `Send the agent ${agent.address} about 0.05 CELO.`);
  return { ready, checklist: lines, next, ...(d ? {} : { setupLink: link, openIn: openIn(link) }), policies: all.map(strip) };
}

const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export function hostedTools(origin: string, personId: string | null): Tool[] {
  // Every hosted tool needs a signed-in person; the /mcp route answers 401
  // before calling one without a token, which is what makes Claude sign in.
  const who = () => {
    if (!personId) throw new Error("sign in to Remesso first");
    return agentFor(personId);
  };

  const wallet: Tool = {
    name: "agent_wallet",
    title: "Your hands-free agent",
    description:
      "The signed-in person's hosted Remesso agent: its address, the spending policy they set, their funds, network fees, and a " +
      "checklist with the one next step. Returns a setup link when no policy exists yet.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ,
    async run() {
      const agent = await who();
      const r = await readiness(origin, agent);
      return text([...r.checklist, `Next: ${r.next}`, ...(r.openIn ? [`Open in MetaMask: ${r.openIn.metamask}`, `Open in Trust Wallet: ${r.openIn.trust}`] : [])].join("\n"), { address: agent.address, ...r });
    },
  };

  const awaitSetup: Tool = {
    name: "agent_await_setup",
    title: "Wait for the spending policy",
    description: "Wait while the person sets their agent's limits from the setup link, and return as soon as a live policy appears (or after about 50 seconds).",
    inputSchema: { type: "object", properties: { timeout_seconds: { type: "integer", minimum: 5, maximum: 55, default: 50 } }, additionalProperties: false },
    annotations: READ,
    async run(a) {
      const agent = await who();
      const until = Date.now() + Math.min(Number(a.timeout_seconds ?? 50), 55) * 1000;
      for (;;) {
        const ids = await policiesFor(agent.address).catch(() => [] as number[]);
        for (const id of ids) {
          if ((await describe(id, agent.address)).active) {
            const r = await readiness(origin, agent);
            return text(["Policy found.", ...r.checklist, `Next: ${r.next}`].join("\n"), r);
          }
        }
        if (Date.now() + 5000 > until) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      return text("No policy yet. Ask whether they finished both steps in their wallet, then wait again.", { found: false, setupLink: setupLinkFor(origin, agent.address) });
    },
  };

  const pay: Tool = {
    name: "agent_pay",
    title: "Pay from your wallet (hands-free)",
    description:
      "Send a payment from the signed-in person's own wallet through their agent policy, signed by their hosted agent: no wallet " +
      "tap needed. The contract refuses anything over the per-payment or daily cap, after expiry or revocation. Read the recipient, " +
      "amount and token back to the person and get their yes first.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "recipient's 0x address" },
        amount: { type: "string", description: 'decimal, e.g. "2.50"' },
        token: { type: "string", enum: ["USDT", "USDC", "USAT"], default: "USDT" },
        memo: { type: "string", maxLength: 32, description: "recorded on-chain in the Paid event" },
      },
      required: ["to", "amount"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
    async run(a) {
      const agent = await who();
      const to = String(a.to ?? "").trim();
      if (!isAddress(to)) return refuse(`not an address: ${to}`);
      const sym = bySym(a.token ?? "USDT");
      if (!sym) return refuse("token must be USDT, USDC or USAT");
      const t = TOKENS[sym];
      let units: bigint;
      try {
        units = parseUnits(String(a.amount ?? ""), t.decimals);
      } catch {
        return refuse(`amount must be a decimal with at most ${t.decimals} places`);
      }
      if (units <= 0n) return refuse("amount must be more than zero");
      const ds = await Promise.all((await policiesFor(agent.address)).map((id) => describe(id, agent.address)));
      const d = ds.filter((x) => x.active && x.sym === sym).sort((x, y) => (y._spendable > x._spendable ? 1 : -1))[0];
      if (!d) return refuse(`no live ${t.label} policy for this agent. Run agent_wallet for the setup link.`);
      if (units > d._spendable) return refuse(`${a.amount} ${t.label} is more than the policy allows right now (${d.largestNow}). Nothing sent.`);

      const memo = `0x${Buffer.from(String(a.memo ?? "").slice(0, 32)).toString("hex").padEnd(64, "0")}` as Hex;
      const args = [BigInt(d.id), getAddress(to), units, memo] as const;
      try {
        await pub.simulateContract({ address: ALLOWANCE, abi: AA, functionName: "pay", args, account: agent.address });
      } catch (e) {
        return refuse(`Nothing sent: ${refusal(e)}`);
      }
      const noGas = await ensureGas(agent.address);
      if (noGas) return refuse(noGas);
      const data = (encodeFunctionData({ abi: AA, functionName: "pay", args }) + SUFFIX.slice(2)) as Hex;
      const sent = await privy().wallets().ethereum().sendTransaction(agent.walletId, {
        caip2: "eip155:42220",
        params: { transaction: { to: ALLOWANCE, data, value: "0x0" } },
        authorization_context: asRemesso(),
      });
      const receipt = await pub.waitForTransactionReceipt({ hash: sent.hash as Hex });
      if (receipt.status !== "success") return refuse(`The payment reverted on-chain: https://celoscan.io/tx/${sent.hash}`);
      return text(
        `Sent ${a.amount} ${t.label} to ${getAddress(to)} from your wallet (policy #${d.id}).\nhttps://celoscan.io/tx/${sent.hash}`,
        { tx: sent.hash, policyId: d.id, to: getAddress(to), amount: String(a.amount), token: sym },
      );
    },
  };

  return [wallet, awaitSetup, pay];
}

export const HOSTED_TOOL_NAMES = new Set(["agent_wallet", "agent_await_setup", "agent_pay"]);
