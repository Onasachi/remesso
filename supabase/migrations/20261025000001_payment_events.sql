-- One durable record of what the chain says happened to Remesso's payments
-- (docs/agent-to-agent.md, 3b).
--
-- A payment can reach a recipient by three paths, and only one of them passed
-- through our functions: the cron's runs. An early send by a trigger the
-- sender named, and a policy payment from an agent's wallet, never touched
-- them. So the record is read from the chain, every path alike, by
-- `index-events`: V5's runs and schedules, and the allowance contract's
-- payments and policies.
--
-- The rules it keeps:
--   - one row per log, keyed by chain, tx hash and log index;
--   - events and the cursor move together, in one call, and only from where
--     the cursor was, so two overlapping passes can't both write;
--   - a row says whether it is final: at or below the RPC's `finalized` block
--     (Phase 0, first 12.5 hours of readings: a median 23 minutes behind the
--     head, 31 at most, and not one block replaced at any level);
--   - a reorg marks rows `removed` rather than deleting them, so a receiver
--     who was told about one can be told it went away;
--   - `seq` moves on every change, recorded, final or removed, so a reader
--     that remembers the last `seq` it saw misses nothing.

create sequence public.payment_events_seq;

create table public.payment_events (
  chain_id     integer not null,
  tx_hash      text    not null,
  log_index    integer not null,
  contract     text    not null check (contract = lower(contract)),
  kind         text    not null,
  -- The schedule id on V5, or the policy id on the allowance contract.
  ref_id       numeric(78,0) not null,
  -- Lowercased addresses. `from` is the payer (the schedule's sender, the
  -- policy's owner), `to` the recipient, `agent` the policy's agent.
  from_address text,
  to_address   text,
  agent        text,
  -- The asset that moved: for a run, what the recipient received (the
  -- schedule's token on the Direct rail, its payout token on the swap rails).
  token        text,
  -- What the recipient received, after the commission. `amount_in` is a
  -- run's gross, before it.
  amount       numeric(78,0),
  amount_in    numeric(78,0),
  -- A policy payment's bytes32 memo, and the same as text when it is
  -- printable ASCII: a payment request's reference rides here.
  memo         text,
  memo_text    text,
  run_number   integer,
  -- A run brought forward by `runNow` (a RunTriggered in the same transaction).
  early        boolean,
  -- The event's other fields: a schedule's cadence and expiry, a policy's caps.
  details      jsonb   not null default '{}'::jsonb,
  block_number bigint  not null,
  block_hash   text    not null,
  block_time   timestamptz not null,
  final        boolean not null default false,
  removed      boolean not null default false,
  seq          bigint  not null default nextval('public.payment_events_seq'),
  recorded_at  timestamptz not null default now(),
  primary key (chain_id, tx_hash, log_index),
  constraint payment_events_kind_known check (kind in (
    'run',              -- V5 RunExecuted
    'schedule_created', -- V5 ScheduleCreated
    'policy_payment',   -- RemessoAgentAllowance Paid
    'policy_created',   -- RemessoAgentAllowance PolicyCreated
    'policy_revoked'    -- RemessoAgentAllowance PolicyRevoked
  ))
);

create unique index payment_events_seq_unique on public.payment_events (seq);
create index payment_events_to on public.payment_events (to_address, seq);
create index payment_events_from on public.payment_events (from_address, seq);
create index payment_events_agent on public.payment_events (agent, seq) where agent is not null;
create index payment_events_ref on public.payment_events (contract, kind, ref_id);
create index payment_events_pending on public.payment_events (contract, block_number) where not final and not removed;

-- Service role only: no policies. `payment-events` serves reads.
alter table public.payment_events enable row level security;

-- Where `index-events` has read to, per contract, with that block's hash so a
-- reorg under it is noticed before anything is read on top.
create table public.chain_cursors (
  chain_id     integer not null,
  contract     text    not null check (contract = lower(contract)),
  block_number bigint  not null,
  -- Null only for a seed: nothing read yet, so nothing to compare.
  block_hash   text,
  updated_at   timestamptz not null default now(),
  primary key (chain_id, contract)
);
alter table public.chain_cursors enable row level security;

-- Each contract from the block before its deployment.
insert into public.chain_cursors (chain_id, contract, block_number) values
  (42220, '0x3c357af3300f383ea49b6d6ed8e084199a92bed8', 80268720),  -- RemessoExecutorV5, deployed at 80,268,721
  (42220, '0xa6351faeeb097698289586c4d6188530300db209', 80467201);  -- RemessoAgentAllowance, deployed at 80,467,202

-- A batch of events and the cursor's new position, together. Refused if the
-- cursor is no longer where the batch began. Also marks every event at or
-- below `p_finalized` final. Returns the number of rows written.
create or replace function public.record_payment_events(
  p_chain_id   integer,
  p_contract   text,
  p_from_block bigint,
  p_from_hash  text,
  p_to_block   bigint,
  p_to_hash    text,
  p_finalized  bigint,
  p_events     jsonb
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update public.chain_cursors
     set block_number = p_to_block, block_hash = p_to_hash, updated_at = now()
   where chain_id = p_chain_id and contract = lower(p_contract)
     and block_number = p_from_block and block_hash is not distinct from p_from_hash;
  if not found then
    raise exception 'chain cursor moved under this batch' using errcode = '40001';
  end if;

  insert into public.payment_events as pe (
    chain_id, tx_hash, log_index, contract, kind, ref_id, from_address, to_address, agent, token,
    amount, amount_in, memo, memo_text, run_number, early, details, block_number, block_hash, block_time, final
  )
  select p_chain_id, lower(e.tx_hash), e.log_index, lower(p_contract), e.kind, e.ref_id,
         lower(e.from_address), lower(e.to_address), lower(e.agent), lower(e.token),
         e.amount, e.amount_in, e.memo, e.memo_text, e.run_number, e.early, coalesce(e.details, '{}'::jsonb),
         e.block_number, lower(e.block_hash), e.block_time, e.block_number <= p_finalized
    from jsonb_to_recordset(p_events) as e(
      tx_hash text, log_index integer, kind text, ref_id numeric, from_address text, to_address text,
      agent text, token text, amount numeric, amount_in numeric, memo text, memo_text text,
      run_number integer, early boolean, details jsonb, block_number bigint, block_hash text, block_time timestamptz
    )
  -- A row a reorg removed comes back if its transaction is mined again; a
  -- live row is left as it is.
  on conflict (chain_id, tx_hash, log_index) do update
     set block_number = excluded.block_number, block_hash = excluded.block_hash, block_time = excluded.block_time,
         final = excluded.final, removed = false, seq = nextval('public.payment_events_seq')
   where pe.removed;
  get diagnostics n = row_count;

  update public.payment_events
     set final = true, seq = nextval('public.payment_events_seq')
   where chain_id = p_chain_id and contract = lower(p_contract)
     and not final and not removed and block_number <= p_finalized;

  return n;
end;
$$;

-- A reorg under the cursor: every event above `p_to_block`, the last block
-- both sides agree on, is marked removed, and the cursor moves back there.
-- Refused if that would reach a final event: finality is a promise already
-- made to receivers, and breaking it needs a person.
create or replace function public.rollback_payment_events(
  p_chain_id   integer,
  p_contract   text,
  p_from_block bigint,
  p_from_hash  text,
  p_to_block   bigint,
  p_to_hash    text
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if exists (
    select 1 from public.payment_events
     where chain_id = p_chain_id and contract = lower(p_contract) and final and not removed and block_number > p_to_block
  ) then
    raise exception 'reorg reaches a final event at or above block %', p_to_block + 1;
  end if;

  update public.chain_cursors
     set block_number = p_to_block, block_hash = p_to_hash, updated_at = now()
   where chain_id = p_chain_id and contract = lower(p_contract)
     and block_number = p_from_block and block_hash is not distinct from p_from_hash;
  if not found then
    raise exception 'chain cursor moved under this rollback' using errcode = '40001';
  end if;

  update public.payment_events
     set removed = true, seq = nextval('public.payment_events_seq')
   where chain_id = p_chain_id and contract = lower(p_contract) and not removed and block_number > p_to_block;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.record_payment_events(integer, text, bigint, text, bigint, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.rollback_payment_events(integer, text, bigint, text, bigint, text) from public, anon, authenticated;
grant execute on function public.record_payment_events(integer, text, bigint, text, bigint, text, bigint, jsonb) to service_role;
grant execute on function public.rollback_payment_events(integer, text, bigint, text, bigint, text) to service_role;

-- Every minute, like the executor: a receiver waiting for a payment should
-- hear within a minute of it landing.
select cron.unschedule('remesso-index-events')
where exists (select 1 from cron.job where jobname = 'remesso-index-events');

select cron.schedule(
  'remesso-index-events',
  '* * * * *',
  $$ select public.invoke_edge_function('index-events'); $$
);
