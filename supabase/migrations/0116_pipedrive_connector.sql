-- Pipedrive on the connector core (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P2): a second CRM,
-- whose won deals come in beside HubSpot's, and whose deals take the receipts Vestiarion writes back once allowed.
--
-- The provider checks of accounting_connections, accounting_tokens and external_links take pipedrive. Each keeps every
-- value it took before, and asana (migration 0115, which another feature adds), so whichever of the two runs last
-- leaves both. Each check is replaced only while it does not take pipedrive yet: a re-run of this migration never
-- narrows a later widening.
--
-- The receipts switch (accounting_connections_writes_check) and the outbox (crm_receipt_writes_provider_check) take
-- pipedrive beside hubspot, the same way. crm_receipt_writes_account_test_check (0107) is left as it is: account_test is
-- true only beside HubSpot's own word for a test account, and Pipedrive names no test company, so a Pipedrive write of
-- payments on Arc testnet or in shadow mode can never reach sending, sent or written (crm_receipt_writes_reality_check).
-- That is the reality rule (P12), held by the database.
--
-- accounting_connections_pipedrive_one_workspace: a Pipedrive company is connected, not revoked, to one workspace at a
-- time, as a HubSpot account is (0105): two workspaces would bring the same won deals in twice, and revoking the app in
-- one would uninstall it for the other.
--
-- pipedrive_connector_ready(): true once this migration has run. The connect flow and the card ask it before anyone is
-- sent to Pipedrive.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_provider_check' and conrelid = 'public.accounting_connections'::regclass and pg_get_constraintdef(oid) like '%pipedrive%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
    alter table public.accounting_connections
      add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_tokens_provider_check' and conrelid = 'public.accounting_tokens'::regclass and pg_get_constraintdef(oid) like '%pipedrive%') then
    alter table public.accounting_tokens drop constraint if exists accounting_tokens_provider_check;
    alter table public.accounting_tokens
      add constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'external_links_provider_check' and conrelid = 'public.external_links'::regclass and pg_get_constraintdef(oid) like '%pipedrive%') then
    alter table public.external_links drop constraint if exists external_links_provider_check;
    alter table public.external_links
      add constraint external_links_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_writes_check' and conrelid = 'public.accounting_connections'::regclass and pg_get_constraintdef(oid) like '%pipedrive%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_writes_check;
    alter table public.accounting_connections
      add constraint accounting_connections_writes_check check (not writes_on or (provider in ('hubspot', 'pipedrive') and status <> 'revoked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_receipt_writes_provider_check' and conrelid = 'public.crm_receipt_writes'::regclass and pg_get_constraintdef(oid) like '%pipedrive%') then
    alter table public.crm_receipt_writes drop constraint if exists crm_receipt_writes_provider_check;
    alter table public.crm_receipt_writes
      add constraint crm_receipt_writes_provider_check check (provider in ('hubspot', 'pipedrive'));
  end if;
end $$;

create unique index if not exists accounting_connections_pipedrive_one_workspace
  on public.accounting_connections (provider, external_org_id)
  where provider = 'pipedrive' and status <> 'revoked';

create or replace function public.pipedrive_connector_ready()
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.pipedrive_connector_ready() from public, anon, authenticated;
grant execute on function public.pipedrive_connector_ready() to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.pipedrive_connector_ready();
-- drop index if exists public.accounting_connections_pipedrive_one_workspace;
-- and the checks without pipedrive, once no row holds it.
