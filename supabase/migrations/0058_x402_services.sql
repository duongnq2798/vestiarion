-- The agent buys payee history over x402 (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md §4).
--
-- service_purchases: each history the workspace's agent bought, or tried to, before a first payment to an
-- address (R3, R7): the address, the seller's URL, the price, who paid whom, the authorization's nonce,
-- Gateway's settlement, the answer, or why it was refused or failed. Written once, never rewritten.
--
-- x402_sales: each history Vestiarion sold (R7). Platform only: no workspace reads another's buyers.
--
-- payee_history(address): R1's aggregate over every workspace's confirmed live payments to the address:
-- how many workspaces, how many payments, the first and the last. No amounts, no workspace. Service role
-- only; the seller's route calls it once a payment has settled.
--
-- Idempotent throughout.

create table if not exists public.service_purchases (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  counterparty_id  uuid not null,
  address          text not null,
  seller_url       text not null,
  price_usdc       numeric(20, 6),
  payer            text,
  pay_to           text,
  nonce            text,
  status           text not null constraint service_purchases_status_check check (status in ('paid', 'refused', 'failed')),
  settlement       text,
  result           jsonb,
  reason           text,
  created_at       timestamptz not null default now(),
  constraint service_purchases_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

create index if not exists service_purchases_address_idx on public.service_purchases (org_id, lower(address), created_at desc);

alter table public.service_purchases enable row level security;
revoke all privileges on table public.service_purchases from anon, authenticated, vestiarion_tenant;
-- History: read and added to, never rewritten.
grant select, insert on table public.service_purchases to vestiarion_tenant;
grant all privileges on table public.service_purchases to service_role;

drop policy if exists tenant_isolation on public.service_purchases;
create policy tenant_isolation on public.service_purchases for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.service_purchases;
create policy tenant_isolation_guard on public.service_purchases as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create table if not exists public.x402_sales (
  id           uuid primary key default gen_random_uuid(),
  endpoint     text not null,
  address      text not null,
  payer        text not null,
  pay_to       text not null,
  amount_usdc  numeric(20, 6) not null constraint x402_sales_amount_check check (amount_usdc > 0),
  nonce        text not null constraint x402_sales_nonce_key unique,
  settlement   text,
  created_at   timestamptz not null default now()
);

alter table public.x402_sales enable row level security;
revoke all privileges on table public.x402_sales from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.x402_sales to service_role;

create or replace function public.payee_history(p_address text) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspacesPaid', count(distinct pi.org_id),
    'paymentsConfirmed', count(*),
    'firstPaidAt', min(coalesce(pi.confirmed_at, pi.executed_at)),
    'lastPaidAt', max(coalesce(pi.confirmed_at, pi.executed_at))
  )
  from public.payment_intents pi
  where lower(pi.destination) = lower(p_address)
    and pi.status = 'confirmed'
    and pi.provider_mode = 'live';
$$;

revoke execute on function public.payee_history(text) from public, anon, authenticated;
grant execute on function public.payee_history(text) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.payee_history(text);
-- drop table if exists public.x402_sales;
-- drop table if exists public.service_purchases;
