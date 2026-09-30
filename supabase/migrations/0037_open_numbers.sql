-- Open numbers (docs/superpowers/specs/2026-09-30-open-numbers-design.md).
--
-- platform_team lists the people who build and run Vestiarion. A workspace is
-- a customer's only when someone outside that list created it; the founding
-- workspace, a team member's, and one whose creator deleted their account
-- (created_by set null by 0023) are counted as ours, so the rule can only
-- under-count customers, never inflate them (R3).
--
-- open_numbers(p_since) is the one reader that crosses workspaces (R2). It is a
-- security definer function returning a single jsonb document of aggregates:
-- no row of a customer's workspace leaves it, only counts and sums, and only
-- our own workspaces' payments are listed with their hashes (R6). Payments are
-- settled Arc payments only (R4); sample counterparties never count (R5); a
-- null p_since means all time.
--
-- set_platform_team_member() and platform_team_members() maintain the list
-- for `npm run numbers -- team …`. All three run for the service role only.
--
-- 0036 is taken by an open branch; this file does not depend on it.
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.platform_team (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table public.platform_team enable row level security;
revoke all privileges on table public.platform_team from anon, authenticated;
grant all privileges on table public.platform_team to service_role;

-- Adds (p_member true) or removes a person by the email they sign in with.
-- Returns whether anything changed, so adding twice says so.
create or replace function public.set_platform_team_member(p_email text, p_member boolean) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid;
  v_changed int;
begin
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'user_not_found: no account with that email';
  end if;
  if p_member then
    insert into public.platform_team (user_id) values (v_user) on conflict (user_id) do nothing;
  else
    delete from public.platform_team where user_id = v_user;
  end if;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.platform_team_members() returns table (email text, added_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text, t.added_at
    from public.platform_team t
    join auth.users u on u.id = t.user_id
   order by t.added_at, u.email
$$;

create or replace function public.open_numbers(p_since timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with
  org_side as (
    select o.id, o.mode, o.created_at,
           case when o.created_by is not null
                 and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
                then 'customers' else 'ours' end as side
      from public.orgs o
  ),
  sides (side) as (values ('customers'), ('ours'), ('total')),
  pay as (
    select s.side, p.amount, lower(p.destination) as payee, p.tx_hash, p.chain,
           coalesce(p.executed_at, p.confirmed_at, p.updated_at) as at
      from public.payment_intents p
      join org_side s on s.id = p.org_id
     where p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed'
       and coalesce(p.executed_at, p.confirmed_at, p.updated_at) >= coalesce(p_since, '-infinity'::timestamptz)
  ),
  person as (
    select distinct m.user_id,
           case when exists (select 1 from public.platform_team t where t.user_id = m.user_id)
                then 'ours' else 'customers' end as side
      from public.memberships m
  ),
  inv as (
    select s.side
      from public.invoices i
      join org_side s on s.id = i.org_id
      join public.counterparties c on c.id = i.counterparty_id
     where i.decided_at is not null
       and i.decided_at >= coalesce(p_since, '-infinity'::timestamptz)
       and not c.sample
  ),
  mil as (
    select s.side
      from public.milestones m
      join org_side s on s.id = m.org_id
      join public.counterparties c on c.id = m.contractor_id
     where m.status = 'paid'
       and coalesce(m.settled_at, m.decided_at, m.created_at) >= coalesce(p_since, '-infinity'::timestamptz)
       and not c.sample
  ),
  run as (
    select s.side, r.model_decision_count, r.reference_disagreement_count, r.guardrail_override_count
      from public.cycle_runs r
      join org_side s on s.id = r.org_id
     where r.started_at >= coalesce(p_since, '-infinity'::timestamptz)
  ),
  wallet as (
    select s.side, a.balance
      from public.accounts a
      join org_side s on s.id = a.org_id
     where s.mode = 'live' and a.circle_wallet_id is not null and a.token = 'USDC'
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'sides', (
      select jsonb_object_agg(sd.side, jsonb_build_object(
        'workspacesOpened',   (select count(*) from org_side o where sd.side in ('total', o.side)
                                  and o.created_at >= coalesce(p_since, '-infinity'::timestamptz)),
        'liveWorkspaces',     (select count(*) from org_side o where sd.side in ('total', o.side) and o.mode = 'live'),
        'people',             (select count(distinct x.user_id) from person x where sd.side in ('total', x.side)),
        'payments',           (select count(*) from pay x where sd.side in ('total', x.side)),
        'usdcPaid',           (select coalesce(sum(x.amount), 0) from pay x where sd.side in ('total', x.side)),
        'payees',             (select count(distinct x.payee) from pay x where sd.side in ('total', x.side)),
        'invoicesDecided',    (select count(*) from inv x where sd.side in ('total', x.side)),
        'milestonesReleased', (select count(*) from mil x where sd.side in ('total', x.side)),
        'cycles',             (select count(*) from run x where sd.side in ('total', x.side)),
        'modelDecisions',     (select coalesce(sum(x.model_decision_count), 0) from run x where sd.side in ('total', x.side)),
        'policyDepartures',   (select coalesce(sum(x.reference_disagreement_count), 0) from run x where sd.side in ('total', x.side)),
        'refusedByCode',      (select coalesce(sum(x.guardrail_override_count), 0) from run x where sd.side in ('total', x.side)),
        'usdcInWallets',      (select coalesce(sum(x.balance), 0) from wallet x where sd.side in ('total', x.side))
      ))
        from sides sd
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', d.day, 'customers', d.customers, 'ours', d.ours,
               'customersUsdc', d.customers_usdc, 'oursUsdc', d.ours_usdc) order by d.day), '[]'::jsonb)
        from (select to_char(x.at at time zone 'UTC', 'YYYY-MM-DD') as day,
                     count(*) filter (where x.side = 'customers') as customers,
                     count(*) filter (where x.side = 'ours') as ours,
                     coalesce(sum(x.amount) filter (where x.side = 'customers'), 0) as customers_usdc,
                     coalesce(sum(x.amount) filter (where x.side = 'ours'), 0) as ours_usdc
                from pay x
               group by 1) d
    ),
    'ourPayments', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'at', y.at, 'amount', y.amount, 'txHash', y.tx_hash, 'chain', y.chain) order by y.at desc), '[]'::jsonb)
        from (select x.at, x.amount, x.tx_hash, x.chain
                from pay x
               where x.side = 'ours' and x.tx_hash is not null
               order by x.at desc
               limit 20) y
    )
  )
$$;

revoke execute on function public.open_numbers(timestamptz) from public, anon, authenticated;
grant execute on function public.open_numbers(timestamptz) to service_role;
revoke execute on function public.set_platform_team_member(text, boolean) from public, anon, authenticated;
grant execute on function public.set_platform_team_member(text, boolean) to service_role;
revoke execute on function public.platform_team_members() from public, anon, authenticated;
grant execute on function public.platform_team_members() to service_role;

-- Rollback:
-- drop function if exists public.open_numbers(timestamptz);
-- drop function if exists public.platform_team_members();
-- drop function if exists public.set_platform_team_member(text, boolean);
-- drop table if exists public.platform_team;
