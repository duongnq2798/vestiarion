-- One cycle at a time in a workspace, decided under the lock.
--
-- begin_cycle_run already takes a per-organization advisory lock before it
-- counts today's runs and opens one. It now also refuses, under that lock,
-- when the organization has a run in progress: a row still `running` that
-- started within the last 15 minutes, the window delete_org (0031) and the
-- app's hasRunningCycle use. The app checked first and opened the run after,
-- which left a window in which two instances (the schedule and an event, say)
-- could both find nothing running and both open a run. The AP stage does not
-- claim the payables it decides, so the later cycle's write could move a paid
-- invoice's status back; the payment itself was never sent twice, because
-- payment intents are idempotent.
--
-- The lock is held until the opening transaction commits, so a second caller
-- waits for it and then sees the first run. The refusal raises
-- `cycle_running: …`, which the orchestrator reports as CycleRunningError. A
-- refused call opens no run and counts nothing towards a sandbox's daily cap.
-- Pause is still checked first. create or replace keeps 0022's grants.

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
  if exists (
    select 1 from public.cycle_runs
     where org_id = p_org_id and status = 'running' and started_at > now() - interval '15 minutes'
  ) then
    raise exception 'cycle_running: a cycle is already running in this workspace';
  end if;
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

-- Rollback: re-run 0025_control.sql's definition of begin_cycle_run.
