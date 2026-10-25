-- Webhooks: payments to an address, announced to that address's own server
-- (docs/agent-to-agent.md, 3c).
--
-- `deliver-webhooks` reads `payment_events` after each subscription's cursor
-- and sends Standard Webhooks messages: payment.received, payment.finalized
-- and payment.removed (a reorg took back one it had announced). Delivery is at
-- least once: the message id stays the same on every retry, and receivers
-- deduplicate on it. cNGN's webhooks fire once and are lost on a 500 (trap 3
-- in CLAUDE.md); nothing here makes a receiver depend on one attempt.
--
-- Only the address can manage its subscriptions, by EIP-712 signature checked
-- in `webhooks`. A signing secret lives in Supabase Vault, never in a table
-- column, and leaves the database only inside `claim_webhook_deliveries`.

create table public.webhook_subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  -- The receiving address whose payments are announced, lowercased.
  address            text not null check (address ~ '^0x[0-9a-f]{40}$'),
  url                text not null check (url like 'https://%' and length(url) <= 512),
  -- vault.secrets ids. During a rotation the previous secret keeps signing
  -- alongside the new one until `previous_until`, so a receiver has a day to
  -- switch.
  secret_id          uuid not null,
  previous_secret_id uuid,
  previous_until     timestamptz,
  -- pending: created, the endpoint not yet proven willing (the challenge).
  state              text not null default 'pending' check (state in ('pending', 'active', 'revoked')),
  verified_at        timestamptz,
  -- The last payment_events.seq looked at. Starts at the newest when the
  -- subscription is made, so a new endpoint isn't flooded with history.
  cursor_seq         bigint not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index webhook_subscriptions_live on public.webhook_subscriptions (address, url) where state <> 'revoked';
create index webhook_subscriptions_active on public.webhook_subscriptions (address) where state = 'active';
alter table public.webhook_subscriptions enable row level security;

-- A signed request's nonce, once used, until its signature has expired.
create table public.webhook_nonces (
  address    text not null,
  nonce      text not null,
  expires_at timestamptz not null,
  primary key (address, nonce)
);
alter table public.webhook_nonces enable row level security;

create table public.webhook_deliveries (
  -- The Standard Webhooks message id: the same on every attempt.
  id                text primary key default ('msg_' || replace(gen_random_uuid()::text, '-', '')),
  subscription_id   uuid not null references public.webhook_subscriptions (id) on delete cascade,
  chain_id          integer not null,
  tx_hash           text not null,
  log_index         integer not null,
  -- The block the event was in when this was queued. A transaction a reorg
  -- removed and a later block re-mined is news again, so it is part of what
  -- makes a delivery unique.
  block_hash        text not null,
  type              text not null check (type in ('payment.received', 'payment.finalized', 'payment.removed')),
  -- Built when queued, so every attempt sends the same body.
  payload           jsonb not null,
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  -- Retries run for 24 hours from here; a replay starts a new window.
  window_started_at timestamptz not null default now(),
  delivered_at      timestamptz,
  failed_at         timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  foreign key (chain_id, tx_hash, log_index) references public.payment_events (chain_id, tx_hash, log_index),
  unique (subscription_id, chain_id, tx_hash, log_index, block_hash, type)
);
create index webhook_deliveries_due on public.webhook_deliveries (next_attempt_at)
  where delivered_at is null and failed_at is null;
alter table public.webhook_deliveries enable row level security;

-- ---- managing a subscription (called by `webhooks`, after the signature) ----

-- At most five live (pending or active) subscriptions per address, counted
-- under a lock so two requests can't both take the last slot. A pending one
-- for the same url is an earlier attempt whose challenge never finished, and
-- is replaced. Returns the new id, or a problem: already_subscribed, limit.
create or replace function public.create_webhook_subscription(p_address text, p_url text, p_secret text)
returns table (subscription_id uuid, problem text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_address text := lower(p_address);
  v_old     public.webhook_subscriptions;
  v_secret  uuid;
  v_id      uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('webhooks:' || v_address, 0));

  select * into v_old from public.webhook_subscriptions where address = v_address and url = p_url and state <> 'revoked';
  if found then
    if v_old.state = 'active' then
      return query select null::uuid, 'already_subscribed'::text;
      return;
    end if;
    delete from vault.secrets where id in (v_old.secret_id, v_old.previous_secret_id);
    delete from public.webhook_subscriptions where id = v_old.id;
  end if;

  if (select count(*) from public.webhook_subscriptions where address = v_address and state <> 'revoked') >= 5 then
    return query select null::uuid, 'limit'::text;
    return;
  end if;

  v_secret := vault.create_secret(p_secret, null, 'Remesso webhook signing secret');
  insert into public.webhook_subscriptions (address, url, secret_id, cursor_seq)
  values (v_address, p_url, v_secret, coalesce((select max(seq) from public.payment_events), 0))
  returning id into v_id;
  return query select v_id, null::text;
