-- Bills dropped into a Google Drive folder (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD1, GD3, GD5,
-- GD6, GD13).
--
-- 1. The connector core's checks take googledrive as a provider: a workspace connects Google Drive as it connects Google
--    Sheets, its tokens kept in accounting_tokens. Each check keeps every value it took before (0147: xero, quickbooks,
--    hubspot, asana, pipedrive, zohobooks, zohocrm, googlesheets, linear), and is replaced only while it does not take
--    googledrive yet: a re-run of this migration never narrows a later widening, and 0101, 0105, 0115, 0116, 0122,
--    0123, 0145 and 0147, re-run after it, see their own value already taken and leave the check as it is.
--    A later widening must keep googledrive beside its own value.
-- 2. inbox_emails becomes the list of every document waiting for a person's review, whatever brought it (GD3, GD6):
--    its source (email, or google_drive); a Drive file's id and name, both null for an email; Resend's id no longer
--    required, and a check that keeps an email with its Resend id and no Drive id, and a Drive file with its id and name
--    and no Resend id; and one row per Drive file and workspace (nulls never collide, so emails are untouched). Every
--    email row already there takes source email and stays valid. Each column and check is added only while it is not
--    there, so a re-run changes nothing.
-- 3. google_drive_folders: the one folder a workspace reads its new files from (GD4, GD5, GD13), with the connection it
--    reads with (deleted with it), the folder's id and name, its shared drive when it has one, the baseline (the ids of
--    the files already in it when it was chosen, at most 1,000, never read), who chose it and when, when it was last
--    read, and the last error a person reads with its kind (the folder gone, a rate limit, no answer, another failure).
--    Tenant data under the same RLS and grants as inbox_emails: the workspace's own row, deleted when Google Drive is
--    disconnected or the workspace goes.
-- 4. googledrive_connector_ready(p_org_id): true once this migration has run. The connect flow, the card and the review
--    list ask it before anyone is sent to Google. It takes the workspace, as the tenant data layer passes p_org_id to
--    every tenant function (0117), and reads nothing.
--
-- external_links_provider_check is left as it is: nothing links a bill to Google Drive.
--
-- The sweeper's accounting_connections_due (0101) is not redefined here: a migration that redefines another's function
-- is reverted by any migrate run from a branch without it. A Drive connection is saved with next_sync_after null, as
-- Asana's and Linear's are, and each read sets it null again, so the sweeper reads its folder every 15 minutes.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. Before it runs, the app
-- treats 42P01, PGRST205, PGRST202 and 42883 as "Google Drive is not set up yet" and sends no one to Google.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_provider_check' and conrelid = 'public.accounting_connections'::regclass and pg_get_constraintdef(oid) like '%googledrive%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
    alter table public.accounting_connections
      add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm', 'googlesheets', 'linear', 'googledrive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_tokens_provider_check' and conrelid = 'public.accounting_tokens'::regclass and pg_get_constraintdef(oid) like '%googledrive%') then
    alter table public.accounting_tokens drop constraint if exists accounting_tokens_provider_check;
    alter table public.accounting_tokens
      add constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm', 'googlesheets', 'linear', 'googledrive'));
  end if;
end $$;

