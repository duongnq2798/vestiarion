-- Two approvals above a limit (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1, T4–T6).
--
-- 1. approval_policies: one row per workspace, the figure in USDC above which a payment to a payee needs two people's
--    approval, or null (off). An owner changes it through the app, which records each change in the ledger.
-- 2. payment_approvals: the approvals people gave a payable or a milestone above that figure, each bound to the
--    amount, currency and address it approved. One open approval per person and payment; the approval that pays marks
--    the open ones used, and Reject, Return and Close delete them.
-- 3. approvers_besides(org, excluded): how many members may approve payments (owners, admins, approvers) besides those
--    named. Definer, because the tenant role has no access to memberships (0021); it reveals one number, and only for
--    the caller's own workspace, as sole_approver (0061) does. approvers_among(org, people) says which of the people
--    named may approve now, so an approval by someone removed since counts for nothing.
-- 4. claim_invoice_decision: 0061's compare-and-set, unchanged except that whoever entered an invoice may also claim
--    its approval when another person's open approval of it is on file: they give its second approval.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time, and this file sorts after 0061, so
-- every full replay ends with this definition of the claim.

create table if not exists public.approval_policies (
  org_id              uuid primary key references public.orgs(id) on delete cascade,
  two_approvals_above numeric(20, 6) constraint approval_policies_two_approvals_above_check check (two_approvals_above is null or two_approvals_above > 0),
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);

alter table public.approval_policies enable row level security;
revoke all privileges on table public.approval_policies from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.approval_policies to vestiarion_tenant;
grant all privileges on table public.approval_policies to service_role;

drop policy if exists tenant_isolation on public.approval_policies;
create policy tenant_isolation on public.approval_policies for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.approval_policies;
create policy tenant_isolation_guard on public.approval_policies as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create table if not exists public.payment_approvals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  source_type text not null constraint payment_approvals_source_type_check check (source_type in ('invoice', 'milestone')),
  source_id   uuid not null,
  approved_by uuid not null references auth.users(id) on delete cascade,
  amount      numeric(20, 6) not null,
  currency    text not null,
  address     text,
  approved_at timestamptz not null default now(),
  used_at     timestamptz
);

create unique index if not exists payment_approvals_open on public.payment_approvals (source_type, source_id, approved_by) where used_at is null;
create index if not exists payment_approvals_source on public.payment_approvals (org_id, source_type, source_id);

alter table public.payment_approvals enable row level security;
revoke all privileges on table public.payment_approvals from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.payment_approvals to vestiarion_tenant;
grant all privileges on table public.payment_approvals to service_role;

drop policy if exists tenant_isolation on public.payment_approvals;
create policy tenant_isolation on public.payment_approvals for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.payment_approvals;
create policy tenant_isolation_guard on public.payment_approvals as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create or replace function public.approvers_besides(p_org_id uuid, p_excluded uuid[]) returns integer
language sql stable
security definer
set search_path = ''
as $$
  select case
    when public.request_org_id() is null or p_org_id = public.request_org_id() then (
      select count(*)::integer from public.memberships
       where org_id = p_org_id and role in ('owner', 'admin', 'approver')
         and not (user_id = any(coalesce(p_excluded, '{}'::uuid[]))))
    else 0
  end
$$;

revoke execute on function public.approvers_besides(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.approvers_besides(uuid, uuid[]) to vestiarion_tenant, service_role;

-- Of the people named, those who may approve payments in the workspace now: an approval given by someone since removed,
-- or no longer allowed to approve, counts for nothing (T4). Definer for the same reason, and reveals no one not named.
create or replace function public.approvers_among(p_org_id uuid, p_users uuid[]) returns uuid[]
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(user_id), '{}'::uuid[]) from public.memberships
   where (public.request_org_id() is null or p_org_id = public.request_org_id())
     and org_id = p_org_id and role in ('owner', 'admin', 'approver')
     and user_id = any(coalesce(p_users, '{}'::uuid[]))
$$;

revoke execute on function public.approvers_among(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.approvers_among(uuid, uuid[]) to vestiarion_tenant, service_role;

-- Invoker rights, as in 0025 and 0061: the tenant role runs it and RLS confines it to the token's organization.
create or replace function public.claim_invoice_decision(
  p_org_id uuid, p_invoice_id uuid, p_by uuid, p_decision text
) returns public.invoices
language plpgsql
set search_path = ''
as $$
declare
  v public.invoices;
begin
  if p_decision is null or p_decision not in ('approve', 'reject', 'return') then
    raise exception 'invalid_decision: % is not approve, reject or return', p_decision;
  end if;

  update public.invoices
     set status = 'processing', reviewed_by = p_by, reviewed_at = now()
   where id = p_invoice_id and org_id = p_org_id and direction = 'payable'
     and (status in ('held', 'flagged', 'awaiting_info')
          or (status = 'processing' and coalesce(reviewed_at, '-infinity'::timestamptz) < now() - interval '10 minutes'))
     and (p_decision <> 'approve' or created_by is distinct from p_by or public.sole_approver(p_org_id, p_by)
          or exists (
            select 1 from public.payment_approvals a
             where a.org_id = p_org_id and a.source_type = 'invoice' and a.source_id = p_invoice_id
               and a.approved_by <> p_by and a.used_at is null))
  returning * into v;
  if found then
    return v;
  end if;

  select * into v from public.invoices where id = p_invoice_id and org_id = p_org_id and direction = 'payable';
  if not found then
    raise exception 'invoice_not_found: no payable with that id in this organization';
  end if;
  if p_decision = 'approve' and v.created_by = p_by and not public.sole_approver(p_org_id, p_by) and (
       v.status in ('held', 'flagged', 'awaiting_info')
       or (v.status = 'processing' and coalesce(v.reviewed_at, '-infinity'::timestamptz) < now() - interval '10 minutes')
     ) then
    raise exception 'self_approval: the person who created an invoice cannot approve it';
  end if;
  raise exception 'already_decided: the invoice is % now', v.status;
end;
$$;

revoke execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.approvers_among(uuid, uuid[]);
-- drop function if exists public.approvers_besides(uuid, uuid[]);
-- drop table if exists public.payment_approvals;
-- drop table if exists public.approval_policies;
-- then re-run 0061_sole_approver.sql for its claim_invoice_decision.
