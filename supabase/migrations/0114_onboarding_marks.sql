-- Onboarding by role (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md R4).
--
-- onboarding_marks: what one member did in one workspace that no other row records, and the checklists they dismissed.
-- Everything else a checklist ticks is read from the rows it is about (bills, decisions, signed ledger entries); these
-- are the few acts that leave none: opening Approvals while a bill waits there, opening the accountant console and one
-- workspace's queue in it, keeping the agent's limits as they are, and dismissing a role's checklist for good. One row per
-- member, workspace and mark, written once: the tenant role may read and insert, never change or delete, so a dismissal
-- stays dismissed. A mark goes with its workspace and with the person's account.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. Until it runs, the app reads
-- no marks (42P01 / PGRST205) and shows each checklist from the other rows, without its Dismiss button.

create table if not exists public.onboarding_marks (
  org_id     uuid not null references public.orgs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  mark       text not null constraint onboarding_marks_mark_check check (mark in (
               'dismissed_owner', 'dismissed_approver', 'dismissed_accountant',
               'approvals_opened', 'held_reason_seen',
               'accountant_console_opened', 'accountant_queue_opened',
               'limits_confirmed'
             )),
  marked_at  timestamptz not null default now(),
  constraint onboarding_marks_pkey primary key (org_id, user_id, mark)
);

alter table public.onboarding_marks enable row level security;
revoke all privileges on table public.onboarding_marks from anon, authenticated, vestiarion_tenant;
grant select, insert on table public.onboarding_marks to vestiarion_tenant;
grant all privileges on table public.onboarding_marks to service_role;

drop policy if exists tenant_isolation on public.onboarding_marks;
create policy tenant_isolation on public.onboarding_marks for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.onboarding_marks;
create policy tenant_isolation_guard on public.onboarding_marks as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.onboarding_marks;
