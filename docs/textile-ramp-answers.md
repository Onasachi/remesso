# Textile's answers on naira payouts (2026-10-15)

We asked Textile whether Remesso could pay naira straight into a recipient's
bank account through their v2 Ramp API. Their answers, and what each means.

| # | Question | Textile's answer | What it means for Remesso |
|---|---|---|---|
| 1 | Can the Ramp API serve Celo for cNGN → NGN? | No provider on Celo through the API. Noblocks in their app is an iframe, not an API. More API providers are coming, Celo included, with no ETA and "don't expect it in the next week or two". | **No API integration on Celo before the hackathon deadline.** Linking to Textile's app stays the way in. |
| 2 | Can the payout bank account be a third party's? | No. The customer created in Busha must own the bank account, and the same goes for Noblocks. | **A sender cannot pay naira into someone else's bank account.** The recipient must cash out to their own account, which is exactly how Remesso works today: the recipient receives cNGN or USDT and withdraws it themselves. |
| 3 | Can USDT sell straight to NGN? | No: swap to cNGN first. | Matches our USDT cash-out link (swap USDT→cNGN, then Withdraw NGN). |
| 4 | Is there a sandbox on Celo? | cNGN/USDT on BSC testnet has some liquidity, but test on Celo mainnet: two opposite small swaps cost little. | Test with real, small amounts on Celo. |
| 5 | Does a platform need a partner agreement or KYB? | No. | Nothing to sign to keep linking. |

## The decision this settles

Remesso does **not** pay naira into bank accounts. It pays tokens (cNGN,
USDT, …) into the recipient's wallet, and the recipient cashes out to a bank
account in their own name, through Textile.

That is not a workaround. It is what the providers require (answer 2), and it
keeps Remesso out of the money-transmission question that a third-party
payout raises. `docs/cngn-bank-payouts.md` (the cNGN API rail, off) and any
Paycrest third-party payout should be read in that light. Paycrest's
Noblocks would very likely carry the same ownership rule, so ask before
building on it.
