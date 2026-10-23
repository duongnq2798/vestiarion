-- Late fees (docs/superpowers/specs/2026-10-23-late-fees-design.md LF1): a payable's late-payment term, as its supplier
-- wrote it on the invoice. A percent a month on what is still owed, or a fixed amount in the invoice's currency, from the
-- first day it applies. The agent weighs it when a bill waits and when short cash is spent; it never pays it: a late fee
-- is never added to a transfer.
--
-- Three nullable columns on invoices, set together or not at all. Receivables carry none: the term is for payables only.
-- Re-runnable, as every migration here: db:migrate applies them all in order. No function or view of an earlier
-- migration is redefined; the one function here is this migration's own.

alter table public.invoices
  add column if not exists late_fee_kind text,
  add column if not exists late_fee_value numeric(20,6),
  add column if not exists late_fee_starts_on date;

comment on column public.invoices.late_fee_kind is
  'A payable''s late fee (late fees LF1): percent_month, a percent a month of what is still owed, or fixed, an amount in the invoice''s currency; null for none.';
comment on column public.invoices.late_fee_value is
  'The late fee''s percent a month (more than 0, at most 10), or its fixed amount (more than 0, at most the invoice''s amount).';
comment on column public.invoices.late_fee_starts_on is
  'The first day the late fee applies, a UTC day on or after the due date''s: the day after the due date when none was given.';

-- The checks, dropped and added again so a re-run leaves them as written here. Checks run in the order of their names.
alter table public.invoices drop constraint if exists invoices_late_fee_kind_check;
alter table public.invoices add constraint invoices_late_fee_kind_check
  check (late_fee_kind is null or late_fee_kind in ('percent_month', 'fixed'));

alter table public.invoices drop constraint if exists invoices_late_fee_complete;
alter table public.invoices add constraint invoices_late_fee_complete
  check ((late_fee_kind is null) = (late_fee_value is null) and (late_fee_kind is null) = (late_fee_starts_on is null));

alter table public.invoices drop constraint if exists invoices_late_fee_value_range;
alter table public.invoices add constraint invoices_late_fee_value_range
  check (
    late_fee_kind is null
    or (late_fee_kind = 'percent_month' and late_fee_value > 0 and late_fee_value <= 10)
    or (late_fee_kind = 'fixed' and late_fee_value > 0 and late_fee_value <= amount)
  );

-- Compared as UTC calendar dates, as invoices_discount_before_due (0038) compares the discount's: dueDateIso
-- (src/lib/intake-validation.ts) anchors due_date at 12:00 UTC.
alter table public.invoices drop constraint if exists invoices_late_fee_after_due;
alter table public.invoices add constraint invoices_late_fee_after_due
  check (late_fee_starts_on is null or late_fee_starts_on >= (due_date at time zone 'UTC')::date);

alter table public.invoices drop constraint if exists invoices_late_fee_payable;
alter table public.invoices add constraint invoices_late_fee_payable
  check (late_fee_kind is null or direction = 'payable');

-- The start, kept by the database whichever code path writes the row. A term given without one starts the day after
-- the due date. When the due date alone moves, as it does when a supplier agrees to more time (0128's
-- accept_term_request, 0130's answer_term_counter), the start moves by the same days, so the term keeps its days of
-- grace and the after-due check holds. A start set in the same change is taken as given.
create or replace function public.invoices_late_fee_start()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.late_fee_kind is null then
    return new;
  end if;
  if new.late_fee_starts_on is null then
    new.late_fee_starts_on := (new.due_date at time zone 'UTC')::date + 1;
  elsif tg_op = 'UPDATE'
        and new.late_fee_starts_on = old.late_fee_starts_on
        and new.due_date is distinct from old.due_date then
    new.late_fee_starts_on := new.late_fee_starts_on
      + ((new.due_date at time zone 'UTC')::date - (old.due_date at time zone 'UTC')::date);
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_late_fee_start on public.invoices;
create trigger invoices_late_fee_start
  before insert or update of due_date, late_fee_kind, late_fee_value, late_fee_starts_on on public.invoices
  for each row execute function public.invoices_late_fee_start();

notify pgrst, 'reload schema';

-- Rollback:
-- drop trigger if exists invoices_late_fee_start on public.invoices;
-- drop function if exists public.invoices_late_fee_start();
-- alter table public.invoices drop constraint if exists invoices_late_fee_payable;
-- alter table public.invoices drop constraint if exists invoices_late_fee_after_due;
-- alter table public.invoices drop constraint if exists invoices_late_fee_value_range;
-- alter table public.invoices drop constraint if exists invoices_late_fee_complete;
-- alter table public.invoices drop constraint if exists invoices_late_fee_kind_check;
-- alter table public.invoices drop column if exists late_fee_starts_on;
-- alter table public.invoices drop column if exists late_fee_value;
-- alter table public.invoices drop column if exists late_fee_kind;
