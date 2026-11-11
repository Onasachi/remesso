-- First-payment rewards: a small amount of USDT to a person whose first real
-- payment through Remesso ran on-chain.
--
-- A campaign is a row, not code: its token, amount and cap are data, so the
-- first 150 becomes the first 1,000 by raising `cap` (or a new campaign row),
-- with no deploy. `pay-rewards` decides who qualifies (_shared/rewards.ts) and
-- pays from its own key, REWARDS_PRIVATE_KEY, never the executor's.
--
-- One reward per PERSON, not per wallet. A wallet costs nothing to make, and
-- $1 sent between two of your own wallets would otherwise earn the reward
-- over and over. A person is a MiniPay phone number (an attestation by
-- MiniPay's issuer, read on-chain) or a live Self passport nullifier.

create table public.reward_campaigns (
  id           text primary key,
  -- The token the reward is paid in, lowercased, and its amount in base units.
  token        text not null check (token = lower(token) and token ~ '^0x[0-9a-f]{40}$'),
  amount_units numeric(78,0) not null check (amount_units > 0),
  -- How many rewards in total. Raise it to extend the campaign.
  cap          integer not null check (cap >= 0),
  -- Only payments made in this window count.
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.rewards (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   text not null references public.reward_campaigns(id),
  -- 'phone:<MiniPay identifier>' or 'self:<nullifier>'.
  person_key    text not null,
  -- The paying wallet, lowercased. The reward goes back to it.
  wallet        text not null check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
  -- The payment that earned it: a payment_events row.
  qualifying_tx        text not null,
  qualifying_log_index integer not null,
  token         text not null,
  amount_units  numeric(78,0) not null,
  -- reserved: counted against the cap, not signed yet.
  -- signed:   signed and saved BEFORE broadcast, so a dead invocation leaves
  --           bytes to resend and a hash to look up, never an unknown payment.
  -- paid:     a successful receipt.
  -- failed:   given up on; its place under the cap is freed.
  status        text not null default 'reserved'
                check (status in ('reserved', 'signed', 'paid', 'failed')),
  tx_hash       text,
  nonce         bigint,
  signed_tx     text,
  signed_at     timestamptz,
  attempts      integer not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (campaign_id, person_key),
  unique (campaign_id, wallet),
  unique (campaign_id, qualifying_tx, qualifying_log_index)
);

create index rewards_open on public.rewards (campaign_id, status) where status in ('reserved', 'signed');

-- Wallets that never earn a reward and never count as the other side of a
-- qualifying payment: ours. Lowercased.
create table public.reward_exclusions (
  address text primary key check (address = lower(address) and address ~ '^0x[0-9a-f]{40}$'),
  reason  text not null
);

insert into public.reward_exclusions (address, reason) values
  ('0xc998739eef304d39771901c0d379215a7c1aa15e', 'V5 owner'),
  ('0xa351d65c15b8a342b6ecbc7f2b9efe62b17cdb21', 'V5 executor'),
  ('0x2da4cd408bd8051385b5dd113f8bed56e4f9f134', 'V5 treasury'),
  ('0xcdea4cc4191ec9a5d8fd1a6b17e3f4c84e993ae2', 'V1-V4 owner, x402 payTo'),
  ('0x3c754ad31e802d5fa65487f460ded65aba749cd1', 'V1-V4 executor'),
  ('0xe1a0f916e859624d4edbada23e4382d327eaf626', 'retired, key exposed'),
  ('0x0c4f38b019844924d35db54837d74f1f53c82ec1', 'agent spend key, x402 test payer'),
  ('0x55c7054faa788daa98ec5ee08e6e00379d07658c', 'gas tank'),
  ('0x7d44d82db13eff00ba7152a1a05611e692e50b4f', 'ODIS quota key'),
  ('0x3697261d15fb3c0b945120450773f7b27d4344d2', 'test wallet (TESTING_ADDRESS_AGENT_WORKFLOW)'),
  ('0x5b156fe262b54c236563428c56839d8457a5542c', 'test sender in scripts'),
  ('0xfd1a3980f7473bdfe7461e78adde78c33d7b006b', 'founder MiniPay'),
  ('0x5c3ebb0084233156ba51a5c2dfd42d88d5a74ca6', 'Self agent identity')
on conflict do nothing;

-- The first campaign: 0.20 USDT (6dp) to each of the first 150 people.
-- Starts when this migration runs; nothing before it counts.
insert into public.reward_campaigns (id, token, amount_units, cap)
values ('first-payment-2026-11', '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', 200000, 150)
on conflict do nothing;

-- Service role only, apart from the two read functions below.
alter table public.reward_campaigns enable row level security;
alter table public.rewards enable row level security;
alter table public.reward_exclusions enable row level security;

-- Take a place under the cap, atomically. The campaign row is locked, so two
-- passes can't both take the last place. `outcome`: reserved, closed, full,
-- duplicate (this person, wallet or payment already has one).
create or replace function public.reserve_reward(
  p_campaign text, p_person text, p_wallet text, p_tx text, p_log_index int
) returns table (reward_id uuid, outcome text)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  c public.reward_campaigns%rowtype;
  v_taken int;
  v_id uuid;
begin
  select * into c from public.reward_campaigns where id = p_campaign for update;
  if not found or not c.active or now() < c.starts_at
     or (c.ends_at is not null and now() >= c.ends_at) then
    return query select null::uuid, 'closed'; return;
  end if;

  select count(*) into v_taken from public.rewards
   where campaign_id = p_campaign and status <> 'failed';
  if v_taken >= c.cap then
    return query select null::uuid, 'full'; return;
  end if;

  insert into public.rewards (campaign_id, person_key, wallet, qualifying_tx, qualifying_log_index, token, amount_units)
  values (p_campaign, p_person, lower(p_wallet), p_tx, p_log_index, c.token, c.amount_units)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    return query select null::uuid, 'duplicate'; return;
  end if;
  return query select v_id, 'reserved';
end;
$$;

revoke all on function public.reserve_reward(text, text, text, text, int) from public, anon, authenticated;

-- What the app shows: how many of the cap are taken. Public on purpose; the
-- payouts are on-chain anyway.
create or replace function public.reward_campaign_status(p_campaign text)
returns table (cap int, taken int, amount_units numeric, token text, active boolean, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select c.cap,
         (select count(*)::int from public.rewards r where r.campaign_id = c.id and r.status <> 'failed'),
         c.amount_units, c.token,
         c.active and now() >= c.starts_at and (c.ends_at is null or now() < c.ends_at),
         c.starts_at, c.ends_at
    from public.reward_campaigns c where c.id = p_campaign;
$$;

-- One wallet's reward, if it has one: so a person can see theirs arrive.
create or replace function public.reward_for_wallet(p_campaign text, p_wallet text)
returns table (status text, amount_units numeric, token text, tx_hash text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select r.status, r.amount_units, r.token, case when r.status = 'paid' then r.tx_hash end
    from public.rewards r
   where r.campaign_id = p_campaign and r.wallet = lower(p_wallet);
$$;

grant execute on function public.reward_campaign_status(text) to anon, authenticated;
grant execute on function public.reward_for_wallet(text, text) to anon, authenticated;

-- Every five minutes. index-events marks an event final about 25 minutes
-- after it lands, and only final events count, so a reward arrives within
-- about half an hour of the payment.
select cron.unschedule('remesso-pay-rewards')
where exists (select 1 from cron.job where jobname = 'remesso-pay-rewards');

select cron.schedule(
  'remesso-pay-rewards',
  '*/5 * * * *',
  $$ select public.invoke_edge_function('pay-rewards'); $$
);
