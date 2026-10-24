-- How far behind the head do Celo's `safe` and `finalized` blocks run?
--
-- Phase 0 of the agent-to-agent plan (docs/agent-to-agent-implementation.md).
-- Phase 3 indexes payment events and tells receivers whether each one is
-- final, so "final" needs a depth measured on Celo, not one borrowed from
-- another chain. One reading on 2026-10-24 had forno's `safe` ~4 minutes and
-- `finalized` ~23 minutes behind `latest`. One reading is not a rule.
--
-- Temporary. The sampler stops itself after about 48 hours (the last job
-- below). The table and the function go once the depth is in CLAUDE.md.
-- `scripts/finality-report.ts` reads the rows; nothing else does.

create table public.finality_samples (
  id               bigint generated always as identity primary key,
  sampled_at       timestamptz not null default now(),
  -- Each head as the RPC reported it. The hashes let the report check, after
  -- the fact, whether a block seen at a head was later replaced: the lag says
  -- how long finality takes, a replaced hash says whether waiting ever
  -- mattered. `safe` and `finalized` are nullable so a node that briefly
  -- doesn't answer a tag still leaves a reading of the head.
  latest_number    bigint not null,
  latest_hash      text not null,
  latest_time      timestamptz not null,
  safe_number      bigint,
  safe_hash        text,
  safe_time        timestamptz,
  finalized_number bigint,
  finalized_hash   text,
  finalized_time   timestamptz
);
create index finality_samples_sampled_at on public.finality_samples (sampled_at);

-- Service role only: no policies.
alter table public.finality_samples enable row level security;

-- Every minute. A block a second makes that 60 blocks between readings, fine
-- against lags of hundreds of blocks; the question is the spread over a day,
-- not the exact second.
select cron.unschedule('remesso-measure-finality')
where exists (select 1 from cron.job where jobname = 'remesso-measure-finality');

select cron.schedule(
  'remesso-measure-finality',
  '* * * * *',
  $$ select public.invoke_edge_function('measure-finality'); $$
);

-- The stop: 2026-10-26 20:00 UTC, about 48 hours after this was pushed. It
-- removes the sampler and then itself, so it fires once even though the
-- expression would match again next year. The report can run on the first 24
-- hours while the second day accumulates.
select cron.unschedule('remesso-measure-finality-stop')
where exists (select 1 from cron.job where jobname = 'remesso-measure-finality-stop');

select cron.schedule(
  'remesso-measure-finality-stop',
  '0 20 26 10 *',
  $$ select cron.unschedule(jobname) from cron.job
     where jobname in ('remesso-measure-finality', 'remesso-measure-finality-stop'); $$
);
