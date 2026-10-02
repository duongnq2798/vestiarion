-- Batch payouts (docs/superpowers/specs/2026-10-02-batch-payouts-design.md R4, R5, §4).
--
-- payment_intents.batch_key / batch_size / batch_sent_at: the batch a payment's first attempt was
-- sent in, one Circle contract execution on Arc's Multicall3From for several payments. Written on
-- every member at once, in one UPDATE, before Circle is called; the key is also the transaction's
-- refId, so a batch whose answer was lost is found on Circle rather than sent again. Null for a
-- payment sent alone, which is every payment before this.
--
-- No new grants: the tenant role's table privileges on payment_intents cover new columns.
-- Idempotent throughout.

alter table public.payment_intents
  add column if not exists batch_key text,
  add column if not exists batch_size integer,
  add column if not exists batch_sent_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_intents_batch_check' and conrelid = 'public.payment_intents'::regclass) then
    alter table public.payment_intents add constraint payment_intents_batch_check check (
      (batch_key is null and batch_size is null and batch_sent_at is null)
      or (batch_key is not null and batch_size is not null and batch_sent_at is not null and batch_size between 2 and 20)
    );
  end if;
end $$;

create index if not exists payment_intents_batch_key_idx on public.payment_intents (org_id, batch_key) where batch_key is not null;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop index if exists public.payment_intents_batch_key_idx;
-- alter table public.payment_intents drop constraint if exists payment_intents_batch_check;
-- alter table public.payment_intents drop column if exists batch_sent_at, drop column if exists batch_size, drop column if exists batch_key;
