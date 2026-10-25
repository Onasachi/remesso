# Remesso SDK documentation

The documentation site for [`remesso-sdk`](https://www.npmjs.com/package/remesso-sdk), built with [Docusaurus](https://docusaurus.io) 3.

```bash
cd docs-site
npm install
npm start          # http://localhost:3000, reloads on save
npm run build      # the static site, in build/
npm run serve      # serve build/ locally
```

Node 20 or later.

## What keeps it true

The docs describe a live payment system, and people act on what they read. Two checks keep the pages honest:

- **Every TypeScript block type-checks against the SDK's source.** From the repository root:

  ```bash
  deno run --allow-read --allow-write --allow-run --allow-env docs-site/scripts/check-snippets.ts
  ```

  A block can use the shared clients (`payer`, `receiver`, `agent`, `person`, `reader`) and ids (`requestId`, `scheduleId`, `policyId`) without declaring them. Mark a block `ts nocheck` only when it can't be valid TypeScript.

- **No address, token, decimal or limit is typed by hand.** Those tables render from `src/data/deployment.json`, a copy of `deployments/celo-mainnet.json` written by `scripts/build-docs-data.ts` (run from the repository root; `--check` fails on drift).

The build itself fails on a broken link or anchor.

## Layout

| Path | What it holds |
|---|---|
| `docs/` | The pages: get started, guides, use cases, API reference, resources. |
| `sidebars.ts` | The order of the pages. A new page needs an entry here. |
| `src/pages/index.tsx` | The landing page. |
| `src/components/Deployment.tsx` | The token, contract and endpoint tables. |
| `src/css/custom.css` | Remesso's brand on Docusaurus's theme. |
| `static/img/` | Logo, favicon and social card. |

## Writing

Plain, specific and short: one idea per sentence, second person, active voice, British spelling. Every claim about behaviour comes from the SDK's source, the backend's source or `CLAUDE.md`; when they disagree, the source wins. Pages are MDX, so a raw `<` or `{` in prose breaks the build: put it in inline code.
