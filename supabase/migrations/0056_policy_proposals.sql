-- The agent's proposals from people's overrides (docs/superpowers/specs/2026-10-02-limit-proposals-design.md §4).
--
-- policy_proposals: a change the agent proposes to its own policy because of what people decided,
-- for now only raising a counterparty's payment limit after people approved payments above it
-- (kind 'raise_limit'). It carries the limit it would replace and the one it proposes, the
-- overrides it rests on, its reasoning and the decision mode that made it, and its status: open
-- until a person accepts or dismisses it, or superseded when the limit changed some other way. At
-- most one is open per counterparty and kind. Tenant-scoped; it goes with its counterparty.

create table if not exists public.policy_proposals (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  kind             text not null default 'raise_limit' constraint policy_proposals_kind_check check (kind in ('raise_limit')),
  counterparty_id  uuid not null,
  from_limit       numeric(20, 6),
  to_limit         numeric(20, 6) not null constraint policy_proposals_to_limit_check check (to_limit > 0),
  evidence         jsonb not null default '[]'::jsonb,
  reasoning        text not null constraint policy_proposals_reasoning_check check (char_length(btrim(reasoning)) between 1 and 2000),
  decision_mode    text,
  status           text not null default 'open' constraint policy_proposals_status_check check (status in ('open', 'accepted', 'dismissed', 'superseded')),
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       uuid references auth.users(id) on delete set null,
  constraint policy_proposals_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

create unique index if not exists policy_proposals_one_open on public.policy_proposals (org_id, counterparty_id, kind) where status = 'open';

alter table public.policy_proposals enable row level security;
revoke all privileges on table public.policy_proposals from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.policy_proposals to vestiarion_tenant;
grant all privileges on table public.policy_proposals to service_role;

drop policy if exists tenant_isolation on public.policy_proposals;
create policy tenant_isolation on public.policy_proposals for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.policy_proposals;
create policy tenant_isolation_guard on public.policy_proposals as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.policy_proposals;
