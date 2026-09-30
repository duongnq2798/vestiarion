-- Deleting a workspace, owner initiated
-- (docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md §1, W3–W5).
--
-- deleted_orgs is a platform table, like api_keys (0027): RLS is on, no policy
-- exists for any browser or tenant role, and only the service role reads or
-- writes it. Each row is a deleted workspace's tombstone: who deleted it, and
-- how long its ledger was and what its head was. It holds no business data.
-- deleted_by has no foreign key, so the tombstone outlives the account too.
--
-- delete_org(p_org_id, p_by) deletes one workspace whole, in one transaction:
--   1. the org row is taken FOR UPDATE, so nothing that references it — a
--      cycle run opening, a ledger append — can commit alongside the delete;
--   2. the refusals: the founding workspace; anyone but one of its owners
--      (p_by is re-checked here, whatever the caller checked); a live
--      workspace whose agent is not paused; a cycle run in progress; and a
--      payment in progress — an invoice a person's approval holds
--      (`processing`, reviewed in the last 10 minutes: claim_invoice_decision's
--      window, 0025) or a payment intent being submitted (`submitting`,
--      updated in the last 2 minutes: claim_payment_intent's window, 0016).
--      A claim older than its window is one the claim function itself would
--      take over as abandoned, so it does not block;
--   3. the tombstone;
--   4. every tenant table, children before parents, in delete_sandbox_org's
--      order (0030, its latest definition), with vestiarion.purging_org set so
--      the append-only cycle snapshots of this org alone may go;
--   5. the org row, which cascades to memberships (0020's last-owner trigger
--      lets a membership go with its organization), invitations, api_keys
--      (0027), webhook_endpoints and webhook_deliveries (0028). No table added
--      after 0022 restricts the organization's delete, so none is deleted by
--      name here; webhook deliveries of a ledger entry cascade with the entry.
--
-- "In progress" is a cycle_runs row still `running` (0011: running until the
-- cycle closes) that started within the last 15 minutes. A row left running
-- is a crashed cycle, not a live one (0011's comment), and the longest a
-- cycle can run is the cron's maxDuration (300 seconds, api/agent/tick), so a
-- crashed run never blocks deletion for longer than this window.
--
-- Definer, so it runs with the migration owner's rights whatever role calls
-- it, with search_path pinned to ''. Only the service role may call it.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.deleted_orgs (
  org_id                uuid primary key,
  slug                  text not null,
  name                  text not null,
  deleted_by            uuid,
  deleted_at            timestamptz not null default now(),
  ledger_entries        int not null,
  ledger_head_hash      text,
  ledger_signing_key_id text
);

alter table public.deleted_orgs enable row level security;
revoke all privileges on table public.deleted_orgs from public, anon, authenticated;
grant all privileges on table public.deleted_orgs to service_role;

create or replace function public.delete_org(p_org_id uuid, p_by uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     public.orgs;
  v_entries int;
  v_head    public.ledger_entries;
begin
  select * into v_org from public.orgs where id = p_org_id for update;
  if not found then
    raise exception 'org_not_found: no organization with id %', p_org_id;
  end if;
  if v_org.id = '00000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'founding_org: the founding workspace cannot be deleted';
  end if;
  if public.member_role(p_org_id, p_by) is distinct from 'owner' then
    raise exception 'not_owner: only an owner of % can delete it', v_org.slug;
  end if;
  if v_org.mode = 'live' and v_org.agent_paused_at is null then
    raise exception 'pause_first: % is live and its agent is running; pause it first', v_org.slug;
  end if;
  if exists (
    select 1 from public.cycle_runs
     where org_id = p_org_id and status = 'running' and started_at > now() - interval '15 minutes'
  ) then
    raise exception 'cycle_running: a cycle of % is in progress', v_org.slug;
  end if;
  -- A person's approval moves money without a cycle, and a pause does not
  -- stop it: a claimed invoice, or a payment being submitted, inside the
  -- window in which its claim function would not yet take it over.
  if exists (
    select 1 from public.invoices
     where org_id = p_org_id and status = 'processing' and reviewed_at >= now() - interval '10 minutes'
  ) or exists (
    select 1 from public.payment_intents
     where org_id = p_org_id and status = 'submitting' and updated_at >= now() - interval '2 minutes'
  ) then
    raise exception 'payment_in_progress: a payment of % is being made', v_org.slug;
  end if;

  select count(*) into v_entries from public.ledger_entries where org_id = p_org_id;
  select * into v_head from public.ledger_entries where org_id = p_org_id order by seq desc limit 1;
  insert into public.deleted_orgs (org_id, slug, name, deleted_by, ledger_entries, ledger_head_hash, ledger_signing_key_id)
  values (p_org_id, v_org.slug, v_org.name, p_by, v_entries, v_head.hash, v_head.signing_key_id);

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
  -- memberships, invitations, api_keys and webhooks cascade with the organization.
  delete from public.orgs where id = p_org_id;
end;
$$;

revoke execute on function public.delete_org(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_org(uuid, uuid) to service_role;

-- Rollback:
-- drop function if exists public.delete_org(uuid, uuid);
-- drop table if exists public.deleted_orgs;
