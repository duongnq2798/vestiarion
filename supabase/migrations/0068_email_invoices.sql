-- Invoices by email (docs/superpowers/specs/2026-10-03-email-invoices-design.md E2, E11).
--
-- invoice_inboxes: a workspace's address, invoices-<code>@<inbound domain>, one per workspace. A platform table: only
--                  the service role reads or writes it; knowing the code lets anyone file a draft, so a tenant never
--                  reads it, and Settings shows it to an owner or admin through the platform client.
-- inbox_emails:    each email Resend received at an address, one row per email and workspace: who sent it, its
--                  subject, what was read and whether it can be added, and what a person decided. The workspace's
--                  own rows, under the tenant isolation every workspace table has.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time. 0068 was kept for this.

create table if not exists public.invoice_inboxes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null constraint invoice_inboxes_org_id_key unique references public.orgs(id) on delete cascade,
  code        text not null constraint invoice_inboxes_code_key unique
                   constraint invoice_inboxes_code_check check (code ~ '^[a-z2-7]{12}$'),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.invoice_inboxes enable row level security;
revoke all privileges on table public.invoice_inboxes from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.invoice_inboxes to service_role;

create table if not exists public.inbox_emails (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  resend_email_id  text not null constraint inbox_emails_resend_email_id_check check (char_length(resend_email_id) between 1 and 100),
  from_address     text constraint inbox_emails_from_address_check check (from_address is null or char_length(from_address) <= 320),
  subject          text constraint inbox_emails_subject_check check (subject is null or char_length(subject) <= 300),
  received_at      timestamptz not null default now(),
  status           text not null default 'received'
                        constraint inbox_emails_status_check
                        check (status in ('received', 'ready', 'needs_details', 'unreadable', 'added', 'dismissed')),
  reasons          text[] not null default '{}',
  read             jsonb,
  draft            jsonb,
  authentication   jsonb,
  invoice_id       uuid,
  decided_by       uuid references auth.users(id) on delete set null,
  decided_at       timestamptz,
  constraint inbox_emails_resend_email_key unique (org_id, resend_email_id),
  -- Composite, as every reference between workspace rows is: an email of one workspace never points at another's
  -- invoice. Only the invoice is cleared when it goes.
  constraint inbox_emails_invoice_fkey foreign key (org_id, invoice_id)
    references public.invoices (org_id, id) on delete set null (invoice_id)
);

create index if not exists inbox_emails_org_status_idx on public.inbox_emails (org_id, status, received_at desc);

alter table public.inbox_emails enable row level security;
revoke all privileges on table public.inbox_emails from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.inbox_emails to vestiarion_tenant;
grant all privileges on table public.inbox_emails to service_role;

drop policy if exists tenant_isolation on public.inbox_emails;
create policy tenant_isolation on public.inbox_emails for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.inbox_emails;
create policy tenant_isolation_guard on public.inbox_emails as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.inbox_emails;
-- drop table if exists public.invoice_inboxes;
