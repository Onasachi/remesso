"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { readContract, waitForTransactionReceipt } from "wagmi/actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddress, getAddress, parseEventLogs } from "viem";
import { wagmiConfig } from "@/lib/wagmi";
import { ensureCelo, txOverrides } from "@/lib/tx";
import { agentAllowanceAbi, erc20Abi } from "@/lib/abi";
import {
  AGENT_ALLOWANCE_ADDRESS,
  EXPLORER,
  USAT,
  USDC,
  USDT,
  tokenFor,
  type TokenInfo,
} from "@/lib/config";
import { formatExact, parseUnits } from "@/lib/format";
import { useIsMiniPay } from "@/lib/hooks";
import { ActionBar, CopyValue } from "@/components/ui";
import { ConnectBar } from "@/components/ConnectBar";
import { Icon } from "@/components/Icon";

/// Where a person gives their AI agent a spending limit.
///
/// The Claude plugin's `wallet` tool hands its human this page with the agent's
/// address in `?agent=`. Two transactions from the person's own wallet: an
/// allowance to RemessoAgentAllowance and a policy (per payment, per day, until
/// when). The money never leaves their wallet, and the caps are the contract's,
/// not the agent's good behaviour.
///
/// The allowance is one number per owner and token, and every policy on that
/// token draws from it: the contract has no total per policy. So the screen
/// calls it a shared total and shows what it already is, rather than offering
/// it as this agent's own limit (docs/agent-to-agent.md, 1a).
///
/// The address comes from the link, never typed or pasted, and inside MiniPay
/// it is not shown — the same rules as a pay link.

const TOKENS: TokenInfo[] = [USDT, USDC, USAT];
/// How many of the newest policies the Stop list reads. See Existing.
const RECENT_IDS = 200;
const DURATIONS = [
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
  { label: "3 months", days: 90 },
] as const;

export default function AgentWalletPage() {
  return (
    <Suspense>
      <Setup />
    </Suspense>
  );
}

function Setup() {
  const raw = useSearchParams().get("agent") ?? "";
  const agent = isAddress(raw, { strict: false }) ? getAddress(raw) : null;
  const { address, isConnected } = useAccount();
  const inMiniPay = useIsMiniPay();

  if (!AGENT_ALLOWANCE_ADDRESS) {
    return (
      <Intro>
        <p className="mt-4 text-[16px] text-ink-2">Agent spending limits are not live yet. Nothing to do here for now.</p>
      </Intro>
    );
  }
  if (!agent) {
    return (
      <Intro>
        <p className="mt-4 text-[16px] text-ink-2">
          This link is missing your agent&apos;s address. Ask your agent for its setup link: in Claude, Codex or Cursor, run the Remesso{" "}
          <span className="font-medium text-ink">wallet</span> tool.
        </p>
      </Intro>
    );
  }
  return (
    <div className="pb-bar">
      <Intro>
        {!inMiniPay && (
          <div className="mt-5 rounded-2xl border border-line bg-surface px-4 py-3">
            <p className="text-[12px] text-ink-3">Agent address</p>
            <CopyValue value={agent} />
          </div>
        )}
      </Intro>
      {!isConnected || !address ? (
        <div className="mt-8">
          <ConnectBar />
        </div>
      ) : (
        <>
          <NewPolicy owner={address} agent={agent} />
          <Existing owner={address} agent={agent} />
        </>
      )}
    </div>
  );
}

function Intro({ children }: { children?: React.ReactNode }) {
  return (
    <div className="stagger mt-8">
      <h1 className="font-display text-[34px] leading-[1.05] text-ink">Give your agent a spending limit.</h1>
      <p className="mt-4 max-w-md text-[16px] leading-relaxed text-ink-2">
        Your AI agent can pay from your wallet, but only within the limits you set here. The money stays in your
        wallet, and you can stop the agent at any time.
      </p>
      {children}
    </div>
  );
}

