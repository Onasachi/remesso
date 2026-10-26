# Remesso for Claude

Stablecoin payments on Celo for an AI agent: an agent wallet whose spending
is capped on-chain by its human, recurring payments under a Remesso mandate,
and pay-per-call x402 services.

```
/plugin marketplace add https://bitbucket.org/crackedstudios/remesso.git
/plugin install remesso@remesso
```

In the Claude app (web, desktop, iOS, Android): **Customize → Plugins → Add**,
add the marketplace `https://bitbucket.org/crackedstudios/remesso`, install
**Remesso**, then connect **Remesso** on the plugin's **Connectors** tab. You
get the skills and the `remesso` connector, which turns payments and schedules
into links you sign in your own wallet and needs no sign-in or keys.

The agent wallet below is a local (stdio) MCP server and needs Node.js 20 or
later, so it runs in Claude Code and Cowork on a computer, not in the phone app.

## Set up

Run `/remesso:setup`, or ask Claude: *"Set up my Remesso wallet."*

1. Claude creates the agent's key on your machine and gives you a setup
   link (`remesso.xyz/agent-wallet?agent=0x…`).
2. Open it in MiniPay or a browser wallet. Choose USD₮, USDC or USA₮, set the
   most for one payment, per day and for how long, and approve the two steps
   in your wallet. Claude waits while you do, finds the policy on-chain
   by itself and shows a checklist: policy, your funds, network fees, and a
   test payment simulated without sending anything.
3. If the checklist asks for network fees, send the agent's address 0.10 of
   the same token (or 0.05 CELO).

Then: *"Pay 2 USDT to 0x…"*, *"Pay agent 9879 1 USDT"*, *"Get the naira rate
from Remesso, pay up to 0.01"*, *"What can you still spend today?"*

## Tools

| Tool | What it does |
|---|---|
| `wallet` | The agent's address and balances, and a readiness checklist with the one next step; the setup link if there is no policy |
| `await_setup` | Waits while you set the limits, then confirms the wallet is ready |
| `link_policy` | Links a policy by id; rarely needed, since policies naming the agent are found on their own |
| `limits` | What the agent may still spend now, read from the chain |
| `pay` | Sends USD₮, USDC or USA₮ from your wallet, within the policy |
| `pay_x402` | Pays an HTTP 402 (x402) price on Celo, never above `max_amount` |
| `request_payment` | Asks someone to pay the agent on a Remesso schedule (free) |
| `find_agent` | Looks up another agent's wallet in the ERC-8004 registry |

## Keys, money and the network

- **Your wallet's key never touches the plugin.** You set limits from your own
  wallet. The money stays there until a payment moves it.
- **The agent's key is generated on your machine** at first use, in
  `~/.remesso-agent/agent-key.json` (folder `0700`, file `0600`). No tool
  returns it, and nothing sends it anywhere. Deleting the folder discards the
  agent; its policies then can never be used.
- **Spending is capped by a contract, not by the prompt.**
  [`RemessoAgentAllowance`](https://celoscan.io/address/0xA6351fAeEb097698289586C4D6188530300DB209)
  on Celo mainnet refuses any payment over the per-payment or daily cap,
  after the expiry, after you revoke, or (if set) to an address not on your
  list, and it can never move more than the total you approved. It has no
  owner and no admin: nobody, including Remesso, can change your policy.
  Stop the agent any time from the setup page.
- **For x402**, the agent tops itself up from your wallet through the same
  policy and pays from its own balance, so those payments pass the same caps.
- **Network calls:** the Celo RPC (`forno.celo.org`, or `REMESSO_RPC_URL`),
  Remesso's API for `request_payment`
  (`engaboljiqudghvzmebq.supabase.co`), and only the x402 URLs you ask it to
  pay. Every transaction carries an ERC-8021 attribution tag
  (`remesso`).
- **Not audited.** The contract has 15 tests including a fuzz test of the
  daily cap, and an end-to-end run on mainnet, but no person has audited it.
  Keep limits small.

## Source

`mcp/server.mjs` is a bundle of `mcp/src/` (the wallet, and a minimal MCP
stdio server in `mcp.mjs`), the parts of the `remesso-sdk` source it uses
(`packages/remesso-sdk/src/`: payments, their records and recovery), viem and
the official x402 client, pinned by `mcp/package-lock.json`, so the plugin
runs without an install step. The
build then removes the EVM contract bytecode viem embeds for verifying
smart-wallet signatures, which this server never does
(`mcp/scripts/strip-bytecode.mjs` explains why). To rebuild and compare:
`cd mcp && npm ci && npm run build` writes `dist/server.mjs`, byte-identical
to `server.mjs`. Contract,
tests and the web setup page are in the
[repository](https://bitbucket.org/crackedstudios/remesso). MIT.
