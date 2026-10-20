import { getAccount, switchChain } from "wagmi/actions";
import { activeChain, isMiniPay, wagmiConfig } from "./wagmi";
import { attributionSuffix } from "./attribution";

/// Put the wallet on Celo before it signs. Browser wallets often sit on
/// Ethereum or another chain, and a transaction there would fail or go
/// nowhere. wagmi's injected connector asks the wallet to switch, and if the
/// wallet has never heard of Celo it offers to add it (wallet_addEthereumChain),
/// so nobody types RPC URLs and chain ids by hand. MiniPay is Celo-only.
export async function ensureCelo(): Promise<void> {
  if (isMiniPay()) return;
  if (getAccount(wagmiConfig).chainId === activeChain.id) return;
  await switchChain(wagmiConfig, { chainId: activeChain.id });
}

/// Transaction overrides for the connected wallet.
///
/// MiniPay accepts legacy (type 0) transactions only — it rejects EIP-1559 and
/// handles gas itself through fee abstraction. viem's `celo` chain ships CIP-64
/// serializers and will otherwise produce a typed transaction, so every
/// signature in the app would fail inside the one wallet this product is built
/// for.
///
/// Applied only in MiniPay: a desktop wallet on Celo is better off with the
/// chain's own fee handling than with a legacy transaction we forced on it.
/// Also carries the Celo attribution tag, because every wallet write in this
/// app already spreads these overrides — which makes this the one place a tag
/// cannot be forgotten on a new transaction.
export function txOverrides(): { type?: "legacy"; dataSuffix?: `0x${string}` } {
  const suffix = attributionSuffix();
  return {
    ...(isMiniPay() ? { type: "legacy" as const } : {}),
    ...(suffix ? { dataSuffix: suffix } : {}),
  };
}
