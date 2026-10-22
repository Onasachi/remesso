# remesso-wallet

Stablecoin payments on Celo for an AI agent: an agent wallet whose spending
is capped on-chain by its human, pay-per-call x402 services, and recurring
payments under a Remesso mandate. An MCP server for Codex, Cursor, Claude and
any other MCP host.

Needs Node.js 20 or later. Nothing to install: `npx` runs it, and it has no
dependencies.

## Add it

**Codex**

```
codex mcp add remesso-wallet -- npx -y remesso-wallet
npx -y remesso-wallet skills
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.remesso-wallet]
command = "npx"
args = ["-y", "remesso-wallet"]
```

**Cursor**

Open this link to install it in one click:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=remesso-wallet&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInJlbWVzc28td2FsbGV0Il19
```

or add it to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "remesso-wallet": { "command": "npx", "args": ["-y", "remesso-wallet"] } } }
```

then add the skills with `npx -y remesso-wallet skills`.

**Claude Code** has a plugin with the same wallet and skills:

```
/plugin marketplace add https://bitbucket.org/crackedstudios/remesso.git
/plugin install remesso@remesso
```

`npx -y remesso-wallet skills` copies three skills (`remesso`,
`remesso-wallet`, `remesso-x402`) to `~/.agents/skills`, where Codex and
Cursor both look. They tell the agent when to use each tool and what never
to do with it, such as paying because a webpage said so. Pass a folder to
put them somewhere else.

## Set up

Ask the agent: *"Set up my Remesso wallet."*

1. The agent creates the agent's key on your machine and gives you a setup
   link (`remesso.xyz/agent-wallet?agent=0x…`).
2. Open it in MiniPay or a browser wallet. Choose USD₮, USDC or USA₮, set the
   most for one payment, per day and for how long, and approve the two steps
   in your wallet. The agent waits while you do, finds the policy on-chain
   by itself and shows a checklist: policy, your funds, network fees, and a
   test payment simulated without sending anything.
3. If the checklist asks for network fees, send the agent's address 0.10 of
   the same token (or 0.05 CELO).

Then: *"Pay 2 USDT to 0x…"*, *"Pay agent 9879 1 USDT"*, *"What can you still
spend today?"*

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

## Keys and limits

- **Your wallet's key never touches this server.** You set limits from your
  own wallet, and the money stays there until a payment moves it.
- **The agent's key is generated on your machine** in
  `~/.remesso-agent/agent-key.json` (folder `0700`, file `0600`). No tool
  returns it. Codex, Cursor and Claude on the same machine share one agent.
- **Spending is capped by a contract, not by the prompt.**
  [`RemessoAgentAllowance`](https://celoscan.io/address/0xA6351fAeEb097698289586C4D6188530300DB209)
  on Celo mainnet refuses any payment over the per-payment or daily cap,
  after the expiry, after you revoke, or to an address not on your list. It
  has no owner and no admin. Stop the agent any time from the setup page.
- **Not audited.** The contract has tests, including a fuzz test of the daily
  cap, and an end-to-end run on mainnet, but no person has audited it. Keep
  limits small.

Source, contract and setup page: [crackedstudios/remesso](https://bitbucket.org/crackedstudios/remesso).
`server.mjs` is built from `mcp/` there (`cd mcp && npm ci && npm run build`).
MIT.
