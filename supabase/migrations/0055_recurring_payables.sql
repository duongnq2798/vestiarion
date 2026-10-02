-- Recurring payments (docs/superpowers/specs/2026-10-02-recurring-payables-design.md R1, R2, R5, R6).
--
-- recurring_payables: a bill that repeats. Who is paid (a counterparty of the workspace), how much,
-- in USDC or EURC, what for, an optional contract or PO reference, how often (every N days, weeks or
-- months), from which first due date, until which last one, and whether each period counts as
-- delivered. next_period is the index of the next period to create an invoice for: period n is due
-- on starts_on + n periods, counted from the first, never from the last (R2). Stopped by a person, or
-- ended past its last due date.
--
-- invoices.recurring_id / recurring_period: the schedule and the period (its due date) an invoice
-- was created for. Unique together, so one period never has two invoices (R1).
--
-- Tenant-scoped like the other workspace tables. Idempotent throughout.

create table if not exists public.recurring_payables (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  counterparty_id  uuid not null,
  amount           numeric(20, 6) not null constraint recurring_payables_amount_check check (amount > 0),
  currency         text not null default 'USDC' constraint recurring_payables_currency_check check (currency in ('USDC', 'EURC')),
  memo             text not null constraint recurring_payables_memo_check check (char_length(btrim(memo)) between 1 and 160),
  po_reference     text constraint recurring_payables_po_check check (po_reference is null or char_length(po_reference) <= 100),
  goods_received   boolean not null default true,
  every_count      integer not null constraint recurring_payables_every_check check (every_count between 1 and 366),
  every_unit       text not null constraint recurring_payables_unit_check check (every_unit in ('day', 'week', 'month')),
  starts_on        date not null,
  ends_on          date,
  next_period      integer not null default 0 constraint recurring_payables_next_period_check check (next_period >= 0),
  status           text not null default 'active' constraint recurring_payables_status_check check (status in ('active', 'stopped', 'ended')),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  stopped_at       timestamptz,
  stopped_by       uuid references auth.users(id) on delete set null,
  constraint recurring_payables_ends_after_start check (ends_on is null or ends_on >= starts_on),
  constraint recurring_payables_org_id_key unique (org_id, id),
  constraint recurring_payables_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

alter table public.recurring_payables enable row level security;
revoke all privileges on table public.recurring_payables from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.recurring_payables to vestiarion_tenant;
grant all privileges on table public.recurring_payables to service_role;

drop policy if exists tenant_isolation on public.recurring_payables;
create policy tenant_isolation on public.recurring_payables for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.recurring_payables;
create policy tenant_isolation_guard on public.recurring_payables as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

alter table public.invoices
  add column if not exists recurring_id uuid,
  add column if not exists recurring_period date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_recurring_fkey' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices add constraint invoices_recurring_fkey foreign key (org_id, recurring_id)
      references public.recurring_payables (org_id, id) on delete set null (recurring_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_recurring_pair' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices add constraint invoices_recurring_pair check ((recurring_id is null) = (recurring_period is null) or recurring_id is null);
  end if;
end $$;

create unique index if not exists invoices_recurring_period_key on public.invoices (recurring_id, recurring_period) where recurring_id is not null;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop index if exists public.invoices_recurring_period_key;
-- alter table public.invoices drop constraint if exists invoices_recurring_pair, drop constraint if exists invoices_recurring_fkey;
-- alter table public.invoices drop column if exists recurring_period, drop column if exists recurring_id;
-- drop table if exists public.recurring_payables;
