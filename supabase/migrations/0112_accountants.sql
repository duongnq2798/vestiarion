-- The accountant role, and what a workspace used (docs/superpowers/specs/2026-10-13-accountant-console-design.md).
--
-- memberships.role and invitations.role: a fifth role, 'accountant', an outside accountant or bookkeeper (A1). What it
-- may do is the app's permission map (src/lib/auth/roles.ts): it reads everything, books payments in the accounting tool
-- and does the receivables bookkeeping, and decides no payment. Here it only becomes a value a membership or an
-- invitation may hold, ranked with the approver, so an owner or an admin may grant it and nobody else. Every existing
-- membership and invitation keeps its role: the checks only add a value. The functions in 0025, 0061, 0076 and 0077
-- that name the deciding roles ('owner', 'admin', 'approver') are unchanged, so an accountant never decides a payment
-- or pauses the agent there either.
--
-- usage_events: one row per thing a workspace used that costs the platform or the business something (U1): a model
-- call for a decision, a Circle transfer, an x402 purchase, an email, a connector sync. Counts, the tokens a model
-- reported, and a cost where one is known, in its own currency (USD for a model's price, USDC for an x402 price), never
-- converted. Attribution and display only: nothing reads it to charge or to stop anything. The tenant role may insert
-- and read; nothing is changed or deleted but with the workspace.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- A1: the role. The constraints are the ones 0015 created inline, under Postgres's own names; each is replaced once,
-- while it does not name the accountant yet, so a re-run leaves it alone.
do $$
declare
  t text;
begin
  foreach t in array array['memberships', 'invitations'] loop
    if not exists (
      select 1 from pg_constraint
       where conrelid = format('public.%I', t)::regclass and conname = t || '_role_check'
         and pg_get_constraintdef(oid) like '%accountant%'
    ) then
      execute format('alter table public.%I drop constraint if exists %I', t, t || '_role_check');
      execute format(
        'alter table public.%I add constraint %I check (role in (''owner'', ''admin'', ''approver'', ''accountant'', ''viewer''))',
        t, t || '_role_check');
    end if;
  end loop;
end $$;

-- Mirrors RANK in src/lib/auth/roles.ts: the accountant ranks with the approver, below an admin.
create or replace function public.role_rank(p_role text) returns int
language sql immutable
set search_path = ''
as $$
  select case p_role when 'owner' then 4 when 'admin' then 3 when 'approver' then 2 when 'accountant' then 2 when 'viewer' then 1 end
$$;

-- Mirrors canAssignRole in src/lib/auth/roles.ts. A role the rank does not know is never assignable: false, not null,
-- so `if not can_assign_role(...)` refuses it rather than letting it through.
create or replace function public.can_assign_role(p_actor_role text, p_target_role text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when public.role_rank(p_target_role) is null then false
    when p_actor_role = 'owner' then true
    when p_actor_role = 'admin' then public.role_rank(p_target_role) < public.role_rank('admin')
    else false
  end
$$;

-- U1: what a workspace used.
create table if not exists public.usage_events (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  kind           text not null constraint usage_events_kind_check
                   check (kind in ('model_call', 'circle_transfer', 'x402_purchase', 'email', 'connector_sync')),
  -- What it was for: 'decision', 'payment', 'treasury', 'invitation', 'xero', ... (the app's own words, never free text).
  action         text not null constraint usage_events_action_check check (action ~ '^[a-z][a-z0-9_]{0,39}$'),
  provider       text constraint usage_events_provider_check check (provider is null or provider ~ '^[a-z][a-z0-9_.-]{0,39}$'),
  model          text constraint usage_events_model_check check (model is null or char_length(model) between 1 and 80),
  quantity       integer not null default 1 constraint usage_events_quantity_check check (quantity between 1 and 1000000),
  input_tokens   integer constraint usage_events_input_tokens_check check (input_tokens is null or input_tokens between 0 and 100000000),
  output_tokens  integer constraint usage_events_output_tokens_check check (output_tokens is null or output_tokens between 0 and 100000000),
  cost           numeric(20, 6) constraint usage_events_cost_check check (cost is null or cost between 0 and 1000000000),
  cost_currency  text constraint usage_events_cost_currency_check check (cost_currency is null or cost_currency in ('USD', 'USDC', 'EURC')),
  ok             boolean not null default true,
  occurred_at    timestamptz not null default now(),
  constraint usage_events_org_id_key unique (org_id, id),
  -- A cost always says its currency, and a currency is never given without a cost.
  constraint usage_events_cost_pair check ((cost is null) = (cost_currency is null))
);

create index if not exists usage_events_org_month on public.usage_events (org_id, occurred_at);

-- Row level security as every tenant table: a permissive policy and a restrictive guard, both on request_org_id().
do $$
begin
  alter table public.usage_events enable row level security;
  revoke all privileges on table public.usage_events from anon, authenticated, vestiarion_tenant;
  grant all privileges on table public.usage_events to service_role;
  drop policy if exists tenant_isolation on public.usage_events;
  create policy tenant_isolation on public.usage_events for all to vestiarion_tenant
    using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
  drop policy if exists tenant_isolation_guard on public.usage_events;
  create policy tenant_isolation_guard on public.usage_events as restrictive for all to vestiarion_tenant
    using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
end $$;

-- Append-only for the tenant role: a record of use is added and read, never changed.
grant select, insert on table public.usage_events to vestiarion_tenant;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts), once no membership or invitation holds 'accountant':
-- drop table if exists public.usage_events;
-- re-run 0021's role_rank and can_assign_role;
-- alter table public.memberships drop constraint memberships_role_check;
-- alter table public.memberships add constraint memberships_role_check check (role in ('owner', 'admin', 'approver', 'viewer'));
-- alter table public.invitations drop constraint invitations_role_check;
-- alter table public.invitations add constraint invitations_role_check check (role in ('owner', 'admin', 'approver', 'viewer'));
