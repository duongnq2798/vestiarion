-- Go live (spec L2, "The founding workspace" review focus; docs/superpowers/specs/2026-09-29-go-live-design.md).
--
-- delete_sandbox_org: redefined from 0022 (still its latest definition; 0028
-- did not touch it) with one added refusal — a sandbox that holds Circle
-- credentials is never deleted automatically, connected or not yet live.
-- Everything else, including the grants, is unchanged.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

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
  if v_org.circle_api_key_enc is not null then
    raise exception 'has_circle_credentials: % holds Circle credentials, and a connected sandbox is never deleted automatically', v_org.slug;
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

revoke execute on function public.delete_sandbox_org(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.delete_sandbox_org(uuid, timestamptz) to service_role;

-- Rollback:
-- re-run 0022's delete_sandbox_org() body (without the has_circle_credentials refusal).
