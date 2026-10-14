-- claim_sender, fixed for a session that switches wallets.
--
-- Found 2026-10-14: a browser session held wallet A, the person switched their
-- wallet to B, and B already had a sender row (one discovered on-chain by
-- sync-schedules). The old function bound B's row to the session while A's row
-- still held it — `senders.auth_user_id` is unique — so the insert behind
-- "Allow & authorise" failed with a duplicate key, shown as "That wallet is
-- already registered in another session".
--
-- It also had a quieter fault: switching to a wallet with NO row yet took the
-- second branch and rewrote A's row to B's address, so A's schedules would
-- have appeared under B and vanished from A.
--
-- Now: the session first lets go of any other wallet it held (that row goes
-- back to unowned — invisible under RLS, re-bound the next time that wallet
-- opens the app), then binds B's row if there is one, else creates it. A row
-- is never renamed. Still last-writer-wins, still moves no money: the contract
-- checks msg.sender for everything that does.

create or replace function public.claim_sender(p_wallet text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_wallet text := lower(p_wallet);
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if v_wallet !~ '^0x[a-f0-9]{40}$' then
    raise exception 'not an address: %', p_wallet;
  end if;

  -- This session switched wallets: release the one it held.
  update public.senders
     set auth_user_id = null
   where auth_user_id = auth.uid()
     and wallet_address <> v_wallet;

  -- The wallet's own row, from any session or none.
  update public.senders
     set auth_user_id = auth.uid()
   where wallet_address = v_wallet
  returning id into v_id;

  if v_id is null then
    insert into public.senders (auth_user_id, wallet_address)
    values (auth.uid(), v_wallet)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.claim_sender(text) from public, anon;
grant execute on function public.claim_sender(text) to authenticated;

comment on function public.claim_sender(text) is
  'Bind a wallet to the calling session, releasing any other wallet the '
  'session held and moving this one from a previous session if one held it. '
  'Last-writer-wins: MiniPay cannot sign, so ownership cannot be proven, and '
  'nothing here can move money. Rows are never renamed.';
