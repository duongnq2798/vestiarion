-- Control: the approval inbox and the agent's pause switch
-- (docs/superpowers/specs/2026-09-29-control-design.md, D5–D7).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- 1. `processing`: an invoice a person is deciding right now (D5).
--    Rebuild the status check by shape, whatever it is named, only while it
--    lacks 'processing', so a replay changes nothing.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.invoices'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%status%'
       and pg_get_constraintdef(oid) not like '%processing%'
  loop
    execute format('alter table public.invoices drop constraint %I', c.conname);
  end loop;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass and conname = 'invoices_status_check'
  ) then
    alter table public.invoices add constraint invoices_status_check check (status in (
      'pending', 'matched', 'paid', 'held', 'flagged', 'awaiting_info', 'received', 'rejected', 'processing'));
  end if;
end $$;

alter table public.invoices
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

-- 2. The pause lives on the organization's platform row (D7).
alter table public.orgs
  add column if not exists agent_paused_at timestamptz,
  add column if not exists agent_paused_by uuid references auth.users(id) on delete set null,
  add column if not exists agent_pause_reason text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orgs_agent_pause_reason_length') then
    alter table public.orgs add constraint orgs_agent_pause_reason_length
      check (agent_pause_reason is null or char_length(agent_pause_reason) <= 280);
  end if;
end $$;

-- 3. Claim a waiting payable for one person's decision (D4, D5). Invoker
--    rights: the tenant role runs it and RLS confines it to the token's
--    organization. The update is the compare-and-set: only one caller moves
--    the row out of a waiting status.
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
          or (status = 'processing' and reviewed_at < now() - interval '10 minutes'))
     and (p_decision <> 'approve' or created_by is distinct from p_by)
  returning * into v;
  if found then
    return v;
  end if;

  select * into v from public.invoices where id = p_invoice_id and org_id = p_org_id and direction = 'payable';
  if not found then
    raise exception 'invoice_not_found: no payable with that id in this organization';
  end if;
  if p_decision = 'approve' and v.created_by = p_by and v.status in ('held', 'flagged', 'awaiting_info') then
    raise exception 'self_approval: the person who created an invoice cannot approve it';
  end if;
  raise exception 'already_decided: the invoice is % now', v.status;
end;
$$;

-- 4. Is the organization's agent paused? Definer, because the tenant role has
--    no access to orgs; it reveals one boolean.
create or replace function public.agent_paused(p_org_id uuid) returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select coalesce((select agent_paused_at is not null from public.orgs where id = p_org_id), false)
$$;

-- 5. Pause and resume, told who is acting (the 0021 pattern). Anyone who can
--    approve money leaving can stop the agent; only an owner or admin starts it
--    again (spec §7 of the identity and tenancy design).
create or replace function public.pause_agent(p_org_id uuid, p_actor uuid, p_reason text) returns public.orgs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public.member_role(p_org_id, p_actor);
  v_org  public.orgs;
begin
  if v_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_role not in ('owner', 'admin', 'approver') then
    raise exception 'pause_not_permitted: a % cannot pause the agent', v_role;
  end if;
  select * into v_org from public.orgs where id = p_org_id for update;
  if v_org.agent_paused_at is not null then
    raise exception 'already_paused: the agent has been paused since %', v_org.agent_paused_at;
  end if;
  update public.orgs
     set agent_paused_at = now(), agent_paused_by = p_actor, agent_pause_reason = nullif(btrim(p_reason), '')
   where id = p_org_id
  returning * into v_org;
  return v_org;
end;
$$;

create or replace function public.resume_agent(p_org_id uuid, p_actor uuid) returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  text := public.member_role(p_org_id, p_actor);
  v_since timestamptz;
begin
  if v_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'resume_not_permitted: a % cannot resume the agent', v_role;
  end if;
  select agent_paused_at into v_since from public.orgs where id = p_org_id for update;
  if v_since is null then
    raise exception 'not_paused: the agent is running';
  end if;
  update public.orgs set agent_paused_at = null, agent_paused_by = null, agent_pause_reason = null where id = p_org_id;
  return v_since;
end;
$$;

-- 6. begin_cycle_run (0022), now refusing to open a run while the
--    organization's agent is paused. Body otherwise unchanged.
create or replace function public.begin_cycle_run(
  p_org_id          uuid,
  p_daily_cap       int,
  p_started_at      timestamptz,
  p_clock_mode      text,
  p_chain_mode      text,
  p_screening_mode  text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_today int;
  v_id    uuid;
begin
  if public.agent_paused(p_org_id) then
    raise exception 'agent_paused: the agent is paused';
  end if;
  perform pg_advisory_xact_lock(hashtext('vestiarion_cycle_run:' || p_org_id::text));
  if p_daily_cap is not null then
    select count(*) into v_today from public.cycle_runs
     where org_id = p_org_id
       and started_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
    if v_today >= p_daily_cap then
      raise exception 'sandbox_cap_reached: % cycles already started today (UTC)', v_today;
    end if;
  end if;
  insert into public.cycle_runs (org_id, started_at, status, clock_mode, chain_mode, screening_mode)
  values (p_org_id, p_started_at, 'running', p_clock_mode, p_chain_mode, p_screening_mode)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) to vestiarion_tenant, service_role;
revoke execute on function public.agent_paused(uuid) from public, anon, authenticated;
grant execute on function public.agent_paused(uuid) to vestiarion_tenant, service_role;
revoke execute on function public.pause_agent(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.pause_agent(uuid, uuid, text) to service_role;
revoke execute on function public.resume_agent(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resume_agent(uuid, uuid) to service_role;
-- begin_cycle_run keeps 0022's grants (create or replace preserves them).

-- Rollback:
-- drop function if exists public.resume_agent(uuid, uuid);
-- drop function if exists public.pause_agent(uuid, uuid, text);
-- drop function if exists public.agent_paused(uuid);
-- drop function if exists public.claim_invoice_decision(uuid, uuid, uuid, text);
-- alter table public.orgs drop constraint if exists orgs_agent_pause_reason_length;
-- alter table public.orgs drop column if exists agent_pause_reason;
-- alter table public.orgs drop column if exists agent_paused_by;
-- alter table public.orgs drop column if exists agent_paused_at;
-- alter table public.invoices drop column if exists reviewed_at;
-- alter table public.invoices drop column if exists reviewed_by;
-- then re-run 0022's begin_cycle_run() body (without the agent_paused check).
