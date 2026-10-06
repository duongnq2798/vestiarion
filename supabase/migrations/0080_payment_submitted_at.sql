-- When a payment's current attempt was sent (docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md D2), so
-- the transfer watch can tell a person about one that has not confirmed. `created_at` covers only the first attempt,
-- and every reconcile rewrites `executed_at` and `updated_at`. A trigger stamps the time whenever a row becomes
-- `submitting`: a first send, a retry after begin_payment_retry, or a claim taken again after its window. No function is
-- redefined. Rows already in flight are backfilled from when they were executed. Idempotent: db:migrate runs every file.

alter table public.payment_intents add column if not exists submitted_at timestamptz;

update public.payment_intents
   set submitted_at = coalesce(executed_at, created_at)
 where submitted_at is null
   and status in ('submitting', 'pending');

create or replace function public.payment_intents_stamp_submitted()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'submitting' and (tg_op = 'INSERT' or old.status is distinct from 'submitting') then
    new.submitted_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists payment_intents_submitted on public.payment_intents;
create trigger payment_intents_submitted
  before insert or update of status on public.payment_intents
  for each row execute function public.payment_intents_stamp_submitted();

-- The watch reads live payments in flight by when they were sent.
create index if not exists payment_intents_in_flight on public.payment_intents (submitted_at)
  where status in ('submitting', 'pending') and provider_mode = 'live';

comment on column public.payment_intents.submitted_at is
  'When the current attempt was sent: stamped when the row becomes submitting (0080). The transfer watch reads it.';
