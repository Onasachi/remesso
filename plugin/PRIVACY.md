# Remesso plugin — privacy

What the Remesso plugin for Claude does with data, as of 2026-10-26.

## What stays on your machine

- **The agent's private key**, generated at first use in
  `~/.remesso-agent/agent-key.json`. It is never sent anywhere, and no tool
  returns it to Claude.
- **The list of spending policies you linked**, in
  `~/.remesso-agent/config.json`.
- **A record of each payment the agent signs**, in
  `~/.remesso-agent/sdk-payments.json` and `sdk-remittances.json` (older
  versions: `payments.json`): its hash, nonce and signed bytes, so a retry
  pays once. Readable only by your user account.

Delete `~/.remesso-agent` to remove them. Deleting the payment records also
removes the protection against paying twice on a retry.

## What leaves your machine, and to whom

| Sent to | When | What |
|---|---|---|
| A Celo RPC node (`forno.celo.org` by default, run by the Celo community, or your `REMESSO_RPC_URL`) | every tool that reads or writes the chain | public addresses, transactions signed by the agent, and your IP address, as with any RPC call |
| Celo mainnet | `pay`, and the top-up in `pay_x402` | the payment: sender, recipient, amount and an optional 32-character memo. Public and permanent, like every blockchain transaction |
| Remesso's API (`engaboljiqudghvzmebq.supabase.co`) | `request_payment` | the payer's address, the agent's address, and the amount, token, cadence and note you give. Stored so the payer sees the request in the Remesso app |
| Remesso's API | `payment_requests` and `decline_request` | your human's wallet address, to list the requests addressed to it; a declined request's id and the agent's signed decline |
| Remesso's API | `pay`, the top-up in `pay_x402`, and the read tools that look up policies | the agent's address, to find the spending policies that name it, and a request's id when you pay one. Nothing is stored for these reads |
| The x402 seller you name | `pay_x402` only | your request to that URL and a payment authorisation signed by the agent. That seller's own privacy terms apply |
| Remesso's connector (`remesso.xyz/mcp`), bundled since 0.3.1 | its tools, when Claude calls them | the addresses and amounts you give it. If you sign in there for hands-free payments, your email too; see the [Remesso privacy policy](https://remesso.xyz/privacy) |

The plugin sends no analytics or telemetry and keeps no logs of its own.
The local wallet sends Remesso only what the table above lists; the bundled connector is a Remesso service, covered by the Remesso privacy policy.

## Contact

Questions: support@crackedstudios.xyz, or open an issue at <https://bitbucket.org/crackedstudios/remesso/issues>.
