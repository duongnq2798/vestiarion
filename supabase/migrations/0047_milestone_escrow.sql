-- Milestone escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md §4).
--
-- escrow_contracts holds a workspace's escrow contract on Arc testnet: one per
-- workspace, deployed through Circle's Smart Contract Platform from an EOA
-- deployer the operating wallet gives gas to (E2). Its address is null while
-- the deployment is under way, so a setup that was interrupted resumes from
-- the Circle ids it recorded instead of deploying twice.
--
-- A milestone records its hold: whether it is funded, released or refunded,
-- the amount and refund date it was funded with, and each transaction (E3–E5).
--
-- payment_intents.payout_route gains 'escrow': a milestone paid by releasing
-- its hold keeps that route on every later attempt, so a release whose answer
-- was lost is never followed by a transfer.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.
-- It redefines 0045's payout_route check; re-running 0045 after it leaves it
-- as it is, because 0045 adds its check only when there is none.

create table if not exists public.escrow_contracts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs(id) on delete cascade
                          constraint escrow_contracts_org_id_key unique,
  address            text
                          constraint escrow_contracts_address_check check (address is null or address ~ '^0x[0-9a-fA-F]{40}$'),
  circle_contract_id text,
  deployer_wallet_id text,
  deployer_address   text,
  gas_tx_id          text,
  deploy_tx_hash     text,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);

alter table public.escrow_contracts enable row level security;
revoke all privileges on table public.escrow_contracts from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.escrow_contracts to vestiarion_tenant;
grant all privileges on table public.escrow_contracts to service_role;

drop policy if exists tenant_isolation on public.escrow_contracts;
create policy tenant_isolation on public.escrow_contracts for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.escrow_contracts;
create policy tenant_isolation_guard on public.escrow_contracts as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

alter table public.milestones add column if not exists escrow_state text;
alter table public.milestones add column if not exists escrow_amount numeric(20, 6);
alter table public.milestones add column if not exists escrow_refund_after timestamptz;
alter table public.milestones add column if not exists escrow_fund_tx_hash text;
alter table public.milestones add column if not exists escrow_release_tx_hash text;
alter table public.milestones add column if not exists escrow_refund_tx_hash text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'milestones_escrow_state_check') then
    alter table public.milestones
      add constraint milestones_escrow_state_check check (escrow_state in ('funded', 'released', 'refunded'));
  end if;
end $$;

alter table public.payment_intents drop constraint if exists payment_intents_payout_route_check;
alter table public.payment_intents
  add constraint payment_intents_payout_route_check check (payout_route in ('cctp', 'gateway', 'escrow'));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- alter table public.payment_intents drop constraint if exists payment_intents_payout_route_check;
-- alter table public.payment_intents add constraint payment_intents_payout_route_check check (payout_route in ('cctp', 'gateway'));
-- alter table public.milestones drop constraint if exists milestones_escrow_state_check;
-- alter table public.milestones drop column if exists escrow_state, drop column if exists escrow_amount,
--   drop column if exists escrow_refund_after, drop column if exists escrow_fund_tx_hash,
--   drop column if exists escrow_release_tx_hash, drop column if exists escrow_refund_tx_hash;
-- drop table if exists public.escrow_contracts;
