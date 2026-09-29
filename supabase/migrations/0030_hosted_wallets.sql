-- Hosted testnet wallets (docs/superpowers/specs/2026-09-30-hosted-wallets-design.md,
-- H1, H4, H5, H6).
--
-- orgs.wallet_host records whose Circle account holds a workspace's wallets:
-- 'own' (the workspace connected its own), 'hosted' (the platform's hosted
-- testnet account) or null (not chosen yet). orgConfig gives a workspace the
-- hosted credentials only when this column says 'hosted' (H1): it is never a
-- fallback for a workspace with no credentials of its own.
--
-- choose_hosted_wallet() is the only way a workspace becomes hosted, and it
-- holds the platform to p_limit hosted workspaces (H5).
--
-- delete_sandbox_org: redefined from 0029 (its latest definition) with one
-- added refusal — a hosted sandbox with wallets is never deleted
-- automatically, since its wallet may hold faucet funds the owner is using
-- (H6). Everything else, including the grants, is unchanged.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.orgs add column if not exists wallet_host text
  constraint orgs_wallet_host_check check (wallet_host in ('own', 'hosted'));

-- Backfill: a workspace that already holds its own Circle credentials (the
-- founding workspace, and any connected before this column) is 'own', as
-- connectCircle now records. A hosted workspace never holds credentials, so
-- only null rows change. A replay matches only a workspace given credentials
-- outside connectCircle since (npm run org:adopt-env), which is 'own' too.
update public.orgs set wallet_host = 'own' where wallet_host is null and circle_api_key_enc is not null;

-- Marks a workspace hosted (H4, H5). Refused while the workspace holds Circle
-- credentials or any account has a wallet: once wallets exist, the choice is
-- fixed. A workspace already hosted is left as it is. Otherwise the platform
-- holds at most p_limit hosted workspaces: the advisory lock, one key for the
-- whole platform, serialises every choice, so two workspaces choosing at the
-- limit cannot both pass the count (the create_org and create_api_key
-- reasoning). A null or negative limit admits nobody.
--
-- Returns whether it changed anything: true only when it marked the workspace
-- hosted, so the caller records the choice once (hosted_wallet_chosen).
--
-- 0030's first version returned void, and a return type cannot be replaced in
-- place: that version, wherever it was applied, is dropped first. The boolean
-- one is left alone on every later replay.
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'choose_hosted_wallet'
       and pg_catalog.pg_get_function_result(p.oid) = 'void'
  ) then
    drop function public.choose_hosted_wallet(uuid, int);
  end if;
end $$;

create or replace function public.choose_hosted_wallet(p_org_id uuid, p_limit int) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    public.orgs;
  v_hosted int;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_hosted_wallets'));

  select * into v_org from public.orgs where id = p_org_id for update;
  if not found then
    raise exception 'org_not_found: no organization with id %', p_org_id;
  end if;
  if v_org.circle_api_key_enc is not null
     or v_org.circle_entity_secret_enc is not null
     or exists (select 1 from public.accounts where org_id = p_org_id and circle_wallet_id is not null) then
    raise exception 'hosted_not_allowed: a workspace with Circle credentials or wallets cannot switch to a hosted wallet';
  end if;
  if v_org.wallet_host = 'hosted' then
    return false;
  end if;

  select count(*) into v_hosted from public.orgs where wallet_host = 'hosted';
  if p_limit is null or p_limit < 0 or v_hosted >= p_limit then
    raise exception 'hosted_limit_reached: every hosted testnet wallet is taken';
  end if;

  update public.orgs set wallet_host = 'hosted' where id = p_org_id;
  return true;
end;
$$;

revoke execute on function public.choose_hosted_wallet(uuid, int) from public, anon, authenticated;
grant execute on function public.choose_hosted_wallet(uuid, int) to service_role;

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

-- Rollback:
-- re-run 0029's delete_sandbox_org() body (without the has_hosted_wallet refusal);
-- drop function if exists public.choose_hosted_wallet(uuid, int);
-- alter table public.orgs drop column if exists wallet_host;
