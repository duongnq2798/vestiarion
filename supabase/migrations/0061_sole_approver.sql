-- Sole approver (docs/superpowers/specs/2026-10-03-sole-approver-design.md R1–R3).
--
-- 1. sole_approver(org, person): is this person the only member of the
--    organization whose role may approve payments (owner, admin, approver)?
--    Definer, because the tenant role has no access to memberships (0021); it
--    reveals one boolean, and only for the caller's own organization — a
--    tenant token names one org, and the service role's absent claim
--    (request_org_id() null) is let through for every org (the agent_paused
--    pattern, 0025).
-- 2. claim_invoice_decision: 0025's compare-and-set, unchanged except that the
--    person who created an invoice may approve it when they are its
--    organization's sole approver. Everyone else keeps the separation.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time,
-- and this file sorts after 0025, so every full replay ends with this
-- definition. A replay from a checkout without this file restores 0025's
-- stricter rule, never a looser one.

create or replace function public.sole_approver(p_org_id uuid, p_user_id uuid) returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select (public.request_org_id() is null or p_org_id = public.request_org_id())
     and exists (
       select 1 from public.memberships
        where org_id = p_org_id and user_id = p_user_id and role in ('owner', 'admin', 'approver'))
     and not exists (
       select 1 from public.memberships
        where org_id = p_org_id and user_id is distinct from p_user_id and role in ('owner', 'admin', 'approver'))
$$;

revoke execute on function public.sole_approver(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sole_approver(uuid, uuid) to vestiarion_tenant, service_role;

-- Invoker rights, as in 0025: the tenant role runs it and RLS confines it to
-- the token's organization. create or replace keeps 0025's grants.
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
     and (p_decision <> 'approve' or created_by is distinct from p_by or public.sole_approver(p_org_id, p_by))
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
