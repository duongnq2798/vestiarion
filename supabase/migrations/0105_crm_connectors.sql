-- HubSpot on the connector core (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H2, H4): a CRM's
-- companies and deals, read beside the accounting tools' bills.
--
-- The checks of 0101 take hubspot as a provider, companies (and deals) as linked objects, and deals (and companies) as
-- sync cursors. Each check is replaced only while it does not take the new value yet, so a later migration that widens
-- it again is never narrowed by a re-run of this one.
--
-- accounting_connections_hubspot_one_workspace: a HubSpot account is connected, not revoked, to one workspace at a
-- time. Two workspaces on one account would bring the same won deals in twice and plan two sets of receivables for one
-- sale; uninstalling the app in HubSpot ends every grant for the account. Xero organisations may still be shared.
--
-- accounting_connections_by_external(provider, ids): the connections, not revoked, of these external organisations in
-- every workspace, with their workspace, id, status and next sync time; nothing else. The connect flow asks it before
-- connecting a HubSpot account. The service role's alone, as accounting_connections_due (0101). The same definition, word
-- for word, as the QuickBooks connector's, so either migration may run first.
--
-- crm_deals: the deals read from a CRM, once per connection and deal, with their facts as the CRM has them now (name,
-- amount, currency, close day, pipeline and stage, whether the stage is won, lost or open, the company and its main
-- contact's email), whether the CRM still has the deal, the Vestiarion deal a person made of it, the facts it was planned
-- from or last reviewed at (baseline), and the changes last recorded in the ledger (flagged). The tenant role reads,
-- inserts and updates its own workspace's rows and deletes none; everything goes with the workspace.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_provider_check' and pg_get_constraintdef(oid) like '%hubspot%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
    alter table public.accounting_connections
      add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_tokens_provider_check' and pg_get_constraintdef(oid) like '%hubspot%') then
    alter table public.accounting_tokens drop constraint if exists accounting_tokens_provider_check;
    alter table public.accounting_tokens
      add constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks', 'hubspot'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'external_links_provider_check' and pg_get_constraintdef(oid) like '%hubspot%') then
    alter table public.external_links drop constraint if exists external_links_provider_check;
    alter table public.external_links
      add constraint external_links_provider_check check (provider in ('xero', 'quickbooks', 'hubspot'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'external_links_object_type_check' and pg_get_constraintdef(oid) like '%company%') then
    alter table public.external_links drop constraint if exists external_links_object_type_check;
    alter table public.external_links
      add constraint external_links_object_type_check check (object_type in ('contact', 'bill', 'company', 'deal'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_sync_cursors_object_type_check' and pg_get_constraintdef(oid) like '%deal%') then
    alter table public.accounting_sync_cursors drop constraint if exists accounting_sync_cursors_object_type_check;
    alter table public.accounting_sync_cursors
      add constraint accounting_sync_cursors_object_type_check check (object_type in ('contact', 'bill', 'company', 'deal'));
  end if;
end $$;

create unique index if not exists accounting_connections_hubspot_one_workspace
  on public.accounting_connections (provider, external_org_id)
  where provider = 'hubspot' and status <> 'revoked';

create or replace function public.accounting_connections_by_external(p_provider text, p_external_org_ids text[])
returns table (org_id uuid, connection_id uuid, external_org_id text, status text, next_sync_after timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.org_id, c.id, c.external_org_id, c.status, c.next_sync_after
    from public.accounting_connections c
   where c.provider = p_provider
     and c.external_org_id = any (coalesce(p_external_org_ids, '{}'::text[]))
     and c.status <> 'revoked'
   order by c.connected_at
   limit 500;
$$;

revoke execute on function public.accounting_connections_by_external(text, text[]) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.accounting_connections_by_external(text, text[]) to service_role;

create table if not exists public.crm_deals (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  connection_id        uuid not null,
  external_id          text not null constraint crm_deals_external_id_check check (char_length(external_id) between 1 and 100),
  name                 text not null constraint crm_deals_name_check check (char_length(name) between 1 and 200),
  -- Null when the CRM has no amount for the deal.
  amount               numeric(24, 6) constraint crm_deals_amount_check check (amount is null or amount >= 0),
  currency             text constraint crm_deals_currency_check check (currency is null or currency ~ '^[A-Z]{3}$'),
  close_on             date,
  pipeline_id          text constraint crm_deals_pipeline_id_check check (pipeline_id is null or char_length(pipeline_id) between 1 and 100),
  pipeline_label       text constraint crm_deals_pipeline_label_check check (pipeline_label is null or char_length(pipeline_label) between 1 and 200),
  stage_id             text constraint crm_deals_stage_id_check check (stage_id is null or char_length(stage_id) between 1 and 100),
  stage_label          text constraint crm_deals_stage_label_check check (stage_label is null or char_length(stage_label) between 1 and 200),
  -- What the stage means: still open, closed won, or closed lost.
  stage_state          text not null constraint crm_deals_stage_state_check check (stage_state in ('open', 'won', 'lost')),
  company_external_id  text constraint crm_deals_company_external_id_check check (company_external_id is null or char_length(company_external_id) between 1 and 100),
  company_name         text constraint crm_deals_company_name_check check (company_name is null or char_length(company_name) between 1 and 200),
  -- The company's main contact's email, offered as the customer's billing email only for a person to confirm.
  company_email        text constraint crm_deals_company_email_check check (company_email is null or char_length(company_email) between 3 and 320),
  -- Whether the CRM still has the deal: a deleted one is no longer returned by it.
  source_status        text not null default 'present' constraint crm_deals_source_status_check check (source_status in ('present', 'deleted')),
  external_version     text constraint crm_deals_external_version_check check (external_version is null or char_length(external_version) between 1 and 64),
  external_updated_at  timestamptz,
  -- The Vestiarion deal a person made of it, and when.
  deal_id              uuid,
  linked_at            timestamptz,
  -- The CRM's facts the deal was planned from, or last reviewed at: changes are shown against them.
  baseline             jsonb constraint crm_deals_baseline_check
                         check (baseline is null or (jsonb_typeof(baseline) = 'object' and octet_length(baseline::text) <= 2000)),
  -- The changes last recorded in the ledger, so the same ones are not recorded twice.
  flagged              jsonb constraint crm_deals_flagged_check
                         check (flagged is null or (jsonb_typeof(flagged) = 'array' and octet_length(flagged::text) <= 4000)),
  reviewed_at          timestamptz,
  reviewed_by          uuid references auth.users(id) on delete set null,
  first_seen_at        timestamptz not null default now(),
  changed_at           timestamptz not null default now(),
  constraint crm_deals_org_id_key unique (org_id, id),
  constraint crm_deals_external_key unique (org_id, connection_id, external_id),
  constraint crm_deals_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade,
  constraint crm_deals_deal_fkey foreign key (org_id, deal_id)
    references public.deals (org_id, id) on delete set null (deal_id)
);

create unique index if not exists crm_deals_deal_key on public.crm_deals (org_id, deal_id) where deal_id is not null;
create index if not exists crm_deals_review_idx on public.crm_deals (org_id, connection_id, stage_state, source_status);

alter table public.crm_deals enable row level security;
revoke all privileges on table public.crm_deals from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.crm_deals to vestiarion_tenant;
grant all privileges on table public.crm_deals to service_role;
drop policy if exists tenant_isolation on public.crm_deals;
create policy tenant_isolation on public.crm_deals for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.crm_deals;
create policy tenant_isolation_guard on public.crm_deals as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.crm_deals;
-- drop index if exists public.accounting_connections_hubspot_one_workspace;
-- (keep accounting_connections_by_external while the QuickBooks connector uses it)
-- and the 0101 checks without hubspot, company and deal, once no row holds them.
