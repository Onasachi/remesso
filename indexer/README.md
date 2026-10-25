# indexer — Goldsky subgraph over `RemessoExecutorV5` and `RemessoAgentAllowance`

An [instant subgraph](https://docs.goldsky.com/subgraphs/reference/instant-subgraph):
generated from the ABI, no mapping handlers. Every event the contracts emit
becomes an entity (`runExecuteds`, `scheduleCreateds`, `scheduleCancelleds`,
…) with Goldsky's own `block_number`, `timestamp_`, `transactionHash_`
fields. The event parameter named `id` is exposed as `idParam`, because `id`
is the entity key.

| | |
|---|---|
| project | `project_cmub9zi745rtc01ts1xx66zy6` |
| subgraph | `remesso-celo-celo/1.0.1` — V5 (`0x3C357af3…bEd8`), deployed 2026-10-16 with `goldsky subgraph deploy remesso-celo/1.0.1 --from-abi goldsky.json` (the CLI appends the chain to the name). Tagged `prod`. The dashboard-deployed `remesso-celo/1.0.0` indexed V3 only. |
| endpoint | `https://api.goldsky.com/api/public/project_cmub9zi745rtc01ts1xx66zy6/subgraphs/remesso-celo-celo/prod/gn` — through the `prod` tag, so the next version is `goldsky subgraph tag create remesso-celo-celo/<v> --tag prod`, not an env change |
| chain | `celo` (42220), from block `80268721` — V5's deployment block |
| next | `1.1.0` adds `RemessoAgentAllowance` (`0xA635…B209`) from its deployment block `80467202`. In `goldsky.json`, not deployed yet. |

**The allowance contract's policies, by owner (`1.1.0`).** Its four events
become `policyCreateds`, `paids`, `recipientSets` and `policyRevokeds`. A
policy's `owner` and `agent` are on `policyCreateds`, so a person's policies
are one query instead of a scan of every id. Nothing reads them yet: the
setup screen and the hosted connector read every id in multicall batches
(`web/lib/policies.ts`), which is exact and costs a call per 250 policies.
This is for when that stops being cheap. The event names don't collide with
V5's, so both contracts share one subgraph.

**One executor per subgraph, and the app knows it.** Schedule ids restart at 1
in every deployment, so `useOnchainRuns` only asks the subgraph about
schedules whose `executor_address` is the configured executor. Before
2026-10-16 it asked about every schedule, and a V4 schedule's page could show
the V3 schedule with the same number.

Deployed from the Goldsky dashboard, which keeps the name as typed. The CLI
(`--from-abi`) appends the chain instead, which is where a `remesso-celo-celo`
name would come from. Measured 2026-09-21: 4 blocks behind head at Celo's 1s
block time.

**The URL is version-pinned**, because a dashboard deploy creates no tag. A
future `1.1.0` therefore needs `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL` changed too,
unless a `prod` tag is created first and the URL switched to it:

```bash
goldsky subgraph tag create remesso-celo/1.1.0 --tag prod
```

## What reads it

`web/lib/goldsky.ts` → `useHistory` in `web/lib/hooks.ts`, merged with the
`runs` table by `web/lib/history.ts`. The frontend only, and only to show a
run sooner than the database does. Nothing that decides whether a run pays
reads it — `execute-due-runs` does not know it exists.

The URL is `NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL`. Unset it and the history is
the database alone.

## Redeploying

Only needed when the contract changes (a new executor address is a new
instance in `goldsky.json`, with its own start block) or the ABI does.

```bash
cd contracts && forge build
jq '.abi' contracts/out/RemessoExecutorV5.sol/RemessoExecutorV5.json > indexer/abis/RemessoExecutorV5.json
jq '.abi' contracts/out/RemessoAgentAllowance.sol/RemessoAgentAllowance.json > indexer/abis/RemessoAgentAllowance.json
cd indexer && goldsky subgraph deploy remesso-celo/1.1.0 --from-abi goldsky.json
goldsky subgraph tag create remesso-celo-celo/1.1.0 --tag prod
```

Note the CLI appends the chain: deploying `remesso-celo/1.1.0` this way
produces `remesso-celo-celo/1.1.0`, a *different* subgraph from the
dashboard-deployed `remesso-celo/1.0.0` the app currently reads. Tag whichever
one you intend to serve, and point the env var at it.

Deployment block, if it is ever needed again: binary-search `cast code
<addr> --block N` on forno.

## Checking it

```bash
curl -s "$NEXT_PUBLIC_GOLDSKY_SUBGRAPH_URL" -H 'content-type: application/json' \
  -d '{"query":"{ _meta { block { number } hasIndexingErrors } runExecuteds(first:3, orderBy: block_number, orderDirection: desc){ idParam runsExecuted transactionHash_ block_number } }"}' | jq .
```

Compare `_meta.block.number` with `cast block-number --rpc-url https://forno.celo.org`.
