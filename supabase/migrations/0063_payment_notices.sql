-- Payment notices (docs/superpowers/specs/2026-10-03-payment-notices-design.md): tell the payee when they are
-- paid. Re-runnable, as every migration here: db:migrate applies them all in order.
--
-- 1. Where a counterparty hears that it was paid: one email address, optional (R1).
-- 2. Which payments it has heard about: a payment intent is claimed for its notice before the email is sent, and
--    released if the send fails (R4).

alter table public.counterparties add column if not exists notice_email text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'counterparties_notice_email_check' and conrelid = 'public.counterparties'::regclass
  ) then
    alter table public.counterparties add constraint counterparties_notice_email_check
      check (
        notice_email is null
        or (char_length(notice_email) between 3 and 254 and notice_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
      );
  end if;
end $$;

comment on column public.counterparties.notice_email is
  'Where the counterparty is told it was paid (payment notices R1); null for none. Never part of /api/v1.';

-- When the address was set: a notice is sent only for a payment confirmed after it, so setting an address never sends
-- notices for payments made before it (R7). Kept by the database, whichever code path writes the address.
alter table public.counterparties add column if not exists notice_email_set_at timestamptz;

create or replace function public.counterparty_notice_email_set_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.notice_email is null then
    new.notice_email_set_at := null;
  elsif tg_op = 'INSERT' or new.notice_email is distinct from old.notice_email then
    new.notice_email_set_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists counterparties_notice_email_set_at on public.counterparties;
create trigger counterparties_notice_email_set_at
  before insert or update of notice_email on public.counterparties
  for each row execute function public.counterparty_notice_email_set_at();

alter table public.payment_intents add column if not exists notice_sent_at timestamptz;

comment on column public.payment_intents.notice_sent_at is
  'When the payee''s payment notice was claimed and sent (payment notices R4); null until then, or after a failed send.';

-- The notices a cycle still owes: confirmed payments no notice has claimed.
create index if not exists payment_intents_notice_due
  on public.payment_intents (org_id, confirmed_at)
  where status = 'confirmed' and notice_sent_at is null;
