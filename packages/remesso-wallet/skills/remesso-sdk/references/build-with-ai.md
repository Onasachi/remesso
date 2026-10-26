# Build with AI

> Give Claude Code, Codex, Cursor or any AI assistant the whole Remesso documentation, as a skill or as one text file.

Source: https://docs.remesso.xyz/docs/build-with-ai

Every page of this documentation is also published for AI assistants. Install the Remesso skills and your coding assistant reads the right page before it writes Remesso code, or give any chat the whole documentation as one text file.

## What's available

| | What it is | Use it with |
|---|---|---|
| The `remesso-sdk` skill | Every page of this documentation, and the rules for writing code with the SDK | Claude Code, Codex, Cursor and other assistants that load skills |
| [`llms-full.txt`](https://docs.remesso.xyz/llms-full.txt) | The whole documentation in one text file | Any chat: attach the file or give it the URL |
| [`llms.txt`](https://docs.remesso.xyz/llms.txt) | An index of the pages, each linked as Markdown | Tools that read [llms.txt](https://llmstxt.org) |
| Each page as Markdown | The page's URL with `.md` added, such as [`/docs/build-with-ai.md`](https://docs.remesso.xyz/docs/build-with-ai.md) | Putting one page into a prompt |

All of them are generated from these pages each time the documentation changes, so they describe the same version of the SDK.

## Install the skills

### Claude Code

Add Remesso's plugin. It carries the skills and the Remesso wallet:

```text
/plugin marketplace add https://bitbucket.org/crackedstudios/remesso.git
/plugin install remesso@remesso
```

To add only the skills, copy them into Claude Code's skills folder:

```bash
npx -y remesso-wallet skills ~/.claude/skills
```

### Codex, Cursor and others

```bash
npx -y remesso-wallet skills
```

This copies the skills to `~/.agents/skills`, where Codex and Cursor look. Give it a folder to put them somewhere else, such as a project's own skills folder. Restart the assistant to load them, and run the command again to update them.

### Any chat

Give the assistant `https://docs.remesso.xyz/llms-full.txt`, or attach the file. It holds every page, with the links between pages as full URLs.

## The skills

| Skill | For |
|---|---|
| `remesso-sdk` | Writing and reviewing code that uses `remesso-sdk` |
| `remesso` | An agent that pays and gets paid through Remesso's endpoints and contracts directly, without the SDK |
| `remesso-x402` | Paying Remesso's paid HTTP services over x402 |
| `remesso-wallet` | The tools of the Remesso wallet, described below |

An assistant loads a skill when your request matches it, so you don't need to name one.

## Prompts to try

- "Using remesso-sdk, ask 0x… to pay 5 USDT every week for four weeks, and print the link to send them."
- "Add a route to my Express server that receives Remesso webhooks and marks an order paid only after verifying the payment on the chain."
- "My agent sells translations. When another agent pays my invoice from its own wallet, deliver the order exactly once, and make retries safe."
- "Start a local fork with `npx remesso-sdk dev` and run my payment code against it."

## Let the assistant pay, too

The skills help an assistant write code. The Remesso wallet lets an assistant make payments itself: it is an MCP server with tools such as `pay`, `request_payment` and `pay_x402`, and it spends only within a [spending policy](./guides/agent-payments.md) you sign on-chain, with a cap per payment and per day and an expiry. You set the policy at [remesso.xyz/agent-wallet](https://remesso.xyz/agent-wallet).

It comes with the Claude Code plugin above. In other MCP hosts, add it as a server that runs:

```bash
npx -y remesso-wallet
```
