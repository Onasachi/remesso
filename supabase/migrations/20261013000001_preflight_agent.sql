-- The pre-flight agent: looks at every payment due in the next day, decides
-- what will go wrong, tells the sender with the fix attached, and takes the
-- notice down itself once the problem is gone.
--
-- It never touches the money path. Payments are still executeRun by the
-- executor, gated by the contract; nothing here can move, delay or skip one.
-- A notice is advice to a human.

-- One open notice per (schedule, kind). The agent upserts while the condition
-- holds and stamps resolved_at when it no longer does — the sender sees a
-- notice disappear because they fixed it, not because they dismissed it.
create table public.schedule_notices (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null references public.schedules(id) on delete cascade,
  sender_id    uuid not null references public.senders(id) on delete cascade,
  kind         text not null,
  severity     text not null,
  -- The facts behind the decision (balance, allowance, due time, rate move),
  -- so the sentence the app shows is built from numbers, not stored prose.
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  resolved_at  timestamptz,

  constraint schedule_notices_kind_known check (kind in (
    'balance_short',        -- the next payment will be skipped: not enough in the wallet
    'allowance_short',      -- the next payment will be skipped: Remesso may not move enough
    'allowance_ending',     -- the next payment is covered, the one after is not
    'rate_moved'            -- a peso/real payment is worth noticeably more or less in dollars
  )),
  constraint schedule_notices_severity_known check (severity in ('info', 'warn', 'urgent'))
);

create unique index schedule_notices_one_open
  on public.schedule_notices (schedule_id, kind) where resolved_at is null;
create index schedule_notices_sender_open
  on public.schedule_notices (sender_id) where resolved_at is null;

alter table public.schedule_notices enable row level security;

-- Senders read their own; only the agent (service role) writes.
create policy schedule_notices_own_read on public.schedule_notices
  for select using (sender_id in (select id from public.senders where auth_user_id = auth.uid()));

-- Local-currency prices the agent has seen, one row per corridor per pass, so
-- "the peso moved 4% since yesterday" is a comparison with something it
-- actually measured, not a guess. Service role only.
create table public.rate_snapshots (
  id          bigint generated always as identity primary key,
  currency    text not null,           -- ARS | BRL
  local_per_usd numeric not null,
  source      text not null,
  taken_at    timestamptz not null default now()
);
create index rate_snapshots_lookup on public.rate_snapshots (currency, taken_at desc);
alter table public.rate_snapshots enable row level security;

-- Every half hour. Discovery-grade work, like sync-schedules: a payment due in
-- a day does not need minute-level attention.
select cron.unschedule('remesso-preflight')
where exists (select 1 from cron.job where jobname = 'remesso-preflight');

select cron.schedule(
  'remesso-preflight',
  '*/30 * * * *',
  $$ select public.invoke_edge_function('preflight'); $$
);
