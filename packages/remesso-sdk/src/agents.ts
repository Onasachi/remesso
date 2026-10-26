/// Other agents, found in the ERC-8004 identity registry on Celo.
///
/// The address to pay comes only from the registry's `getAgentWallet`, which
/// only the wallet's own signature can set. The agent's registration file can
/// be rewritten by the token's owner at any time, so it is read for the
/// payee profile (which tokens it accepts, whether a payment must carry its
/// request id) and never for an address.
import type { Address } from "viem";
import { registryAbi } from "./abi.js";
import type { Ctx } from "./context.js";
import { checksum, REGISTRY, token as tokenOf } from "./deployment.js";
import { RemessoError } from "./errors.js";
import type { RemittanceFunding, RemittanceResult, Remittances } from "./remittances.js";
import type { Requests } from "./requests.js";
import { type PayeeProfile, payeeProfile, uriSource } from "./vendor/payee-profile.js";

export type FoundAgent = {
  agentId: bigint;
  /** Where to pay it, or null when it has set no wallet: then don't. */
  wallet: Address | null;
  profile: PayeeProfile | null;
  /** Why there's no profile, or no wallet. */
  note?: string;
};

export type AgentPayInput = RemittanceFunding & {
  /** Refuse if the registry now names a different wallet than the one you approved. */
  expectedWallet?: string;
  waitMs?: number;
} & (
  | { requestId: string; amount?: never; token?: never; idempotencyKey?: string }
  | { requestId?: never; amount: string; token: string; idempotencyKey: string }
);
export type AgentPaymentResult = RemittanceResult & { counterparty: { agentId: bigint; wallet: Address } };

export function makeAgents(ctx: Ctx, deps?: { send: Remittances["send"]; getRequest: Requests["get"] }) {
  const agents = {
    async find(agentId: bigint | number | string): Promise<FoundAgent> {
      const id = BigInt(agentId);
      const [wallet, uri] = await Promise.all([
        ctx.pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getAgentWallet", args: [id] }),
        ctx.pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "tokenURI", args: [id] }).catch(() => null),
      ]);
      const none = /^0x0{40}$/i.test(wallet);
      let read: { profile: PayeeProfile | null; note?: string } = { profile: null, note: "it has no registration file" };
      if (uri != null) {
        try {
          const src = uriSource(uri);
          if (src.kind === "unsupported") read = { profile: null, note: `its registration URI is ${src.reason}` };
          else if (src.kind === "inline") read = payeeProfile(JSON.parse(src.json));
          else if (!ctx.fetchText) {
            read = { profile: null, note: "its registration file is remote: pass fetchText (safeFetchText from remesso-sdk/node) to read it" };
          } else read = payeeProfile(JSON.parse(await ctx.fetchText(src.url)));
        } catch (e) {
          read = { profile: null, note: `its registration file couldn't be read: ${String((e as Error).message).slice(0, 160)}` };
        }
      }
      return {
        agentId: id,
        wallet: none ? null : wallet,
        profile: read.profile,
        ...(none ? { note: "it has no agentWallet set, so don't pay it" } : read.note ? { note: read.note } : {}),
      };
    },
    /** Resolve the registered wallet and enforce its published payment requirements. */
    async pay(agentId: bigint | number | string, input: AgentPayInput): Promise<AgentPaymentResult> {
      if (!deps) throw new RemessoError("invalid", "agent payments require the complete createRemesso client");
      if (!input || !["wallet", "policy"].includes(input.funding)) throw new RemessoError("invalid", "choose funding: wallet or policy explicitly");
      if (input.funding === "wallet" && (input.policyId != null || input.payer != null)) throw new RemessoError("invalid", "wallet funding cannot select a policy or another payer");
      if (input.requestId && (input.amount !== undefined || input.token !== undefined)) throw new RemessoError("invalid", "an invoice supplies the amount and token; omit overrides");
      const found = await agents.find(agentId);
      if (!found.wallet) throw new RemessoError("refused", "the receiving agent has no registered wallet");
      const wallet = checksum(found.wallet);
      if (input.expectedWallet && checksum(input.expectedWallet) !== wallet) throw new RemessoError("conflict", "the receiving agent's wallet differs from the wallet you approved");
      if (!found.profile) throw new RemessoError("refused", `the agent has no readable supported payment profile: ${found.note ?? "no remesso entry"}`);
      const invoice = input.requestId ? await deps.getRequest(input.requestId) : undefined;
      if (invoice && checksum(invoice.requested.to) !== wallet) throw new RemessoError("refused", "the invoice recipient is not this agent's registered wallet");
      if (found.profile.reference?.required && !invoice) throw new RemessoError("refused", "the receiving agent requires a payment request reference");
      const amount = invoice ? invoice.requested.amount : input.amount;
      const token = invoice ? invoice.requested.token : input.token;
      if (!amount || !token) throw new RemessoError("invalid", "an agent payment requires an exact amount and token");
      const t = tokenOf(token);
      if (!found.profile.assets.some((a) => a.network === "eip155:42220" && a.asset.toLowerCase() === t.address.toLowerCase())) throw new RemessoError("refused", "the receiving agent does not publish acceptance of this token on Celo");
      // The registry can change while fetching an HTTP profile or invoice.
      const current = await ctx.pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getAgentWallet", args: [found.agentId] });
      if (checksum(current) !== wallet) throw new RemessoError("conflict", "the receiving agent's wallet changed during payment preparation; review it again");
      const key = input.idempotencyKey ?? (invoice ? `request:${invoice.id}` : "");
      const funding = input.funding === "wallet" ? { funding: "wallet" as const } : { funding: "policy" as const, policyId: input.policyId, payer: input.payer };
      const payment = await deps.send({ ...funding, to: wallet, amount, token: t.address, idempotencyKey: key, requestId: invoice?.id, waitMs: input.waitMs });
      return { ...payment, counterparty: { agentId: found.agentId, wallet } };
    },
  };
  return agents;
}

export type Agents = ReturnType<typeof makeAgents>;
