-- The agent's spending limit (docs/superpowers/specs/2026-10-02-outflow-budget-design.md R7).
--
-- One row per workspace: what the agent may pay on its own per UTC day and per 7 days, in USDC.
-- Each figure is positive or null (no limit); when both are set the 7-day one is at least the
-- daily one. Owners and admins change it through the app, which records each change in the
-- ledger. It goes with its workspace; seen and written only by its own workspace.

create table if not exists public.agent_budgets (
  org_id       uuid primary key references public.orgs(id) on delete cascade,
  daily_usdc   numeric(20, 6) constraint agent_budgets_daily_usdc_check check (daily_usdc is null or daily_usdc > 0),
  weekly_usdc  numeric(20, 6) constraint agent_budgets_weekly_usdc_check check (weekly_usdc is null or weekly_usdc > 0),
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  constraint agent_budgets_weekly_covers_daily check (daily_usdc is null or weekly_usdc is null or weekly_usdc >= daily_usdc)
);

alter table public.agent_budgets enable row level security;
revoke all privileges on table public.agent_budgets from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.agent_budgets to vestiarion_tenant;
grant all privileges on table public.agent_budgets to service_role;

drop policy if exists tenant_isolation on public.agent_budgets;
create policy tenant_isolation on public.agent_budgets for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.agent_budgets;
create policy tenant_isolation_guard on public.agent_budgets as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.agent_budgets;
