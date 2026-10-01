-- Payment timing (docs/superpowers/specs/2026-09-30-payment-timing-design.md, §1).
--
-- Payment terms on an invoice — an early-payment discount (percent and the
-- date it lapses) — plus a date the agent has committed to pay
-- (`scheduled_for`) and what actually left (`paid_amount`). A new status,
-- 'scheduled': a payable the agent will pay on `scheduled_for`, decided
-- again each cycle until then (P3 of the design).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.invoices
  add column if not exists early_pay_discount_pct numeric(5,2),
  add column if not exists discount_due_date timestamptz,
  add column if not exists scheduled_for timestamptz,
  add column if not exists paid_amount numeric(20,6);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass and conname = 'invoices_discount_pair'
  ) then
    alter table public.invoices add constraint invoices_discount_pair
      check ((early_pay_discount_pct is null) = (discount_due_date is null));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass and conname = 'invoices_discount_pct_range'
  ) then
    alter table public.invoices add constraint invoices_discount_pct_range
      check (early_pay_discount_pct is null or (early_pay_discount_pct > 0 and early_pay_discount_pct < 100));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass and conname = 'invoices_discount_before_due'
  ) then
    -- Compared as UTC calendar dates, not instants: due_date and
    -- discount_due_date are wall-clock dates (P4 of the design), and
    -- dueDateIso (src/lib/intake-validation.ts) anchors due_date at 12:00
    -- UTC, so a same-day deadline at a later time of day must still pass.
    alter table public.invoices add constraint invoices_discount_before_due
      check (discount_due_date is null
             or (discount_due_date at time zone 'UTC')::date <= (due_date at time zone 'UTC')::date);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass and conname = 'invoices_scheduled_has_date'
  ) then
    alter table public.invoices add constraint invoices_scheduled_has_date
      check (status <> 'scheduled' or scheduled_for is not null);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass and conname = 'invoices_paid_amount_positive'
  ) then
    alter table public.invoices add constraint invoices_paid_amount_positive
      check (paid_amount is null or paid_amount > 0);
  end if;
end $$;

-- Status: add 'scheduled'. Rebuild the status check by shape, whatever it is
-- named, only while it lacks 'scheduled' (the 0025 pattern), so a replay
-- changes nothing. The shape is the allowed-values list (`status = ANY (...)`,
-- as Postgres stores `status in (...)`), so a check that only mentions
-- status, such as `invoices_scheduled_has_date` above, is never mistaken for
-- it, whichever status a later migration adds.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.invoices'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%status = ANY%'
       and pg_get_constraintdef(oid) not like '%scheduled%'
  loop
    execute format('alter table public.invoices drop constraint %I', c.conname);
  end loop;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass and conname = 'invoices_status_check'
  ) then
    alter table public.invoices add constraint invoices_status_check check (status in (
      'pending', 'matched', 'paid', 'held', 'flagged', 'awaiting_info', 'received', 'rejected', 'processing', 'scheduled'));
  end if;
end $$;

notify pgrst, 'reload schema';

-- Rollback:
-- alter table public.invoices drop constraint if exists invoices_paid_amount_positive;
-- alter table public.invoices drop constraint if exists invoices_scheduled_has_date;
-- alter table public.invoices drop constraint if exists invoices_discount_before_due;
-- alter table public.invoices drop constraint if exists invoices_discount_pct_range;
-- alter table public.invoices drop constraint if exists invoices_discount_pair;
-- alter table public.invoices drop column if exists paid_amount;
-- alter table public.invoices drop column if exists scheduled_for;
-- alter table public.invoices drop column if exists discount_due_date;
-- alter table public.invoices drop column if exists early_pay_discount_pct;
-- then re-run 0025's status check rewrite (without 'scheduled').
