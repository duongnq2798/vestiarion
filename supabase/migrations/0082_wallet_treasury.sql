-- Your own wallet as the treasury (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md W1, W8, W9, W13, W16).
--
-- A workspace on Arc mainnet may pay from a wallet its owner holds: `orgs.wallet_host = 'external'`. Its
-- spending_limit_contracts row names that wallet (`treasury_address`) and the owner's own approval of the contract
-- (`approve_tx_hash`, a transaction on chain, in place of a Circle transaction id). `accounts.inbound_from_block` is
-- where the reading of money in to such a wallet resumes. A sandbox whose wallet approved its contract is never
-- deleted automatically: the approval outlives the workspace, and the owner revokes it from their wallet.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- W1: a third wallet host.
alter table public.orgs drop constraint if exists orgs_wallet_host_check;
alter table public.orgs add constraint orgs_wallet_host_check check (wallet_host in ('own', 'hosted', 'external'));

-- W8, W9: the owner's wallet, and their approval on chain.
alter table public.spending_limit_contracts add column if not exists treasury_kind text not null default 'circle';
alter table public.spending_limit_contracts add column if not exists treasury_address text;
alter table public.spending_limit_contracts add column if not exists approve_tx_hash text;

alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_treasury_kind_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_treasury_kind_check
  check (treasury_kind in ('circle', 'external'));
alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_treasury_address_format;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_treasury_address_format
  check (treasury_address is null or treasury_address ~ '^0x[0-9a-fA-F]{40}$');
alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_treasury_address_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_treasury_address_check
  check (treasury_kind <> 'external' or treasury_address is not null);
alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_approve_tx_hash_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_approve_tx_hash_check
  check (approve_tx_hash is null or approve_tx_hash ~ '^0x[0-9a-fA-F]{64}$');

-- Enforced only once deployed, with an agent and an approval behind it: Circle's, or the owner's own on chain.
alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_enforced_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_enforced_check check (
  not enforced or (address is not null and agent_address is not null and (approve_tx_id is not null or approve_tx_hash is not null))
);

-- W13: where reading money in to the owner's wallet resumes.
alter table public.accounts add column if not exists inbound_from_block bigint;

-- W16: as 0030's, with one more refusal before anything is deleted.
create or replace function public.delete_sandbox_org(p_org_id uuid, p_inactive_before timestamptz) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_org public.orgs;
begin
  select * into v_org from public.orgs where id = p_org_id for update;
  if not found then
    return false;
  end if;
  if v_org.mode <> 'sandbox' then
    raise exception 'not_a_sandbox: % is %, and only a sandbox is deleted automatically', v_org.slug, v_org.mode;
  end if;
  if v_org.last_active_at >= p_inactive_before then
    return false;
  end if;
  if v_org.circle_api_key_enc is not null then
    raise exception 'has_circle_credentials: % holds Circle credentials, and a connected sandbox is never deleted automatically', v_org.slug;
  end if;
  if v_org.wallet_host = 'hosted'
     and exists (select 1 from public.accounts where org_id = p_org_id and circle_wallet_id is not null) then
    raise exception 'has_hosted_wallet: % has hosted wallets, and a sandbox with hosted wallets is never deleted automatically', v_org.slug;
  end if;
  if v_org.wallet_host = 'external'
     and exists (select 1 from public.spending_limit_contracts where org_id = p_org_id and approve_tx_hash is not null) then
    raise exception 'has_wallet_approval: % has an approval from its wallet, and such a sandbox is never deleted automatically', v_org.slug;
  end if;

  perform set_config('vestiarion.purging_org', p_org_id::text, true);
  -- Children before parents: snapshots restrict their run's delete (0019),
  -- and every table restricts the organization's.
  delete from public.cycle_snapshots   where org_id = p_org_id;
  delete from public.cycle_runs        where org_id = p_org_id;
  delete from public.payment_intents   where org_id = p_org_id;
  delete from public.milestones        where org_id = p_org_id;
  delete from public.compliance_checks where org_id = p_org_id;
  delete from public.invoices          where org_id = p_org_id;
  delete from public.treasury_actions  where org_id = p_org_id;
  delete from public.counterparties    where org_id = p_org_id;
  delete from public.accounts          where org_id = p_org_id;
  delete from public.forecasts         where org_id = p_org_id;
  delete from public.ledger_entries    where org_id = p_org_id;
  delete from public.sim_clock         where org_id = p_org_id;
  perform set_config('vestiarion.purging_org', '', true);
  -- memberships and invitations cascade with the organization.
  delete from public.orgs where id = p_org_id;
  return true;
end;
$$;

revoke execute on function public.delete_sandbox_org(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.delete_sandbox_org(uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';

-- Rollback (by hand, in this order): re-run 0030's delete_sandbox_org; drop the four spending_limit_contracts
-- constraints added here and re-add 0062's enforced check; drop columns approve_tx_hash, treasury_address,
-- treasury_kind and accounts.inbound_from_block; re-add orgs_wallet_host_check with ('own', 'hosted') once no row is
-- 'external'.