function NewPolicy({ owner, agent }: { owner: `0x${string}`; agent: `0x${string}` }) {
  const qc = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const [token, setToken] = useState<TokenInfo>(USDT);
  const [perPayment, setPerPayment] = useState("1");
  const [perDay, setPerDay] = useState("5");
  const [budget, setBudget] = useState("20");
  const [days, setDays] = useState<number>(30);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: bigint; hash: string } | null>(null);

  // What this person's policies on this token can already draw on, together.
  const { data: shared } = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, AGENT_ALLOWANCE_ADDRESS as `0x${string}`],
    query: { enabled: Boolean(AGENT_ALLOWANCE_ADDRESS) },
  });
  const already = (shared as bigint | undefined) ?? 0n;

  let problem: string | null = null;
  let units: { pp: bigint; pd: bigint; total: bigint } | null = null;
  try {
    const pp = parseUnits(perPayment, token.decimals);
    const pd = parseUnits(perDay, token.decimals);
    const total = parseUnits(budget, token.decimals);
    if (pp === 0n || pd === 0n || total === 0n) problem = "Every limit must be more than zero.";
    else if (pp > pd) problem = "One payment can't be more than the daily limit.";
    else if (pp > already + total) problem = "One payment can't be more than the shared total.";
    else units = { pp, pd, total };
  } catch (e) {
    problem = (e as Error).message;
  }

  const amount = (v: bigint) => `${formatExact(v, token.decimals, 0)} ${token.symbol}`;
  const sharedHint =
    already > 0n
      ? `Every agent limit on ${token.symbol} draws from one shared total, ${amount(already)} now.` +
        (units ? ` This makes it ${amount(already + units.total)}.` : "")
      : `Every agent limit on ${token.symbol} draws from one shared total, so other limits you set on ${token.symbol} can use this too.`;

  async function create() {
    if (!units || !AGENT_ALLOWANCE_ADDRESS) return;
    setError(null);
    try {
      // `approve` replaces an allowance rather than adding to it, so keep what
      // earlier policies on this token were counting on and add this budget.
      await ensureCelo();
      setBusy("Adding to the shared total");
      const current = await readContract(wagmiConfig, {
        address: token.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, AGENT_ALLOWANCE_ADDRESS as `0x${string}`],
      });
      const approveHash = await writeContractAsync({
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [AGENT_ALLOWANCE_ADDRESS as `0x${string}`, current + units.total],
        ...txOverrides(),
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: approveHash });

      setBusy("Setting the limits");
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
      const hash = await writeContractAsync({
        address: AGENT_ALLOWANCE_ADDRESS as `0x${string}`,
        abi: agentAllowanceAbi,
        functionName: "createPolicy",
        args: [agent, token.address, units.pp, units.pd, expiresAt, false, []],
        ...txOverrides(),
      });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, confirmations: 1 });
      const [ev] = parseEventLogs({ abi: agentAllowanceAbi, eventName: "PolicyCreated", logs: receipt.logs });
      if (!ev) throw new Error("The limit was set but its number could not be read. Check your wallet's history.");
      setDone({ id: ev.args.id, hash });
      qc.invalidateQueries({ queryKey: ["agent-policies", owner, agent] });
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
      setError(/reject|denied/i.test(msg) ? "You cancelled in your wallet. Nothing was set." : msg);
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <div className="mt-8 rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-center gap-2 text-ink">
          <Icon name="check_circle" className="text-clay-deep" />
          <p className="text-[17px] font-medium">Limit #{done.id.toString()} is live.</p>
        </div>
        <p className="mt-3 text-[15px] text-ink-2">Tell your agent:</p>
        <div className="mt-2 rounded-xl bg-sand/70 px-3 py-2.5">
          <CopyValue value={`Link Remesso policy ${done.id.toString()}`} label="Copy" />
        </div>
        <a className="mt-4 inline-flex items-center gap-1 text-[14px] text-ink-2 underline" href={`${EXPLORER}/tx/${done.hash}`} target="_blank" rel="noreferrer">
          View transaction <Icon name="open_in_new" size={16} />
        </a>
      </div>
    );
  }

  const field = "field mt-2";
  return (
    <div className="mt-8 space-y-6">
      <div>
        <p className="label">Currency</p>
        <div className="flex flex-wrap gap-2">
          {TOKENS.map((t) => (
            <button
              key={t.address}
              type="button"
              onClick={() => setToken(t)}
              className={`chip ${token.address === t.address ? "border-clay bg-clay-soft text-clay-deep" : ""}`}
            >
              {t.symbol}
            </button>
          ))}
        </div>
      </div>
      <Money id="pp" label="Most for one payment" value={perPayment} onChange={setPerPayment} unit={token.symbol} cls={field} />
      <Money id="pd" label="Most per day" value={perDay} onChange={setPerDay} unit={token.symbol} cls={field} />
      <Money
        id="total"
        label="Add to the shared total"
        hint={sharedHint}
        value={budget}
        onChange={setBudget}
        unit={token.symbol}
        cls={field}
      />
      <div>
        <p className="label">For how long</p>
        <div className="flex flex-wrap gap-2">
          {DURATIONS.map((d) => (
            <button
              key={d.days}
              type="button"
              onClick={() => setDays(d.days)}
              className={`chip ${days === d.days ? "border-clay bg-clay-soft text-clay-deep" : ""}`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      {problem && <p className="text-[13px] text-danger">{problem}</p>}
      {error && <p className="text-[13px] text-danger">{error}</p>}
      <ActionBar note="Two steps in your wallet: add to the shared total, then set this agent's limits.">
        <button className="btn-primary flex-1 rounded-[20px]" disabled={Boolean(busy) || !units} onClick={create}>
          {busy ?? "Set the limit"}
        </button>
      </ActionBar>
    </div>
  );
}

function Money({
  id,
  label,
  hint,
  value,
  onChange,
  unit,
  cls,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  cls: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          inputMode="decimal"
          className={cls}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(",", "."))}
        />
        <span className="mt-2 shrink-0 text-[15px] text-ink-3">{unit}</span>
      </div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/// This person's policies for this agent, read from the chain, each with a
/// stop button. Revoking is one transaction and cannot be undone.
function Existing({ owner, agent }: { owner: `0x${string}`; agent: `0x${string}` }) {
  const client = usePublicClient();
  const qc = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const [stopping, setStopping] = useState<bigint | null>(null);

  const { data } = useQuery({
    queryKey: ["agent-policies", owner, agent],
    enabled: Boolean(client && AGENT_ALLOWANCE_ADDRESS),
    queryFn: async () => {
      // Read policies by id, newest first, rather than searching PolicyCreated
      // logs: forno answers getLogs over at most 5,000 blocks (~83 minutes),
      // so a search from the deploy block failed silently soon after launch and
      // this list, with its Stop buttons, never appeared. Ids are dense and few;
      // the newest RECENT_IDS cover every policy until usage grows past them.
      const aa = AGENT_ALLOWANCE_ADDRESS as `0x${string}`;
      const next = await client!.readContract({ address: aa, abi: agentAllowanceAbi, functionName: "nextPolicyId" });
      const ids: bigint[] = [];
      for (let id = next - 1n; id >= 1n && ids.length < RECENT_IDS; id--) ids.push(id);
      const policies = await Promise.all(
        ids.map((id) => client!.readContract({ address: aa, abi: agentAllowanceAbi, functionName: "policy", args: [id] })),
      );
      const mine = ids
        .map((id, i) => ({ id, p: policies[i] }))
        .filter(({ p }) => p.owner.toLowerCase() === owner.toLowerCase() && p.agent.toLowerCase() === agent.toLowerCase());
      return Promise.all(
        mine.map(async ({ id, p }) => ({
          id,
          p,
          left: await client!.readContract({ address: aa, abi: agentAllowanceAbi, functionName: "remainingToday", args: [id] }),
        })),
      );
    },
  });

  if (!data?.length) return null;

  async function stop(id: bigint) {
    setStopping(id);
    try {
      await ensureCelo();
      const hash = await writeContractAsync({
        address: AGENT_ALLOWANCE_ADDRESS as `0x${string}`,
        abi: agentAllowanceAbi,
        functionName: "revoke",
        args: [id],
        ...txOverrides(),
      });
      await waitForTransactionReceipt(wagmiConfig, { hash });
      qc.invalidateQueries({ queryKey: ["agent-policies", owner, agent] });
    } finally {
      setStopping(null);
    }
  }

  const now = Date.now() / 1000;
  return (
    <div className="mt-10">
      <p className="label">Limits you have given this agent</p>
      <div className="space-y-2">
        {data.map(({ id, p, left }) => {
          const t = tokenFor(p.token);
          const live = !p.revoked && Number(p.expiresAt) > now;
          return (
            <div key={id.toString()} className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium text-ink">
                  #{id.toString()} · {formatExact(p.perPayment, t.decimals, 0)} {t.symbol} per payment, {formatExact(p.perDay, t.decimals, 0)} a day
                </p>
                <p className="mt-px text-[12px] text-ink-2">
                  {p.revoked
                    ? "Stopped"
                    : !live
                      ? "Expired"
                      : `${formatExact(left, t.decimals, 0)} ${t.symbol} left today · until ${new Date(Number(p.expiresAt) * 1000).toLocaleDateString()}`}
                </p>
              </div>
              {live && (
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-line px-3 py-1.5 text-[13px] text-danger"
                  disabled={stopping === id}
                  onClick={() => stop(id)}
                >
                  {stopping === id ? "Stopping" : "Stop"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
