-- Durable payment state separates "the agent decided to pay" from "Circle
-- confirmed settlement". One source obligation owns one deterministic
-- idempotency key, so a process retry cannot create a second transfer.

create table if not exists public.payment_intents (
  id                uuid primary key default gen_random_uuid(),
  source_type       text not null check (source_type in ('invoice', 'milestone')),
  source_id         uuid not null,
  idempotency_key   text not null unique,
  provider          text not null check (provider in ('circle', 'simulate')),
  provider_tx_id    text,
  tx_hash           text,
  amount            numeric(20, 6) not null check (amount > 0),
  destination       text not null,
  status            text not null default 'created'
                      check (status in ('created', 'submitting', 'pending', 'confirmed', 'failed')),
  attempt_count     integer not null default 0 check (attempt_count >= 0),
  last_error        text,
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_type, source_id)
);

create index if not exists payment_intents_status_idx
  on public.payment_intents (status, updated_at);
create index if not exists payment_intents_provider_tx_idx
  on public.payment_intents (provider_tx_id)
  where provider_tx_id is not null;

alter table public.payment_intents enable row level security;
revoke all privileges on table public.payment_intents from anon, authenticated;
grant all privileges on table public.payment_intents to service_role;

-- Claim submission atomically. A stale claim can be retried with the same
-- provider idempotency key after two minutes; Circle will return the original
-- transaction rather than issue another transfer.
create or replace function public.claim_payment_intent(p_idempotency_key text)
returns public.payment_intents
language plpgsql
set search_path = ''
as $$
declare
  claimed public.payment_intents;
begin
  update public.payment_intents
     set status = 'submitting',
         attempt_count = attempt_count + 1,
         last_error = null,
         updated_at = now()
   where idempotency_key = p_idempotency_key
     and (
       status in ('created', 'failed')
       or (status = 'submitting' and updated_at < now() - interval '2 minutes')
     )
  returning * into claimed;

  return claimed;
end;
$$;

revoke execute on function public.claim_payment_intent(text)
  from public, anon, authenticated;
grant execute on function public.claim_payment_intent(text)
  to service_role;
