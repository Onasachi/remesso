-- The request inbox, fixed (docs/agent-to-agent.md, 1d).
--
-- Three problems with 20260928000002:
--   - `dismiss_payment_request` needed only a request's id, and
--     `payment_requests_for` hands the ids to anyone who names the payer's
--     address. So anyone could hide every request a payer got.
--   - The limit of ten counted pending requests of any age, while the inbox
--     stops showing them after 30 days. Nobody dismisses what they can't see,
--     so ten abandoned requests blocked a payer for good.
--   - The count and the insert were two calls, so requests sent at the same
--     moment could all get past the limit.
--
-- What replaces them: hiding is per session and changes nothing for anyone
-- else; a decline is a status only the service role writes, after
-- `request-payment` has checked the payer's signature; and one definition of
-- "live" is used by the inbox and the limit alike.

-- 1. Hiding, per session --------------------------------------------------

-- A row says "this session doesn't want to see this request". An anonymous
-- session's claimed wallet proves nothing (MiniPay can't sign, see CLAUDE.md),
-- so a hide must never reach past the session that made it.
create table public.payment_request_hides (
  request_id uuid not null references public.payment_requests(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);

-- Written only through hide_payment_request, read only by
-- payment_requests_for. No policies.
alter table public.payment_request_hides enable row level security;

-- 2. One definition of a live request -------------------------------------

-- Pending and under 30 days old. The inbox and the limit both call this, so
-- a request can never count against a payer after it has left their inbox.
-- Plain SQL so the planner inlines it and the payer index still applies.
create or replace function public.payment_request_live(p_status text, p_created_at timestamptz)
returns boolean
language sql
stable
as $$
  select p_status = 'pending' and p_created_at > now() - interval '30 days';
$$;

-- 3. A decline, from the payer's own signature ----------------------------

-- 'dismissed' stays allowed for rows the old function wrote (there were none
-- when this ran). 'declined' is written only by the service role, after
-- request-payment verifies an EIP-712 signature from the payer.
alter table public.payment_requests drop constraint payment_requests_status_known;
alter table public.payment_requests add constraint payment_requests_status_known
  check (status in ('pending', 'dismissed', 'used', 'declined'));

-- 4. The inbox leaves out what this session hid ---------------------------

-- Still readable by anyone who names the address, for the reasons in
-- 20260928000002. Without a session `auth.uid()` is null and nothing is left
-- out, which is right: a hide belongs to the session that made it.
create or replace function public.payment_requests_for(p_address text)
returns setof public.payment_requests
language sql
security definer
set search_path = public
as $$
  select r.*
  from public.payment_requests r
  where lower(r.payer_address) = lower(p_address)
    and public.payment_request_live(r.status, r.created_at)
    and not exists (
      select 1 from public.payment_request_hides h
      where h.request_id = r.id and h.user_id = auth.uid()
    )
  order by r.created_at desc
  limit 20;
$$;

-- 5. Hiding one -----------------------------------------------------------

-- The only write a sender's session makes, and it can do nothing but take a
-- row out of that session's own list. Idempotent, and a no-op for an id that
-- doesn't exist rather than an error that says so.
create or replace function public.hide_payment_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into public.payment_request_hides (request_id, user_id)
  select p_id, auth.uid()
  where exists (select 1 from public.payment_requests where id = p_id)
  on conflict do nothing;
end;
$$;

revoke all on function public.hide_payment_request(uuid) from public, anon;
grant execute on function public.hide_payment_request(uuid) to authenticated;

-- The app deployed before this migration calls dismiss_payment_request. It
-- now hides for the calling session only, so that app keeps working and the
-- old behaviour, hiding a request for everyone, is gone the moment this runs.
-- Drop it once no deployed app calls it.
create or replace function public.dismiss_payment_request(p_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.hide_payment_request(p_id);
$$;

revoke all on function public.dismiss_payment_request(uuid) from public, anon;
grant execute on function public.dismiss_payment_request(uuid) to authenticated;

-- 6. The limit, checked and applied in one call ---------------------------

-- A transaction lock on the payer serialises requests to the same wallet, so
-- the count a call sees is the count it inserts against. Two payers whose
-- addresses hash alike merely wait for each other. `p_max_live` comes from
-- request-payment, which says why the cap exists.
--
-- Returns the new id, or a null id with the live count when the payer already
-- has `p_max_live` live requests.
create or replace function public.create_payment_request(
  p_payer            text,
  p_to               text,
  p_amount           text,
  p_token_symbol     text,
  p_interval_seconds integer,
  p_max_runs         integer,
  p_from_name        text,
  p_note             text,
  p_max_live         integer
)
returns table (request_id uuid, live integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n      integer;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(lower(p_payer), 0));

  select count(*) into n
  from public.payment_requests r
  where lower(r.payer_address) = lower(p_payer)
    and public.payment_request_live(r.status, r.created_at);

  if n >= p_max_live then
    return query select null::uuid, n;
    return;
  end if;

  insert into public.payment_requests (
    payer_address, to_address, amount, token_symbol,
    interval_seconds, max_runs, from_name, note
  ) values (
    p_payer, p_to, p_amount, p_token_symbol,
    p_interval_seconds, p_max_runs, p_from_name, p_note
  )
  returning id into new_id;

  return query select new_id, n + 1;
end;
$$;

revoke all on function public.create_payment_request(text, text, text, text, integer, integer, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_payment_request(text, text, text, text, integer, integer, text, text, integer)
  to service_role;
