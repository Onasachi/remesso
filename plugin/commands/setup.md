---
description: Set up your Remesso agent wallet, its on-chain spending limits and network fees, and check it is ready to pay
---

Set up the Remesso agent wallet for the user, following the `remesso-wallet`
skill.

1. Call the `wallet` tool. Show the user the checklist it returns, one line
   per item, and the `next` step.
2. If `ready` is true, say the wallet is ready, show what it may spend
   (policy, caps, expiry), and suggest a first small payment. Stop there.
3. If there is no spending policy, give the user the `setupLink` and explain
   in two sentences what happens there: in MiniPay or a browser wallet they
   choose USD₮, USDC or USA₮, set the most for one payment, per day and for
   how long, and approve two steps. The money stays in their wallet, and they
   can press Stop on that page at any time. Then call `await_setup` at once
   and keep calling it while they finish; it links the policy by itself.
4. If network fees are missing, ask them to send the agent's address 0.10 of
   their policy's token, or 0.05 CELO, then call `wallet` again.
5. Finish with the full checklist and either "Ready" or the one thing left.

Never ask for a private key, a seed phrase or a policy number.

$ARGUMENTS
