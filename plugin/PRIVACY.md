# Remesso plugin — privacy

What the Remesso plugin for Claude does with data, as of 2026-10-19.

## What stays on your machine

- **The agent's private key**, generated at first use in
  `~/.remesso-agent/agent-key.json`. It is never sent anywhere, and no tool
  returns it to Claude.
- **The list of spending policies you linked**, in
  `~/.remesso-agent/config.json`.

Delete `~/.remesso-agent` to remove both.

## What leaves your machine, and to whom

| Sent to | When | What |
|---|---|---|
| A Celo RPC node (`forno.celo.org` by default, run by the Celo community, or your `REMESSO_RPC_URL`) | every tool that reads or writes the chain | public addresses, transactions signed by the agent, and your IP address, as with any RPC call |
| Celo mainnet | `pay`, and the top-up in `pay_x402` | the payment: sender, recipient, amount and an optional 32-character memo. Public and permanent, like every blockchain transaction |
| Remesso's API (`engaboljiqudghvzmebq.supabase.co`) | `request_payment` only | the payer's address, the agent's address, and the amount, token, cadence and note you give. Stored so the payer sees the request in the Remesso app |
| The x402 seller you name | `pay_x402` only | your request to that URL and a payment authorisation signed by the agent. That seller's own privacy terms apply |

The plugin sends no analytics or telemetry and keeps no logs of its own.
Remesso receives nothing from the plugin except `request_payment` calls.

## Contact

Questions: support@crackedstudios.xyz, or open an issue at <https://github.com/crackedstudio/Remesso/issues>.
