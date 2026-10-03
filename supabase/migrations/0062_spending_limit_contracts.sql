-- The spending limit, enforced on Arc (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md §5, R2).
--
-- spending_limit_contracts holds a workspace's VestiarionSpendingLimit contract on Arc testnet: one per
-- workspace, deployed through Circle's Smart Contract Platform from an EOA deployer the operating wallet gives
-- gas to, with the agent's own wallet (a smart account holding no USDC) as the only address that may pay
-- through it. Each setup step records its Circle ids here as it completes, so a setup that was interrupted
-- resumes instead of starting over; `address` is null until the deployment is complete. `enforced` says
-- whether the agent's payments go through it now (R3, R11): turning it off keeps the row and the contract.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.spending_limit_contracts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs(id) on delete cascade
                          constraint spending_limit_contracts_org_id_key unique,
  address            text
                          constraint spending_limit_contracts_address_check check (address is null or address ~ '^0x[0-9a-fA-F]{40}$'),
  circle_contract_id text,
  deployer_wallet_id text,
  deployer_address   text,
  gas_tx_id          text,
  deploy_tx_hash     text,
  agent_wallet_id    text,
  agent_address      text
                          constraint spending_limit_contracts_agent_address_check check (agent_address is null or agent_address ~ '^0x[0-9a-fA-F]{40}$'),
  approve_tx_id      text,
  enforced           boolean not null default false,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Enforced only once deployed, with an agent and an approval behind it.
  constraint spending_limit_contracts_enforced_check check (
    not enforced or (address is not null and agent_address is not null and approve_tx_id is not null)
  )
);

alter table public.spending_limit_contracts enable row level security;
revoke all privileges on table public.spending_limit_contracts from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.spending_limit_contracts to vestiarion_tenant;
grant all privileges on table public.spending_limit_contracts to service_role;

drop policy if exists tenant_isolation on public.spending_limit_contracts;
create policy tenant_isolation on public.spending_limit_contracts for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.spending_limit_contracts;
create policy tenant_isolation_guard on public.spending_limit_contracts as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.spending_limit_contracts;
