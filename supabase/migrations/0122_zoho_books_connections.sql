-- Zoho Books on the connector core (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z12): a third
-- accounting tool, whose open bills come in for review beside Xero's and QuickBooks'.
--
-- The provider checks of accounting_connections, accounting_tokens and external_links take zohobooks. Each keeps every
-- value it took before (0116: xero, quickbooks, hubspot, asana, pipedrive), and is replaced only while it does not take
-- zohobooks yet: a re-run of this migration never narrows a later widening, and 0105, 0115 and 0116, re-run after it,
-- see their own value already taken and leave the check as it is.
--
-- No one-workspace index: several workspaces may connect one Zoho Books organization, as with Xero (Z5). No webhook
-- table: Zoho Books has no API to register one, and the sweeper reads every 15 minutes (Z9).
--
-- zohobooks_connector_ready(p_org_id): true once this migration has run. The connect flow asks it before anyone is sent
-- to Zoho. It takes the workspace, as the tenant data layer passes p_org_id to every tenant function (0117 fixed
-- Pipedrive's probe, which took none and so was never found), and reads nothing.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_provider_check' and conrelid = 'public.accounting_connections'::regclass and pg_get_constraintdef(oid) like '%zohobooks%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
    alter table public.accounting_connections
      add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_tokens_provider_check' and conrelid = 'public.accounting_tokens'::regclass and pg_get_constraintdef(oid) like '%zohobooks%') then
    alter table public.accounting_tokens drop constraint if exists accounting_tokens_provider_check;
    alter table public.accounting_tokens
      add constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'external_links_provider_check' and conrelid = 'public.external_links'::regclass and pg_get_constraintdef(oid) like '%zohobooks%') then
    alter table public.external_links drop constraint if exists external_links_provider_check;
    alter table public.external_links
      add constraint external_links_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks'));
  end if;
end $$;

create or replace function public.zohobooks_connector_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.zohobooks_connector_ready(uuid) from public, anon, authenticated;
grant execute on function public.zohobooks_connector_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.zohobooks_connector_ready(uuid);
-- and the checks without zohobooks, once no row holds it.
