-- Zoho CRM on the connector core (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C17): a third CRM,
-- whose won deals come in to plan as collection schedules beside HubSpot's and Pipedrive's.
--
-- The provider checks of accounting_connections, accounting_tokens and external_links take zohocrm. Each keeps every
-- value it took before (0122: xero, quickbooks, hubspot, asana, pipedrive, zohobooks), and is replaced only while it does
-- not take zohocrm yet: a re-run of this migration never narrows a later widening, and 0105, 0115, 0116 and 0122, re-run
-- after it, see their own value already taken and leave the check as it is.
--
-- The receipts switch (accounting_connections_writes_check, 0116) and the outbox (crm_receipt_writes_provider_check) are
-- left as they are: they take hubspot and pipedrive only, so a Zoho CRM connection can never turn writing on, and nothing
-- is ever queued for Zoho CRM. Zoho CRM is read only, and the database holds it so (C14).
--
-- No one-workspace index: several workspaces may connect one Zoho CRM organization, as with Xero; nothing is written to
-- it for them to contend over (C1). No webhook table: the sweeper reads every 15 minutes (C8).
--
-- zohocrm_connector_ready(p_org_id): true once this migration has run. The connect flow, the card and the list ask it
-- before anyone is sent to Zoho. It takes the workspace, as the tenant data layer passes p_org_id to every tenant
-- function (0117), and reads nothing.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_provider_check' and conrelid = 'public.accounting_connections'::regclass and pg_get_constraintdef(oid) like '%zohocrm%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
    alter table public.accounting_connections
      add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_tokens_provider_check' and conrelid = 'public.accounting_tokens'::regclass and pg_get_constraintdef(oid) like '%zohocrm%') then
    alter table public.accounting_tokens drop constraint if exists accounting_tokens_provider_check;
    alter table public.accounting_tokens
      add constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'external_links_provider_check' and conrelid = 'public.external_links'::regclass and pg_get_constraintdef(oid) like '%zohocrm%') then
    alter table public.external_links drop constraint if exists external_links_provider_check;
    alter table public.external_links
      add constraint external_links_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm'));
  end if;
end $$;

create or replace function public.zohocrm_connector_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.zohocrm_connector_ready(uuid) from public, anon, authenticated;
grant execute on function public.zohocrm_connector_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.zohocrm_connector_ready(uuid);
-- and the checks without zohocrm, once no row holds it.
