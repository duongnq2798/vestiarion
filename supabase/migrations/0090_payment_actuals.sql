-- What the business really paid (docs/superpowers/specs/2026-10-10-actual-payments-design.md A2).
--
-- payment_actuals: how the business paid a payable outside Vestiarion, as a member recorded it: the day paid, the
-- amount and currency as paid, the method, a reference and a note; or that it did not pay it, with a reason. A change
-- appends a correction naming the record it replaces, so the history is kept and nothing is edited in place: the
-- tenant role may only read and insert. One first record per bill and one correction per record keep the history one
-- line, so two people correcting the same record at once cannot fork it. Composite foreign keys keep a record in its
-- bill's workspace, and a correction about the same bill. The app records each one as a signed ledger entry.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.payment_actuals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  invoice_id  uuid not null,
  outcome     text not null constraint payment_actuals_outcome_check check (outcome in ('paid', 'not_paid')),
  paid_on     date,
  amount      numeric(24, 6) constraint payment_actuals_amount_check check (amount is null or amount > 0),
  currency    text constraint payment_actuals_currency_check check (currency is null or currency ~ '^[A-Z]{3}$' or currency in ('USDC', 'EURC')),
  method      text constraint payment_actuals_method_check check (method is null or method in ('bank_transfer', 'card', 'cash', 'other')),
  reference   text constraint payment_actuals_reference_check check (reference is null or char_length(reference) between 1 and 140),
  note        text constraint payment_actuals_note_check check (note is null or char_length(note) between 1 and 280),
  reason      text constraint payment_actuals_reason_check check (reason is null or char_length(reason) between 1 and 280),
  replaces    uuid,
  source      text not null default 'form' constraint payment_actuals_source_check check (source in ('form', 'csv')),
  recorded_by uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default now(),
  constraint payment_actuals_outcome_fields check (
    (outcome = 'paid' and paid_on is not null and amount is not null and currency is not null and method is not null and reason is null)
    or (outcome = 'not_paid' and paid_on is null and amount is null and currency is null and method is null and reason is not null)
  ),
  constraint payment_actuals_org_invoice_id_key unique (org_id, invoice_id, id),
  constraint payment_actuals_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint payment_actuals_replaces_fkey foreign key (org_id, invoice_id, replaces)
    references public.payment_actuals (org_id, invoice_id, id) on delete cascade
);

-- The history is one line: one first record per bill, and each record corrected at most once.
create unique index if not exists payment_actuals_first_per_invoice on public.payment_actuals (org_id, invoice_id) where replaces is null;
create unique index if not exists payment_actuals_one_correction on public.payment_actuals (org_id, replaces) where replaces is not null;

alter table public.payment_actuals enable row level security;
revoke all privileges on table public.payment_actuals from anon, authenticated, vestiarion_tenant;
grant select, insert on table public.payment_actuals to vestiarion_tenant;
grant all privileges on table public.payment_actuals to service_role;

drop policy if exists tenant_isolation on public.payment_actuals;
create policy tenant_isolation on public.payment_actuals for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.payment_actuals;
create policy tenant_isolation_guard on public.payment_actuals as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.payment_actuals;
