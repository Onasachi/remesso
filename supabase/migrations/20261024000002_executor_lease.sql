-- One sender at a time for the executor key, and one place that knows its
-- nonce.
--
-- execute-due-runs and trigger-run both sign with the executor's hot key, and
-- neither managed nonces. A paid early send landing in the middle of a cron
-- pass could take the nonce the cron had just fetched, and one of the two
-- transactions failed, possibly after the early send's payer was charged
-- (docs/agent-to-agent.md, 1c).
--
-- A lease row, not an advisory lock: supabase-js talks to PostgREST, which
-- doesn't keep one database session between requests, so a session lock taken
-- in one call is gone by the next. Each function holds the lease from fetching
-- the nonce until its transaction is mined, a few seconds, and it expires on
-- its own if the holder dies.

create table public.executor_leases (
  -- The executor EOA whose nonce is guarded, lowercased. Not the contract:
  -- the nonce belongs to the key.
  executor   text primary key check (executor = lower(executor)),
  holder     text,
  expires_at timestamptz not null default '-infinity',
  -- The highest nonce a holder saw mined. The next holder signs at least one
  -- past it, because right after a transaction lands, a node behind forno's
  -- load balancer can still answer with the old count.
  last_nonce bigint
);

-- Service role only: no policies.
alter table public.executor_leases enable row level security;

-- `taken` when `p_holder` holds the lease after the call: it was free, it had
-- expired, or it was already theirs (taking it again extends it).
-- `mined_nonce` is the floor described above, null until a first release.
create or replace function public.take_executor_lease(p_executor text, p_holder text, p_seconds int)
returns table (taken boolean, mined_nonce bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_nonce bigint;
begin
  insert into public.executor_leases as l (executor, holder, expires_at)
  values (lower(p_executor), p_holder, now() + make_interval(secs => p_seconds))
  on conflict (executor) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where l.expires_at < now() or l.holder = excluded.holder
  returning l.last_nonce into v_nonce;

  if found then
    return query select true, v_nonce;
  else
    return query select false, null::bigint;
  end if;
end;
$$;

-- Free the lease and record the nonce its holder saw mined, if any. Only the
-- holder can: one whose lease expired and was taken by someone else changes
-- nothing.
create or replace function public.release_executor_lease(
  p_executor text,
  p_holder text,
  p_mined_nonce bigint default null
)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.executor_leases
     set holder = null,
         expires_at = '-infinity',
         last_nonce = greatest(last_nonce, p_mined_nonce)
   where executor = lower(p_executor) and holder = p_holder;
$$;

revoke all on function public.take_executor_lease(text, text, int) from public, anon, authenticated;
revoke all on function public.release_executor_lease(text, text, bigint) from public, anon, authenticated;
grant execute on function public.take_executor_lease(text, text, int) to service_role;
grant execute on function public.release_executor_lease(text, text, bigint) to service_role;
