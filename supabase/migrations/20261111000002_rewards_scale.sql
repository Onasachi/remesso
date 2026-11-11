-- First-payment rewards at scale.
--
-- pay-rewards used to read the first 5,000 payments since the campaign began
-- and look up at most 40 payers, oldest first, every pass. So payments after
-- the 5,000th were never seen, and 40 payers who can never qualify (no
-- MiniPay number, no Self check) sat at the front and were looked up again
-- on every pass, so nobody behind them was ever reached.
--
-- Now the database hands it the next payers worth a look, and remembers who
-- it has looked at:
--   * a payer already holding a reward (any status) or excluded is skipped;
--   * a payer checked before is looked at again only when they have a newer
--     final payment than the one last checked (`seq` moves when an event
--     becomes final), or an hour has passed (they may have verified since);
--   * oldest first payment first, so places go in the order people paid.

create table public.reward_checks (
  campaign_id text not null references public.reward_campaigns(id),
  wallet      text not null check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
  -- The newest payment_events.seq of this payer's that the check saw.
  last_seq    bigint not null,
  checked_at  timestamptz not null default now(),
  -- Why it earned nothing that time, for a person reading the table.
  reason      text,
  primary key (campaign_id, wallet)
);

alter table public.reward_checks enable row level security;

-- The pass reads payments by kind since the campaign started, newest state.
create index if not exists payment_events_reward_scan
  on public.payment_events (seq)
  where kind in ('run', 'policy_payment') and final and not removed;

create or replace function public.reward_candidates(p_campaign text, p_limit int, p_recheck interval)
returns table (wallet text, first_seq bigint, last_seq bigint)
language sql stable
set search_path = public, pg_temp
as $$
  with c as (
    select * from public.reward_campaigns where id = p_campaign
  ), payers as (
    select e.from_address as wallet, min(e.seq) as first_seq, max(e.seq) as last_seq
      from public.payment_events e, c
     where e.kind in ('run', 'policy_payment') and e.final and not e.removed
       and e.block_time >= c.starts_at
       and (c.ends_at is null or e.block_time < c.ends_at)
     group by e.from_address
  )
  select p.wallet, p.first_seq, p.last_seq
    from payers p
   where not exists (select 1 from public.rewards r where r.campaign_id = p_campaign and r.wallet = p.wallet)
     and not exists (select 1 from public.reward_exclusions x where x.address = p.wallet)
     and not exists (
       select 1 from public.reward_checks k
        where k.campaign_id = p_campaign and k.wallet = p.wallet
          and k.last_seq >= p.last_seq
          and k.checked_at > now() - p_recheck
     )
   order by p.first_seq
   limit p_limit;
$$;

revoke all on function public.reward_candidates(text, int, interval) from public, anon, authenticated;

-- Every minute rather than every five: a pass pays at most five, and the
-- lease keeps two passes from overlapping, so this is up to ~7,200 a day.
select cron.unschedule('remesso-pay-rewards')
where exists (select 1 from cron.job where jobname = 'remesso-pay-rewards');

select cron.schedule(
  'remesso-pay-rewards',
  '* * * * *',
  $$ select public.invoke_edge_function('pay-rewards'); $$
);
