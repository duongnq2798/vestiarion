-- Google Sheets on the connector core (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS1, GS2,
-- GS15): a provider of kind export, which brings nothing in. An owner or admin connects one Google account per workspace,
-- and an owner, admin or accountant writes a month's close pack to a spreadsheet in that account's Drive.
--
-- The provider checks of accounting_connections and accounting_tokens take googlesheets. Each keeps every value it took
-- before (0123: xero, quickbooks, hubspot, asana, pipedrive, zohobooks, zohocrm), and is replaced only while it does not
-- take googlesheets yet: a re-run of this migration never narrows a later widening, and 0101, 0105, 0115, 0116, 0122 and
-- 0123, re-run after it, see their own value already taken and leave the check as it is.
-- A later widening must keep googlesheets beside its own value.
--
-- external_links_provider_check is left as it is: nothing links to Google Sheets, and the database holds it so.
--
-- No one-workspace index: the same Google account may be connected to several workspaces (GS4), each with its own
-- spreadsheets. No table: Drive holds which file is a month's, by the tag Vestiarion sets on it (GS7).
--
-- The sweeper's accounting_connections_due (0101) is not redefined here: a migration that redefines another's function
-- is reverted by any migrate run from a branch without it. A Sheets connection is saved with next_sync_after
-- 9999-12-31 instead, so it is never due (GS15).
--
-- googlesheets_connector_ready(p_org_id): true once this migration has run. The connect flow, the card and the close
-- pack page ask it before anyone is sent to Google. It takes the workspace, as the tenant data layer passes p_org_id to
-- every tenant function (0117), and reads nothing.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_provider_check' and conrelid = 'public.accounting_connections'::regclass and pg_get_constraintdef(oid) like '%googlesheets%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
    alter table public.accounting_connections
      add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm', 'googlesheets'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_tokens_provider_check' and conrelid = 'public.accounting_tokens'::regclass and pg_get_constraintdef(oid) like '%googlesheets%') then
    alter table public.accounting_tokens drop constraint if exists accounting_tokens_provider_check;
    alter table public.accounting_tokens
      add constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm', 'googlesheets'));
  end if;
end $$;

create or replace function public.googlesheets_connector_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.googlesheets_connector_ready(uuid) from public, anon, authenticated;
grant execute on function public.googlesheets_connector_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.googlesheets_connector_ready(uuid);
-- and the checks without googlesheets, once no row holds it.
