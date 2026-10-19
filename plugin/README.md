# Remesso for Claude

Stablecoin payments on Celo for an AI agent: an agent wallet whose spending
is capped on-chain by its human, recurring payments under a Remesso mandate,
and pay-per-call x402 services.

```
/plugin install remesso --marketplace crackedstudio/Remesso
```

Needs Node.js 20 or later. The wallet is a local (stdio) MCP server, so it
runs in Claude Code and Cowork, not on claude.ai; the skills work everywhere.

## Set up

1. Ask Claude: *"Show my Remesso wallet."* The `wallet` tool creates the
   agent's key on your machine and answers with the agent's address and a
   setup link.
2. Open the link (`remesso.crackedstudios.xyz/agent-wallet?agent=0x…`) in
   MiniPay or a browser wallet. Choose USD₮, USDC or USA₮ and set the most for
   one payment, per day and in total, and for how long. Approve the two
   steps in your wallet.
3. Tell Claude the line the page shows, *"Link Remesso policy N"*.
4. Send the agent's address about 0.1 CELO for network fees.

Then: *"Pay 2 USDT to 0x…"*, *"Pay agent 9879 1 USDT"*, *"Get the naira rate
from Remesso, pay up to 0.01"*, *"What can you still spend today?"*

## Tools

| Tool | What it does |
|---|---|
| `wallet` | The agent's address, balances, linked limits; the setup link if none |
| `link_policy` | Records a spending policy after checking on-chain that it names this agent |
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

`mcp/server.mjs` is a bundle of `mcp/src/server.mjs` and its pinned
dependencies (`mcp/package-lock.json`), so the plugin runs without an install
step. To rebuild and compare: `cd mcp && npm ci && npm run build` writes `dist/server.mjs`, byte-identical to `server.mjs`. Contract,
tests and the web setup page are in the
[repository](https://github.com/crackedstudio/Remesso). MIT.
