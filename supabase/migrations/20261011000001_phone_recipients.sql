-- Paying a phone number inside MiniPay.
--
-- MiniPay forbids address entry ("no arbitrary withdrawals") and address
-- display, so inside it a recipient is named by phone number and resolved to
-- their MiniPay wallet through ODIS + FederatedAttestations. The schedule
-- itself is unchanged: the contract still pins one address at signing.

-- What the sender saw, masked ("+234 803 ••• 4567"). Never the full number:
-- a table that maps phone numbers to wallets is the directory ODIS exists to
-- prevent anyone from compiling, and we have no reason to hold one.
alter table public.recipients add column phone_masked text;

alter table public.recipients add constraint recipients_phone_masked_bounded
  check (phone_masked is null or length(phone_masked) <= 32);

-- One row per lookup, and nothing about what was looked up. Each lookup
-- spends paid ODIS quota and answers "does this number have a MiniPay
-- wallet, and which" — unmetered, it is an enumeration oracle with our name
-- on the bill.
create table public.phone_lookups (
  id           bigint generated always as identity primary key,
  auth_user_id uuid not null,
  created_at   timestamptz not null default now()
);

create index phone_lookups_user_recent_idx
  on public.phone_lookups (auth_user_id, created_at desc);

alter table public.phone_lookups enable row level security;
-- No policies: nothing reads or writes this table except the function below.

-- Count this lookup against the caller's daily allowance, or refuse it.
-- SECURITY DEFINER so the route handler can call it with the user's own JWT
-- (no service-role key on Vercel), while auth.uid() still names the caller.
create or replace function public.note_phone_lookup(p_daily_limit integer default 20)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid  uuid := auth.uid();
  used integer;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select count(*) into used
    from public.phone_lookups
   where auth_user_id = uid
     and created_at > now() - interval '24 hours';

  if used >= least(greatest(p_daily_limit, 1), 50) then
    raise exception 'daily phone lookup limit reached' using errcode = 'P0001';
  end if;

  insert into public.phone_lookups (auth_user_id) values (uid);
  return least(greatest(p_daily_limit, 1), 50) - used - 1;
end;
$$;

revoke all on function public.note_phone_lookup(integer) from public;
grant execute on function public.note_phone_lookup(integer) to authenticated;
