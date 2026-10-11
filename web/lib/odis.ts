import "server-only";
import { newKit } from "@celo/contractkit";
import { OdisUtils } from "@celo/identity";
import type { AuthSigner } from "@celo/identity/lib/odis/query";
import { createPublicClient, http, parseAbi, getAddress } from "viem";

/// Phone number -> MiniPay wallet, via ODIS and FederatedAttestations.
///
/// Server-only because every lookup is signed by the key that pays for ODIS
/// quota (`ODIS_QUOTA_PRIVATE_KEY`). That key moves nothing of anyone's: it
/// holds a little USDm for quota and a little CELO for gas. It is deliberately
/// not the executor key, for the same reason `AGENT_SPEND_PRIVATE_KEY` is not.
///
/// Runs here and not in an Edge Function because `@celo/identity` drags in
/// web3 1.x, which does not load under Deno (measured 2026-10-11:
/// cross-fetch's node polyfill is missing).

/// MiniPay's attestation issuer. Only its mappings are trusted: another
/// issuer's claim that a number belongs to some wallet is not MiniPay's, and
/// paying it would not land in the MiniPay account the sender meant.
export const MINIPAY_ISSUER = "0x7888612486844Bb9BE598668081c59A9f7367FBc";
const FEDERATED_ATTESTATIONS = "0x0aD5b1d0C25ecF6266Dd951403723B2687d6aff2";

const faAbi = parseAbi([
  "function lookupAttestations(bytes32 identifier, address[] trustedIssuers) view returns (uint256[] countsPerIssuer, address[] accounts, address[] signers, uint64[] issuedOns, uint64[] publishedOns)",
]);

const RPC = process.env.CELO_RPC_URL ?? process.env.NEXT_PUBLIC_CELO_RPC_URL ?? "https://forno.celo.org";

export class OdisQuotaExhausted extends Error {}

/// The MiniPay wallet a number is registered to, or null if it has none.
///
/// When a number has several attestations, the most recently issued wins:
/// that is the wallet the person moved to, and the older ones are wallets
/// they left behind.
export async function resolveMiniPayPhone(e164: string): Promise<`0x${string}` | null> {
  const raw = (process.env.ODIS_QUOTA_PRIVATE_KEY ?? "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error("ODIS_QUOTA_PRIVATE_KEY is not set");
  const pk = raw.startsWith("0x") ? raw : `0x${raw}`;

  const kit = newKit(RPC);
  kit.addAccount(pk);
  const account = kit.connection.getLocalAccounts()[0];
  kit.defaultAccount = account;

  const ctx = OdisUtils.Query.getServiceContext(
    OdisUtils.Query.OdisContextName.MAINNET,
    OdisUtils.Query.OdisAPI.PNP,
  );
  const auth: AuthSigner = {
    authenticationMethod: OdisUtils.Query.AuthenticationMethod.WALLET_KEY,
    contractKit: kit,
  };

  let obfuscated: string;
  try {
    ({ obfuscatedIdentifier: obfuscated } = await OdisUtils.Identifier.getObfuscatedIdentifier(
      e164,
      OdisUtils.Identifier.IdentifierPrefix.PHONE_NUMBER,
      account,
      auth,
      ctx,
    ));
  } catch (e) {
    // ODIS answers an unpaid account with an "exceeded quota" error; that is
    // ours to fix, not the sender's, so it is told apart from a bad number.
    if (/quota/i.test((e as Error).message)) throw new OdisQuotaExhausted((e as Error).message);
    throw e;
  }

  // No `chain`: a read needs only the RPC, and importing viem/chains pulls
  // every chain definition into this route (and a webpack warning with it).
  const pub = createPublicClient({ transport: http(RPC) });
  const [, accounts, , issuedOns] = await pub.readContract({
    address: FEDERATED_ATTESTATIONS,
    abi: faAbi,
    functionName: "lookupAttestations",
    args: [obfuscated as `0x${string}`, [MINIPAY_ISSUER]],
  });
  if (!accounts.length) return null;

  let best = 0;
  for (let i = 1; i < accounts.length; i++) if (issuedOns[i] > issuedOns[best]) best = i;
  return getAddress(accounts[best]);
}
