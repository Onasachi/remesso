-- Request tracking: accepted, scheduled and paid are different things
-- (docs/agent-to-agent.md, 3a).
--
-- A schedule existing doesn't mean money arrived, so a request keeps its own
-- state (pending, accepted, accepted_with_changes, declined, expired) and its
-- payments are read from `payment_events`. And the evidence must be about
-- THIS request, not just the same two wallets: an answer binds one schedule,
-- or one policy payment carrying the request's reference in its memo, made
-- after the request, and a schedule or payment answers one request at most.
-- `_shared/request-binding.ts` judges the evidence; this keeps it bound once.

alter table public.payment_requests
  -- What a policy payment puts in its memo: the id without dashes, exactly 32
  -- characters, which fits a bytes32.
  add column reference         text generated always as (replace(id::text, '-', '')) stored,
  add column answered_at       timestamptz,
  -- The answer: a V5 schedule, or a policy payment's transaction.
  add column bound_contract    text,
  add column bound_schedule_id numeric(78,0),
  add column bound_tx_hash     text,
  -- What the payer actually signed, and which terms differ from the request.
  add column signed_terms      jsonb;

create unique index payment_requests_reference on public.payment_requests (reference);
create unique index payment_requests_one_per_schedule
  on public.payment_requests (bound_contract, bound_schedule_id) where bound_schedule_id is not null;
create unique index payment_requests_one_per_payment
  on public.payment_requests (bound_tx_hash) where bound_tx_hash is not null;

alter table public.payment_requests drop constraint payment_requests_status_known;
alter table public.payment_requests add constraint payment_requests_status_known
  check (status in ('pending', 'dismissed', 'used', 'declined', 'accepted', 'accepted_with_changes'));

-- Bind an answer to a live request. False when the request isn't live any
-- more (answered, declined or expired). A schedule or payment that already
-- answers another request fails on the unique indexes above.
create or replace function public.answer_payment_request(
  p_id          uuid,
  p_status      text,
  p_contract    text,
  p_schedule_id numeric,
  p_tx_hash     text,
  p_terms       jsonb
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('accepted', 'accepted_with_changes') then
    raise exception 'not an answer: %', p_status;
  end if;
  update public.payment_requests
     set status = p_status, answered_at = now(), bound_contract = lower(p_contract),
         bound_schedule_id = p_schedule_id, bound_tx_hash = lower(p_tx_hash), signed_terms = p_terms
   where id = p_id and public.payment_request_live(status, created_at);
  return found;
end;
$$;

-- Policy payments whose memo is a live request's reference, not yet bound:
-- the candidates `index-events` judges after each pass.
create or replace function public.policy_payment_answers(p_limit integer default 100)
returns table (
  request_id       uuid,
  payer_address    text,
  to_address       text,
  amount           text,
  token_symbol     text,
  interval_seconds integer,
  max_runs         integer,
  status           text,
  created_at       timestamptz,
  contract         text,
  tx_hash          text,
  paid_from        text,
  paid_to          text,
  paid_token       text,
  paid_amount      text,
  paid_at          timestamptz
)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.id, r.payer_address, r.to_address, r.amount, r.token_symbol, r.interval_seconds, r.max_runs,
         r.status, r.created_at,
         e.contract, e.tx_hash, e.from_address, e.to_address, e.token, e.amount::text, e.block_time
    from public.payment_events e
    join public.payment_requests r on r.reference = e.memo_text
   where e.kind = 'policy_payment' and not e.removed
     and public.payment_request_live(r.status, r.created_at)
     and not exists (select 1 from public.payment_requests b where b.bound_tx_hash = e.tx_hash)
   order by e.seq
   limit p_limit;
$$;

revoke all on function public.answer_payment_request(uuid, text, text, numeric, text, jsonb) from public, anon, authenticated;
revoke all on function public.policy_payment_answers(integer) from public, anon, authenticated;
grant execute on function public.answer_payment_request(uuid, text, text, numeric, text, jsonb) to service_role;
grant execute on function public.policy_payment_answers(integer) to service_role;
