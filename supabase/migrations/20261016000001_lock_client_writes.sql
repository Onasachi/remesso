-- The app may no longer write the columns the executor acts on.
--
-- solidity-auditor scan 2026-10-16. `claim_sender` binds a wallet to whoever
-- asks — it has to: MiniPay cannot sign, so nothing can prove ownership — and
-- the RLS policies on these tables were `for all`. Together that meant any
-- anonymous session could take a wallet's rows and then:
--
--   - set its schedules to `paused`. `due_schedules` skips them and the
--     cadence silently stopped paying, with nothing on-chain to show why;
--   - write `onchain_id` on rows of its own for ids nobody had created yet.
--     `schedules_contract_onchain_id_idx` then refused those ids to the real
--     schedules, which were never mirrored and never ran;
--   - edit a recipient's bank fields, which a bank payout reads at run time.
--
-- The claim stays last-writer-wins; what it buys is now a view, not a lever.
-- Status, ids and terms are written by the service role only: the executor,
-- `sync-schedules`, and `confirm-schedule`, which reads them from the chain.
--
-- NOT closed here, and why it does not matter today: a bank payout's account
-- details are still a claim. A claimed session can insert its own recipient
-- and race the real sender to confirm their new schedule against it. Bank
-- payouts are off (`ENABLE_CNGN_RAILS`); before they come back, bank details
-- need to be bound to something the sender signs.

-- senders: written only by claim_sender (security definer) and the service.
revoke insert, update, delete on public.senders from anon, authenticated;

-- recipients: the form inserts one per schedule; nothing in the app edits or
-- deletes one, so nothing outside the service may.
revoke update, delete on public.recipients from anon, authenticated;

-- schedules: the form inserts the pending row before signing — terms and
-- names only. It arrives `pending_authorization` with no `onchain_id`, which
-- `due_schedules` never returns, and only confirm-schedule binds it.
revoke insert, update, delete on public.schedules from anon, authenticated;
grant insert (
  sender_id, recipient_id, token_address, amount_in, interval_seconds,
  min_rate_e6, max_runs, expires_at, label
) on public.schedules to authenticated;

-- Ids sync-schedules looked at and did not adopt, so it does not re-read the
-- same ones first on every tick. Twenty-five skipped ids used to fill every
-- batch, and no schedule after them was ever found.
create table if not exists public.schedule_sync_skips (
  executor_address text not null,
  onchain_id       numeric(78,0) not null,
  reason           text not null,
  checked_at       timestamptz not null default now(),
  primary key (executor_address, onchain_id)
);
alter table public.schedule_sync_skips enable row level security;
-- No policy: service role only.

comment on table public.schedule_sync_skips is
  'On-chain schedule ids sync-schedules read and did not mirror, with why. '
  'Rechecked after a day.';
