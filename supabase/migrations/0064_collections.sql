-- The agent reminds clients of what they owe (docs/superpowers/specs/2026-10-03-collections-design.md §4).
--
-- receivable_links gains:
--   token_enc               the link's token, encrypted under the platform master key (R2), so the link can be
--                           shown again and carried by every reminder; null for a link made before this;
--   reminders_on_at / _by   when, and by whom, reminders were turned on (R1); null while they are off;
--   reminder_deferred_until until when the agent chose to wait before deciding again (R5).
--
-- ar_reminders: each reminder sent, claimed before it is sent (R7): one row per receivable and number, 1 to 4.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.receivable_links add column if not exists token_enc jsonb;
alter table public.receivable_links add column if not exists reminders_on_at timestamptz;
alter table public.receivable_links add column if not exists reminders_on_by uuid references auth.users(id) on delete set null;
alter table public.receivable_links add column if not exists reminder_deferred_until timestamptz;

create table if not exists public.ar_reminders (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  invoice_id  uuid not null,
  number      smallint not null
                   constraint ar_reminders_number_check check (number between 1 and 4),
  tone        text not null
                   constraint ar_reminders_tone_check check (tone in ('friendly', 'firm', 'final')),
  sent_at     timestamptz not null default now(),
  constraint ar_reminders_invoice_number_key unique (org_id, invoice_id, number),
  constraint ar_reminders_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade
);

alter table public.ar_reminders enable row level security;
revoke all privileges on table public.ar_reminders from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.ar_reminders to vestiarion_tenant;
grant all privileges on table public.ar_reminders to service_role;

drop policy if exists tenant_isolation on public.ar_reminders;
create policy tenant_isolation on public.ar_reminders for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.ar_reminders;
create policy tenant_isolation_guard on public.ar_reminders as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.ar_reminders;
-- alter table public.receivable_links drop column if exists reminder_deferred_until, drop column if exists reminders_on_by,
--   drop column if exists reminders_on_at, drop column if exists token_enc;
