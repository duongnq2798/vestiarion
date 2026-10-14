-- Why a person went against the agent, asked in the moment (docs/superpowers/specs/2026-10-14-capability-and-reasons-
-- design.md R9-R14).
--
-- 1. decision_reasons: one row per reason a person gave, optional everywhere it is asked: disagreeing with the agent in
--    shadow mode, rejecting or returning a bill the agent stopped, paying a bill it held anyway. Each row names where in
--    the product it came from (feature, decision), the surface it was given on (console, Slack, Telegram, the API,
--    GitHub), what it is about (subject, subject_id), the build of the app that asked (app_version: the deployment's git
--    commit, or the package version) and who gave it. Written once and kept:
--    the tenant role may read and insert, never change or delete. A reason goes with its workspace; the person's
--    account going leaves it, unnamed.
-- 2. growth_decision_reasons(p_since): the latest reasons across workspaces, for the team's founder dashboard, behind
--    its own gate (src/lib/growth/gate.ts). Workspace slugs only; no person. The service role only.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. Until it runs, the app saves
-- no reason and reads none (42P01 / PGRST205); every decision goes on as before.

create table if not exists public.decision_reasons (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  feature      text not null constraint decision_reasons_feature_check check (feature in ('shadow_mode', 'approvals')),
  decision     text not null constraint decision_reasons_decision_check check (decision in ('disagree', 'reject', 'return', 'pay_held')),
  surface      text not null constraint decision_reasons_surface_check check (surface in ('console', 'slack', 'telegram', 'api', 'github')),
  subject      text not null constraint decision_reasons_subject_check check (subject in ('invoice', 'milestone')),
  subject_id   uuid,
  reason       text not null constraint decision_reasons_reason_check check (char_length(reason) between 1 and 280),
  app_version  text not null constraint decision_reasons_app_version_check check (char_length(app_version) between 1 and 64),
  given_by     uuid references auth.users(id) on delete set null,
  given_at     timestamptz not null default now()
);

create index if not exists decision_reasons_latest on public.decision_reasons (org_id, given_at desc);
create index if not exists decision_reasons_given_at on public.decision_reasons (given_at desc);

alter table public.decision_reasons enable row level security;
revoke all privileges on table public.decision_reasons from anon, authenticated, vestiarion_tenant;
grant select, insert on table public.decision_reasons to vestiarion_tenant;
grant all privileges on table public.decision_reasons to service_role;

drop policy if exists tenant_isolation on public.decision_reasons;
create policy tenant_isolation on public.decision_reasons for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.decision_reasons;
create policy tenant_isolation_guard on public.decision_reasons as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- The latest 200 reasons given since p_since (all of them when null), newest first, one object each: the workspace's
-- slug and side (customers or ours, as growth_workspaces splits them), where the reason came from, the surface, the
-- reason, the build, and when. No person.
create or replace function public.growth_decision_reasons(p_since timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(r.item order by r.given_at desc), '[]'::jsonb)
    from (
      select d.given_at,
             jsonb_build_object(
               'slug', o.slug,
               'side', case when o.created_by is not null
                             and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
                            then 'customers' else 'ours' end,
               'feature', d.feature,
               'decision', d.decision,
               'surface', d.surface,
               'reason', d.reason,
               'appVersion', d.app_version,
               'givenAt', d.given_at
             ) as item
        from public.decision_reasons d
        join public.orgs o on o.id = d.org_id
       where d.given_at >= coalesce(p_since, '-infinity'::timestamptz)
       order by d.given_at desc
       limit 200
    ) r
$$;

revoke execute on function public.growth_decision_reasons(timestamptz) from public, anon, authenticated;
grant execute on function public.growth_decision_reasons(timestamptz) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.growth_decision_reasons(timestamptz);
-- drop table if exists public.decision_reasons;
