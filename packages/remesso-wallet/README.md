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

1. Ask the agent: *"Show my Remesso wallet."* The `wallet` tool creates the
   agent's key on your machine and answers with the agent's address and a
   setup link.
2. Open the link in MiniPay or a browser wallet. Choose USD₮, USDC or USA₮
   and set the most for one payment, per day and in total, and for how
   long. Approve the two steps in your wallet.
3. Tell the agent the line the page shows, *"Link Remesso policy N"*.
4. Send the agent's address about 0.1 CELO for network fees.

Then: *"Pay 2 USDT to 0x…"*, *"Pay agent 9879 1 USDT"*, *"What can you still
spend today?"*

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
