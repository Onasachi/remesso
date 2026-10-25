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
import { REGISTRY } from "./deployment.js";
import { type PayeeProfile, payeeProfile, uriSource } from "./vendor/payee-profile.js";

export type FoundAgent = {
  agentId: bigint;
  /** Where to pay it, or null when it has set no wallet: then don't. */
  wallet: Address | null;
  profile: PayeeProfile | null;
  /** Why there's no profile, or no wallet. */
  note?: string;
};

export function makeAgents(ctx: Ctx) {
  return {
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
  };
}

export type Agents = ReturnType<typeof makeAgents>;
