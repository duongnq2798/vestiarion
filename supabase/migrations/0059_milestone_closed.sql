-- A person decides a held milestone (docs/superpowers/specs/2026-10-02-held-milestone-actions-design.md R2, R3).
--
-- 1. milestones.status gains 'closed': a milestone a person closed without paying it, with when, by whom and
--    why. Only a held one is closed, and never while a transfer for it may still settle (the app checks; the
--    status is the record).
-- 2. claim_milestone_decision: the compare-and-set that gives one person a held milestone to decide (Pay now or
--    Close without paying), as claim_invoice_decision (0025) does for a payable. The milestone stays 'held'
--    while it is claimed, so the agent's cycle, which only decides 'verified' milestones, never meets it; a
--    claim no decision finished is retaken after 10 minutes.
--
-- Idempotent throughout.

alter table public.milestones drop constraint if exists milestones_status_check;
alter table public.milestones add constraint milestones_status_check check (status in ('pending', 'verified', 'paid', 'held', 'closed'));

alter table public.milestones
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references auth.users(id) on delete set null,
  add column if not exists close_reason text,
  add column if not exists decision_claimed_by uuid references auth.users(id) on delete set null,
  add column if not exists decision_claimed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'milestones_close_reason_check' and conrelid = 'public.milestones'::regclass) then
    alter table public.milestones add constraint milestones_close_reason_check check (close_reason is null or char_length(btrim(close_reason)) between 1 and 500);
  end if;
end $$;

-- Invoker rights, as claim_invoice_decision: the tenant role runs it and RLS confines it to the token's
-- organization. The update is the compare-and-set.
create or replace function public.claim_milestone_decision(
  p_org_id uuid, p_milestone_id uuid, p_by uuid
) returns public.milestones
language plpgsql
set search_path = ''
as $$
declare
  v public.milestones;
begin
  update public.milestones
     set decision_claimed_by = p_by, decision_claimed_at = now()
   where id = p_milestone_id and org_id = p_org_id and status = 'held'
     and coalesce(decision_claimed_at, '-infinity'::timestamptz) < now() - interval '10 minutes'
  returning * into v;
  if found then
    return v;
  end if;

  select * into v from public.milestones where id = p_milestone_id and org_id = p_org_id;
  if not found then
    raise exception 'milestone_not_found: no milestone with that id in this organization';
  end if;
  if v.status <> 'held' then
    raise exception 'not_held: the milestone is % now', v.status;
  end if;
  raise exception 'already_claimed: someone is deciding this milestone';
end;
$$;

revoke execute on function public.claim_milestone_decision(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_milestone_decision(uuid, uuid, uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.claim_milestone_decision(uuid, uuid, uuid);
-- update public.milestones set status = 'held' where status = 'closed';
-- alter table public.milestones drop constraint if exists milestones_close_reason_check;
-- alter table public.milestones drop column if exists decision_claimed_at, drop column if exists decision_claimed_by,
--   drop column if exists close_reason, drop column if exists closed_by, drop column if exists closed_at;
-- alter table public.milestones drop constraint if exists milestones_status_check;
-- alter table public.milestones add constraint milestones_status_check check (status in ('pending', 'verified', 'paid', 'held'));