-- Every row already there is an email, and the default says so.
alter table public.inbox_emails add column if not exists source text not null default 'email';
alter table public.inbox_emails add column if not exists drive_file_id text;
alter table public.inbox_emails add column if not exists file_name text;
-- A Drive file has no Resend id; the source check below keeps one on every email.
alter table public.inbox_emails alter column resend_email_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_emails_source_check' and conrelid = 'public.inbox_emails'::regclass) then
    alter table public.inbox_emails
      add constraint inbox_emails_source_check check (source in ('email', 'google_drive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbox_emails_drive_file_id_check' and conrelid = 'public.inbox_emails'::regclass) then
    alter table public.inbox_emails
      add constraint inbox_emails_drive_file_id_check check (drive_file_id is null or drive_file_id ~ '^[A-Za-z0-9_-]{1,200}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbox_emails_file_name_check' and conrelid = 'public.inbox_emails'::regclass) then
    alter table public.inbox_emails
      add constraint inbox_emails_file_name_check check (file_name is null or char_length(file_name) between 1 and 255);
  end if;
  -- An email keeps its Resend id and names no file; a Drive file names its id and name and no Resend id.
  if not exists (select 1 from pg_constraint where conname = 'inbox_emails_source_fields_check' and conrelid = 'public.inbox_emails'::regclass) then
    alter table public.inbox_emails
      add constraint inbox_emails_source_fields_check check (
        (source = 'email' and resend_email_id is not null and drive_file_id is null and file_name is null)
        or (source = 'google_drive' and drive_file_id is not null and file_name is not null and resend_email_id is null)
      );
  end if;
  -- One row per Drive file and workspace: two reads at once never read a file twice (GD6).
  if not exists (select 1 from pg_constraint where conname = 'inbox_emails_drive_file_key' and conrelid = 'public.inbox_emails'::regclass) then
    alter table public.inbox_emails
      add constraint inbox_emails_drive_file_key unique (org_id, drive_file_id);
  end if;
end $$;

create table if not exists public.google_drive_folders (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null constraint google_drive_folders_org_id_key unique references public.orgs(id) on delete cascade,
  connection_id    uuid not null,
  -- Drive's own id for the folder, from a pasted link or id; the link itself is never kept or opened (GD4).
  folder_id        text not null constraint google_drive_folders_folder_id_check check (folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  folder_name      text not null constraint google_drive_folders_folder_name_check check (char_length(folder_name) between 1 and 255),
  -- The shared drive the folder is in, when it is in one.
  shared_drive_id  text constraint google_drive_folders_shared_drive_id_check check (shared_drive_id is null or shared_drive_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  -- The files already in the folder when it was chosen, never read (GD5): at most 1,000.
  baseline         text[] not null default '{}' constraint google_drive_folders_baseline_check check (cardinality(baseline) <= 1000),
  chosen_by        uuid references auth.users(id) on delete set null,
  chosen_at        timestamptz not null default now(),
  last_read_at     timestamptz,
  -- What a person reads of the last read that did not finish, and its kind: the folder deleted, trashed or no longer
  -- shared with the account (read again once it can be opened), a rate limit, no answer, or another failure (GD13).
  last_error       text constraint google_drive_folders_last_error_check check (last_error is null or char_length(last_error) between 1 and 300),
  last_error_kind  text constraint google_drive_folders_last_error_kind_check
                     check (last_error_kind is null or last_error_kind in ('folder_gone', 'rate_limited', 'unavailable', 'failed')),
  last_error_at    timestamptz,
  constraint google_drive_folders_error_check check ((last_error is null) = (last_error_kind is null)),
  -- Composite, as every reference between workspace rows is: a folder of one workspace never reads with another's
  -- connection. It goes with the connection.
  constraint google_drive_folders_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade
);

alter table public.google_drive_folders enable row level security;
revoke all privileges on table public.google_drive_folders from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.google_drive_folders to vestiarion_tenant;
grant all privileges on table public.google_drive_folders to service_role;

drop policy if exists tenant_isolation on public.google_drive_folders;
create policy tenant_isolation on public.google_drive_folders for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.google_drive_folders;
create policy tenant_isolation_guard on public.google_drive_folders as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create or replace function public.googledrive_connector_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.googledrive_connector_ready(uuid) from public, anon, authenticated;
grant execute on function public.googledrive_connector_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.googledrive_connector_ready(uuid);
-- drop table if exists public.google_drive_folders;
-- delete from public.inbox_emails where source = 'google_drive';
-- alter table public.inbox_emails drop constraint if exists inbox_emails_drive_file_key,
--   drop constraint if exists inbox_emails_source_fields_check, drop constraint if exists inbox_emails_file_name_check,
--   drop constraint if exists inbox_emails_drive_file_id_check, drop constraint if exists inbox_emails_source_check,
--   drop column if exists file_name, drop column if exists drive_file_id, drop column if exists source;
-- alter table public.inbox_emails alter column resend_email_id set not null;
-- and the provider checks without googledrive, once no row holds it.
