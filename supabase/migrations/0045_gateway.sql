-- Payouts from a Gateway balance (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md).
--
-- gateway_signers holds a workspace's Gateway signer: the Circle EOA wallet
-- its operating smart-contract wallet has made a delegate on Circle's
-- GatewayWallet contract, because Gateway accepts only an EOA's signature on
-- a transfer (G1). Circle holds the key; this holds the wallet's id and
-- address, and the transaction that made it a delegate. It is a table of its
-- own, not an account: every reader of accounts would otherwise count the
-- signer's empty wallet as treasury cash. One signer per workspace.
--
-- payment_intents.payout_route is the route a payment across chains took on
-- its first attempt, kept for every later attempt (G2): a Gateway transfer
-- whose answer was lost must never be followed by a CCTP one.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.
-- It redefines no earlier migration's function.

create table if not exists public.gateway_signers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade
                        constraint gateway_signers_org_id_key unique,
  circle_wallet_id text not null,
  address          text not null
                        constraint gateway_signers_address_check check (address ~ '^0x[0-9a-fA-F]{40}$'),
  delegate_tx_id   text,
  delegate_tx_hash text,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now()
);

alter table public.gateway_signers enable row level security;
revoke all privileges on table public.gateway_signers from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.gateway_signers to vestiarion_tenant;
grant all privileges on table public.gateway_signers to service_role;

-- The tenant boundary, as 0018 writes it for every tenant table.
drop policy if exists tenant_isolation on public.gateway_signers;
create policy tenant_isolation on public.gateway_signers for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.gateway_signers;
create policy tenant_isolation_guard on public.gateway_signers as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

alter table public.payment_intents add column if not exists payout_route text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_intents_payout_route_check') then
    alter table public.payment_intents
      add constraint payment_intents_payout_route_check check (payout_route in ('cctp', 'gateway'));
  end if;
end $$;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- alter table public.payment_intents drop constraint if exists payment_intents_payout_route_check;
-- alter table public.payment_intents drop column if exists payout_route;
-- drop table if exists public.gateway_signers;
