-- Accountant co-sign (docs/superpowers/specs/2026-10-22-accountant-cosign-design.md CS1, CS4, CS5).
--
-- 1. approval_policies (0076), one row per workspace, gains `accountant_cosigns`, off by default: with it on, a member
--    whose role is accountant may co-sign a bill above the figure for two approvals, and confirm changed addresses. An
--    owner changes it through the app, which records each change in the ledger as `accountant_cosign_changed`. The
--    table's grants and tenant policies are 0076's and stay as they are.
-- 2. approvers_among(org, people), first written in 0076: the people named who may give one of a payment's two
--    approvals now. It now counts the workspace's accountants too, while `accountant_cosigns` is on, so a co-sign stands
--    for the approval that pays and for claim_invoice_decision's check (0118), and stops counting the moment the setting
--    is turned off or the person's role changes. Owners, admins and approvers count as before.
-- 3. cosigners_besides(org, excluded): how many accountants co-sign besides those named, 0 while the setting is off.
--    Definer, because the tenant role has no access to memberships (0021); it reveals one number, and only for the
--    caller's own workspace, as approvers_besides (0076) does. approvers_besides itself is unchanged: milestones and the
--    sole approver rule still count owners, admins and approvers only.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time, and this file sorts after 0076, so every
-- full replay ends with this definition of approvers_among.

alter table public.approval_policies add column if not exists accountant_cosigns boolean not null default false;

create or replace function public.approvers_among(p_org_id uuid, p_users uuid[]) returns uuid[]
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.user_id), '{}'::uuid[]) from public.memberships m
   where (public.request_org_id() is null or p_org_id = public.request_org_id())
     and m.org_id = p_org_id
     and m.user_id = any(coalesce(p_users, '{}'::uuid[]))
     and (m.role in ('owner', 'admin', 'approver')
          or (m.role = 'accountant' and exists (
                select 1 from public.approval_policies p where p.org_id = p_org_id and p.accountant_cosigns)))
$$;

revoke execute on function public.approvers_among(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.approvers_among(uuid, uuid[]) to vestiarion_tenant, service_role;

create or replace function public.cosigners_besides(p_org_id uuid, p_excluded uuid[]) returns integer
language sql stable
security definer
set search_path = ''
as $$
  select case
    when public.request_org_id() is null or p_org_id = public.request_org_id() then (
      select count(*)::integer from public.memberships m
       where m.org_id = p_org_id and m.role = 'accountant'
         and not (m.user_id = any(coalesce(p_excluded, '{}'::uuid[])))
         and exists (select 1 from public.approval_policies p where p.org_id = p_org_id and p.accountant_cosigns))
    else 0
  end
$$;

revoke execute on function public.cosigners_besides(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.cosigners_besides(uuid, uuid[]) to vestiarion_tenant, service_role;

-- PostgREST reads the new column and function at once, so the first Settings save is not refused as before 0138.
notify pgrst, 'reload schema';
