import type { TokenInfo } from "./config";

/// A link into Textile's app for turning a dollar payment into naira in a
/// Nigerian bank account: swap to cNGN on Celo, then "Withdraw NGN", paid out
/// by Noblocks (₦0.9996 per cNGN when checked, 14 Oct 2026).
///
/// A link and nothing more, like Ripio's (lib/ripio.ts): the recipient opens
/// Textile with their own wallet and does both steps themselves. Remesso
/// instructs no naira payout, so the cNGN rails stay off and the
/// money-transmission question they carry is untouched (CLAUDE.md, "Two
/// rails").
///
/// Only USDT. Checked in Textile's app on Celo: USDT → cNGN quotes (1,362.62
/// cNGN per USD₮, 0.002 fee on 20); USDC, USDm and USA₮ answer "No supported
/// swap pairs". The swap page already offers "Withdraw NGN" beside the
/// result, so one link covers both steps. `chainId` matters: without it the
/// app opens on BNB Smart Chain.
export function textileNairaCashOut(token: TokenInfo, amount?: string): string | null {
  if (token.symbol !== "USDT") return null;
  const q = new URLSearchParams({ sell: "USDT", buy: "cNGN", chainId: "42220" });
  if (amount && Number(amount) > 0) q.set("amount", amount);
  return `https://app.textilecredit.com/s/swap?${q}`;
}

/// Textile's "Withdraw NGN" for cNGN already held on Celo — the second step of
/// the cash-out above, for a wallet that has cNGN already. Same terms: a link,
/// done on Textile with the holder's own wallet. Checked 14 Oct 2026: opens
/// "Withdraw NGN · From your cNGN balance on Celo", offer from Noblocks.
/// Textile ignores an amount here, so none is passed.
export const TEXTILE_NAIRA_WITHDRAW = "https://app.textilecredit.com/s/sell?chainId=42220";