end;
$$;

-- The endpoint echoed the challenge.
create or replace function public.activate_webhook_subscription(p_id uuid)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.webhook_subscriptions
     set state = 'active', verified_at = now(), updated_at = now()
   where id = p_id and state = 'pending';
$$;

-- The endpoint didn't echo the challenge: nothing is kept.
create or replace function public.discard_webhook_subscription(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.webhook_subscriptions;
begin
  delete from public.webhook_subscriptions where id = p_id and state = 'pending' returning * into v;
  if found then
    delete from vault.secrets where id in (v.secret_id, v.previous_secret_id);
  end if;
end;
$$;

-- A new secret; the old one keeps signing alongside it for a day. Returns
-- until when, or null if there is no active subscription for that url.
create or replace function public.rotate_webhook_secret(p_address text, p_url text, p_secret text)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v       public.webhook_subscriptions;
  v_new   uuid;
  v_until timestamptz := now() + interval '24 hours';
begin
  select * into v from public.webhook_subscriptions
   where address = lower(p_address) and url = p_url and state = 'active' for update;
  if not found then
    return null;
  end if;
  if v.previous_secret_id is not null then
    delete from vault.secrets where id = v.previous_secret_id;
  end if;
  v_new := vault.create_secret(p_secret, null, 'Remesso webhook signing secret');
  update public.webhook_subscriptions
     set previous_secret_id = secret_id, previous_until = v_until, secret_id = v_new, updated_at = now()
   where id = v.id;
  return v_until;
end;
$$;

-- Stop: nothing more is sent, what was waiting is marked failed, and the
-- secrets are destroyed. True if there was something to revoke.
create or replace function public.revoke_webhook_subscription(p_address text, p_url text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.webhook_subscriptions;
begin
  update public.webhook_subscriptions set state = 'revoked', updated_at = now()
   where address = lower(p_address) and url = p_url and state <> 'revoked'
  returning * into v;
  if not found then
    return false;
  end if;
  delete from vault.secrets where id in (v.secret_id, v.previous_secret_id);
  update public.webhook_deliveries set failed_at = now(), last_error = 'subscription revoked'
   where subscription_id = v.id and delivered_at is null and failed_at is null;
  return true;
end;
$$;

-- Failed deliveries since `p_since`, sent again with a fresh 24-hour window.
-- Not a message about an event a reorg took back, or that has since moved to
-- another block: that news is stale, and the payment.removed notice is the
-- one to resend. Returns how many.
create or replace function public.replay_webhook_deliveries(p_address text, p_url text, p_since timestamptz)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update public.webhook_deliveries d
     set failed_at = null, next_attempt_at = now(), window_started_at = now()
    from public.webhook_subscriptions s, public.payment_events e
   where s.id = d.subscription_id and s.address = lower(p_address) and s.url = p_url and s.state = 'active'
     and e.chain_id = d.chain_id and e.tx_hash = d.tx_hash and e.log_index = d.log_index
     and (d.type = 'payment.removed' or (not e.removed and e.block_hash = d.block_hash))
     and d.delivered_at is null and d.failed_at is not null and d.failed_at >= p_since;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Spend a nonce. False if it was already spent: a replayed request.
create or replace function public.use_webhook_nonce(p_address text, p_nonce text, p_expires_at timestamptz)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  insert into public.webhook_nonces (address, nonce, expires_at)
  values (lower(p_address), p_nonce, p_expires_at)
  on conflict do nothing;
  get diagnostics n = row_count;
  -- A spent nonce is only worth keeping while its signature could still be used.
  delete from public.webhook_nonces where expires_at < now() - interval '1 day';
  return n > 0;
end;
$$;

-- ---- delivering (called by `deliver-webhooks`) ----

-- New deliveries for one subscription, and its cursor, together. Refused if
-- the cursor moved under the batch, so overlapping runs can't double-queue.
-- `p_cancel` names deliveries a reorg made moot before they were sent.
create or replace function public.queue_webhook_deliveries(
  p_subscription uuid,
  p_from_seq     bigint,
  p_to_seq       bigint,
  p_rows         jsonb,
  p_cancel       text[]
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update public.webhook_subscriptions set cursor_seq = p_to_seq, updated_at = now()
   where id = p_subscription and cursor_seq = p_from_seq and state = 'active';
  if not found then
    raise exception 'webhook subscription cursor moved' using errcode = '40001';
  end if;

  insert into public.webhook_deliveries (subscription_id, chain_id, tx_hash, log_index, block_hash, type, payload)
  select p_subscription, r.chain_id, r.tx_hash, r.log_index, r.block_hash, r.type, r.payload
    from jsonb_to_recordset(p_rows) as r(chain_id integer, tx_hash text, log_index integer, block_hash text, type text, payload jsonb)
  on conflict (subscription_id, chain_id, tx_hash, log_index, block_hash, type) do nothing;
  get diagnostics n = row_count;

  update public.webhook_deliveries set failed_at = now(), last_error = 'removed by a reorg before it was delivered'
   where id = any(p_cancel) and subscription_id = p_subscription and delivered_at is null and failed_at is null;
  return n;
end;
$$;

-- Deliveries due now, each held for `p_lease_seconds` so an overlapping run
-- skips it, with the url and the secrets to sign with (current first, then the
-- previous one while a rotation is in its grace day).
create or replace function public.claim_webhook_deliveries(p_limit integer, p_lease_seconds integer)
returns table (id text, url text, secrets text[], payload jsonb, attempts integer, window_started_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select d.id
      from public.webhook_deliveries d
      join public.webhook_subscriptions s on s.id = d.subscription_id
     where s.state = 'active' and d.delivered_at is null and d.failed_at is null and d.next_attempt_at <= now()
     order by d.next_attempt_at
     limit p_limit
       for update of d skip locked
  ), claimed as (
    update public.webhook_deliveries d
       set next_attempt_at = now() + make_interval(secs => p_lease_seconds)
      from due
     where d.id = due.id
    returning d.id, d.subscription_id, d.payload, d.attempts, d.window_started_at
  )
  select c.id, s.url,
         array_remove(array[cur.decrypted_secret, case when s.previous_until > now() then prev.decrypted_secret end], null),
         c.payload, c.attempts, c.window_started_at
    from claimed c
    join public.webhook_subscriptions s on s.id = c.subscription_id
    left join vault.decrypted_secrets cur on cur.id = s.secret_id
    left join vault.decrypted_secrets prev on prev.id = s.previous_secret_id;
end;
$$;

-- One attempt's outcome. A null `p_next_attempt_at` on a failure means the
-- 24-hour window is spent: failed, until replayed.
create or replace function public.finish_webhook_delivery(
  p_id              text,
  p_delivered       boolean,
  p_next_attempt_at timestamptz,
  p_error           text
)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.webhook_deliveries
     set attempts        = attempts + 1,
         delivered_at    = case when p_delivered then now() end,
         failed_at       = case when not p_delivered and p_next_attempt_at is null then now() end,
         next_attempt_at = coalesce(p_next_attempt_at, next_attempt_at),
         last_error      = case when p_delivered then null else left(p_error, 500) end
   where id = p_id and delivered_at is null and failed_at is null;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.create_webhook_subscription(text, text, text)',
    'public.activate_webhook_subscription(uuid)',
    'public.discard_webhook_subscription(uuid)',
    'public.rotate_webhook_secret(text, text, text)',
    'public.revoke_webhook_subscription(text, text)',
    'public.replay_webhook_deliveries(text, text, timestamptz)',
    'public.use_webhook_nonce(text, text, timestamptz)',
    'public.queue_webhook_deliveries(uuid, bigint, bigint, jsonb, text[])',
    'public.claim_webhook_deliveries(integer, integer)',
    'public.finish_webhook_delivery(text, boolean, timestamptz, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- Every minute, like the indexer it follows.
select cron.unschedule('remesso-deliver-webhooks')
where exists (select 1 from cron.job where jobname = 'remesso-deliver-webhooks');

select cron.schedule(
  'remesso-deliver-webhooks',
  '* * * * *',
  $$ select public.invoke_edge_function('deliver-webhooks'); $$
);
