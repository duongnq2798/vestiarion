-- Workspace lifecycle (spec §6 "Abandoned sandboxes", §10 step 5b).
--
-- touch_org_activity: last_active_at is refreshed at most hourly, so a page
-- view costs at most one real write per organization per hour.
--
-- delete_sandbox_org: the daily cleanup's only way to delete an organization.
-- It refuses a live organization outright, and returns false for one that
-- became active at or after the cutoff the caller listed it under, so a
-- sandbox someone opened between the listing and the delete survives. It
-- removes the organization's rows table by table — every tenant table's
-- org_id restricts the organization's delete (0015) — ledger included: the
-- chain belongs to an organization that no longer exists, and a sandbox never
-- held real money.
--
-- begin_cycle_run: the sandbox cycle cap from step 5a, moved into the
-- database. The per-organization lock serialises concurrent starts; the count
-- then runs under a fresh READ COMMITTED snapshot and sees every run the
-- previous holder committed. Invoker rights: the tenant role runs it, and RLS
-- confines both the count and the insert to the organization in its token.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create or replace function public.touch_org_activity(p_org_id uuid) returns void
language sql
set search_path = ''
as $$
  update public.orgs set last_active_at = now()
   where id = p_org_id and last_active_at < now() - interval '1 hour'
$$;

-- cycle_snapshots stays append-only (0008), except while delete_sandbox_org
-- removes an organization whole: it sets vestiarion.purging_org for its own
-- transaction only, and only rows of that organization pass.
create or replace function public.reject_cycle_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('vestiarion.purging_org', true) = old.org_id::text then
    return old;
  end if;
  raise exception 'cycle_snapshots are append-only';
end;
$$;

create or replace function public.delete_sandbox_org(p_org_id uuid, p_inactive_before timestamptz) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_org public.orgs;
begin
  select * into v_org from public.orgs where id = p_org_id for update;
  if not found then
    return false;
  end if;
  if v_org.mode <> 'sandbox' then
    raise exception 'not_a_sandbox: % is %, and only a sandbox is deleted automatically', v_org.slug, v_org.mode;
  end if;
  if v_org.last_active_at >= p_inactive_before then
    return false;
  end if;

  perform set_config('vestiarion.purging_org', p_org_id::text, true);
  -- Children before parents: snapshots restrict their run's delete (0019),
  -- and every table restricts the organization's.
  delete from public.cycle_snapshots   where org_id = p_org_id;
  delete from public.cycle_runs        where org_id = p_org_id;
  delete from public.payment_intents   where org_id = p_org_id;
  delete from public.milestones        where org_id = p_org_id;
  delete from public.compliance_checks where org_id = p_org_id;
  delete from public.invoices          where org_id = p_org_id;
  delete from public.treasury_actions  where org_id = p_org_id;
  delete from public.counterparties    where org_id = p_org_id;
  delete from public.accounts          where org_id = p_org_id;
  delete from public.forecasts         where org_id = p_org_id;
  delete from public.ledger_entries    where org_id = p_org_id;
  delete from public.sim_clock         where org_id = p_org_id;
  perform set_config('vestiarion.purging_org', '', true);
  -- memberships and invitations cascade with the organization.
  delete from public.orgs where id = p_org_id;
  return true;
end;
$$;

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

revoke execute on function public.touch_org_activity(uuid) from public, anon, authenticated;
grant execute on function public.touch_org_activity(uuid) to service_role;
revoke execute on function public.delete_sandbox_org(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.delete_sandbox_org(uuid, timestamptz) to service_role;
revoke execute on function public.begin_cycle_run(uuid, int, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_cycle_run(uuid, int, timestamptz, text, text, text) to vestiarion_tenant, service_role;

-- Rollback:
-- drop function if exists public.begin_cycle_run(uuid, int, timestamptz, text, text, text);
-- drop function if exists public.delete_sandbox_org(uuid, timestamptz);
-- drop function if exists public.touch_org_activity(uuid);
-- then re-run 0008's reject_cycle_snapshot_mutation() body (always raises).
