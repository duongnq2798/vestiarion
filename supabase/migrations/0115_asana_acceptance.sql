-- Contractor work accepted from Asana (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2 to A10).
--
-- 1. The connector core's checks take asana as a provider: a workspace connects Asana as it connects Xero or HubSpot,
--    its tokens kept in accounting_tokens. Each check is replaced only while it does not take asana yet, so a later
--    migration that widens it again (Pipedrive's 0116 lists asana too) is never narrowed by a re-run of this one.
-- 2. milestones.verification_method takes asana: a milestone a person accepted against its criteria once its Asana task
--    was completed. Replaced only while it does not take asana yet.
-- 3. milestones.acceptance_criteria: what the work is held to, from the agreement, written by a person in Vestiarion.
--    Asana never writes it. With none, a completed task waits for a person and is never accepted.
-- 4. asana_task_links: the Asana task a milestone's work is delivered in, once per milestone and once per task while
--    linked (one task never pays two milestones), with what Asana says of it as last read (completed, when and by whom,
--    the deliverables' links and their fingerprint), its state (waiting, ready for acceptance, accepted, held for
--    review) and the version a person accepted. Never an amount, a payee or an address. The tenant role reads, inserts
--    and updates its own workspace's rows and deletes none.
-- 5. asana_webhooks: a platform table, as accounting_tokens: one Asana webhook per linked task, the id in its target
--    address, its secret from Asana's handshake as an envelope under the master key. Row-level security on and no
--    policy: the tenant role and the browser roles reach none of it.
-- 6. accept_asana_task and hold_asana_acceptance: the two moves that touch the milestone, each in one transaction under
--    the link's and the milestone's row locks. Accepting makes a pending milestone verified (method asana) only when the
--    task read last is completed, its deliverables are the version the person saw and the criteria are the ones they
--    saw. Holding takes the verification back from an accepted milestone, unless a payment for it is under way or paid,
--    or a person is deciding it right now (then it waits for the next read). Neither writes an amount or a payee.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. Before it runs, the app
-- treats 42P01, PGRST205 and 42703 as "Asana is not set up yet" and shows no Asana controls.

do $$
declare
  c record;
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_provider_check' and pg_get_constraintdef(oid) like '%asana%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
    alter table public.accounting_connections
      add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_tokens_provider_check' and pg_get_constraintdef(oid) like '%asana%') then
    alter table public.accounting_tokens drop constraint if exists accounting_tokens_provider_check;
    alter table public.accounting_tokens
      add constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana'));
  end if;
  -- 0006 added the method's check inline, unnamed: whatever its name, it is replaced once, by a named one.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.milestones'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%verification_method%' and pg_get_constraintdef(oid) like '%asana%'
  ) then
    for c in
      select conname from pg_constraint
       where conrelid = 'public.milestones'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%verification_method%'
    loop
      execute format('alter table public.milestones drop constraint %I', c.conname);
    end loop;
    alter table public.milestones
      add constraint milestones_verification_method_check check (verification_method in ('unverified', 'github', 'manual', 'seed', 'asana'));
  end if;
end $$;

alter table public.milestones add column if not exists acceptance_criteria text;
alter table public.milestones add column if not exists acceptance_criteria_by uuid references auth.users(id) on delete set null;
alter table public.milestones add column if not exists acceptance_criteria_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'milestones_acceptance_criteria_check' and conrelid = 'public.milestones'::regclass) then
    alter table public.milestones add constraint milestones_acceptance_criteria_check
      check (acceptance_criteria is null or char_length(btrim(acceptance_criteria)) between 3 and 2000);
  end if;
end $$;

comment on column public.milestones.acceptance_criteria is
  'What the work is held to, from the agreement, written by a person in Vestiarion; never by Asana. Accepting checks it.';

create table if not exists public.asana_task_links (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.orgs(id) on delete cascade,
  milestone_id              uuid not null,
  connection_id             uuid not null,
  workspace_gid             text not null constraint asana_task_links_workspace_gid_check check (workspace_gid ~ '^[0-9]{1,32}$'),
  project_gid               text constraint asana_task_links_project_gid_check check (project_gid is null or project_gid ~ '^[0-9]{1,32}$'),
  task_gid                  text not null constraint asana_task_links_task_gid_check check (task_gid ~ '^[0-9]{1,32}$'),
  task_name                 text not null constraint asana_task_links_task_name_check check (char_length(task_name) between 1 and 200),
  task_url                  text constraint asana_task_links_task_url_check
                              check (task_url is null or (task_url like 'https://app.asana.com/%' and char_length(task_url) <= 500)),
  -- waiting: not completed in Asana; ready: completed, with criteria, for a person to accept; accepted: a person accepted
  -- the version they saw; held: for a person to review (reopened or changed after acceptance, unreachable, no criteria).
  state                     text not null default 'waiting'
                              constraint asana_task_links_state_check check (state in ('waiting', 'ready', 'accepted', 'held')),
  held_reason               text constraint asana_task_links_held_reason_check
                              check (held_reason is null or held_reason in ('reopened', 'deliverable_changed', 'task_unreachable', 'no_criteria', 'unlinked')),
  -- Changed in Asana after the payment was sent or paid: shown as a dispute; the payment is not taken back.
  after_payment             boolean not null default false,
  held_at                   timestamptz,
  -- What Asana says of the task as last read.
  completed                 boolean not null default false,
  completed_at              timestamptz,
  completed_by_gid          text constraint asana_task_links_completed_by_gid_check check (completed_by_gid is null or completed_by_gid ~ '^[0-9]{1,32}$'),
  completed_by_name         text constraint asana_task_links_completed_by_name_check check (completed_by_name is null or char_length(completed_by_name) between 1 and 200),
  assignee_gid              text constraint asana_task_links_assignee_gid_check check (assignee_gid is null or assignee_gid ~ '^[0-9]{1,32}$'),
  assignee_name             text constraint asana_task_links_assignee_name_check check (assignee_name is null or char_length(assignee_name) between 1 and 200),
  -- The deliverables' links: the description's, the attachments' and the comments', each a kind, a label and a link.
  deliverables              jsonb not null default '[]'::jsonb constraint asana_task_links_deliverables_check
                              check (jsonb_typeof(deliverables) = 'array' and octet_length(deliverables::text) <= 32000),
  deliverable_fingerprint   text constraint asana_task_links_fingerprint_check check (deliverable_fingerprint is null or deliverable_fingerprint ~ '^[0-9a-f]{64}$'),
  task_modified_at          timestamptz,
  last_read_at              timestamptz,
  read_error                text constraint asana_task_links_read_error_check check (read_error is null or char_length(read_error) between 1 and 300),
  -- The version a person accepted: who, when, the deliverables they saw, the completion they saw and the criteria.
  accepted_by               uuid references auth.users(id) on delete set null,
  accepted_at               timestamptz,
  accepted_fingerprint      text constraint asana_task_links_accepted_fingerprint_check check (accepted_fingerprint is null or accepted_fingerprint ~ '^[0-9a-f]{64}$'),
  accepted_completed_at     timestamptz,
  accepted_criteria_sha256  text constraint asana_task_links_accepted_criteria_check check (accepted_criteria_sha256 is null or accepted_criteria_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_deliverables     jsonb constraint asana_task_links_accepted_deliverables_check
                              check (accepted_deliverables is null or (jsonb_typeof(accepted_deliverables) = 'array' and octet_length(accepted_deliverables::text) <= 32000)),
  linked_by                 uuid references auth.users(id) on delete set null,
  linked_at                 timestamptz not null default now(),
  unlinked_by               uuid references auth.users(id) on delete set null,
  unlinked_at               timestamptz,
  updated_at                timestamptz not null default now(),
  constraint asana_task_links_org_id_key unique (org_id, id),
  constraint asana_task_links_milestone_fkey foreign key (org_id, milestone_id)
    references public.milestones (org_id, id) on delete cascade,
  constraint asana_task_links_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade,
  constraint asana_task_links_held_check check ((state = 'held') = (held_reason is not null)),
  constraint asana_task_links_accepted_check check (state <> 'accepted' or (accepted_at is not null and accepted_fingerprint is not null)),
  constraint asana_task_links_completed_check check (completed or completed_at is null)
);

-- One live link per milestone, and one per task: the same delivered work never verifies two milestones.
create unique index if not exists asana_task_links_milestone_key on public.asana_task_links (org_id, milestone_id) where unlinked_at is null;
create unique index if not exists asana_task_links_task_key on public.asana_task_links (org_id, task_gid) where unlinked_at is null;
create index if not exists asana_task_links_connection_idx on public.asana_task_links (org_id, connection_id) where unlinked_at is null;

alter table public.asana_task_links enable row level security;
revoke all privileges on table public.asana_task_links from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.asana_task_links to vestiarion_tenant;
grant all privileges on table public.asana_task_links to service_role;
drop policy if exists tenant_isolation on public.asana_task_links;
create policy tenant_isolation on public.asana_task_links for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.asana_task_links;
create policy tenant_isolation_guard on public.asana_task_links as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create table if not exists public.asana_webhooks (
  -- Made by the application before Asana is asked, so the handshake that comes back to /api/integrations/asana/webhook/<id>
  -- finds its row; the secret's envelope is bound to it.
  id             uuid primary key,
  org_id         uuid not null references public.orgs(id) on delete cascade,
  connection_id  uuid not null,
  link_id        uuid not null,
  resource_gid   text not null constraint asana_webhooks_resource_gid_check check (resource_gid ~ '^[0-9]{1,32}$'),
  webhook_gid    text constraint asana_webhooks_webhook_gid_check check (webhook_gid is null or webhook_gid ~ '^[0-9]{1,32}$'),
  secret_enc     jsonb,
  state          text not null default 'pending' constraint asana_webhooks_state_check check (state in ('pending', 'active', 'deleted')),
  handshake_at   timestamptz,
  last_event_at  timestamptz,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  constraint asana_webhooks_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade,
  constraint asana_webhooks_link_fkey foreign key (org_id, link_id)
    references public.asana_task_links (org_id, id) on delete cascade,
  constraint asana_webhooks_secret_check check (state = 'pending' or state = 'deleted' or secret_enc is not null)
);

create index if not exists asana_webhooks_link_idx on public.asana_webhooks (org_id, link_id);

alter table public.asana_webhooks enable row level security;
revoke all privileges on table public.asana_webhooks from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.asana_webhooks to service_role;

-- Accepting (A8): a pending milestone becomes verified by a person's acceptance of its completed task, as seen.
-- Invoker rights, as claim_milestone_decision: the tenant role runs it and RLS confines it to the token's workspace.
create or replace function public.accept_asana_task(
  p_org_id uuid, p_link_id uuid, p_by uuid, p_fingerprint text, p_criteria_sha256 text, p_note text
) returns public.asana_task_links
language plpgsql
set search_path = ''
as $$
declare
  l public.asana_task_links;
  m public.milestones;
begin
  select * into l from public.asana_task_links where id = p_link_id and org_id = p_org_id and unlinked_at is null for update;
  if not found then
    raise exception 'link_not_found: no linked task with that id in this organization';
  end if;
  if l.state = 'accepted' then
    raise exception 'already_accepted: this work was accepted already';
  end if;
  if l.after_payment then
    raise exception 'after_payment: a payment for this milestone was sent before the task changed';
  end if;
  if not l.completed then
    raise exception 'not_completed: the task is not completed in Asana';
  end if;
  if l.deliverable_fingerprint is null or l.deliverable_fingerprint is distinct from p_fingerprint then
    raise exception 'stale: the deliverables changed since they were shown';
  end if;
  select * into m from public.milestones where id = l.milestone_id and org_id = p_org_id for update;
  if not found then
    raise exception 'link_not_found: no milestone for that link';
  end if;
  if m.status <> 'pending' then
    raise exception 'milestone_not_open: the milestone is % now', m.status;
  end if;
  if m.acceptance_criteria is null then
    raise exception 'no_criteria: the milestone has no acceptance criteria';
  end if;
  if encode(pg_catalog.sha256(convert_to(m.acceptance_criteria, 'UTF8')), 'hex') is distinct from p_criteria_sha256 then
    raise exception 'criteria_changed: the acceptance criteria changed since they were shown';
  end if;

  update public.milestones
     set verified = true,
         status = 'verified',
         verification_method = 'asana',
         verification_status = 'verified',
         verification_checked_at = now(),
         verified_at = now(),
         verification_detail = jsonb_build_object(
           'note', p_note,
           'asanaTask', l.task_url,
           'taskGid', l.task_gid,
           'completedAt', l.completed_at,
           'fingerprint', l.deliverable_fingerprint,
           'criteriaSha256', p_criteria_sha256,
           'acceptedBy', p_by
         )
   where id = m.id and org_id = p_org_id;

  update public.asana_task_links
     set state = 'accepted', held_reason = null, held_at = null,
         accepted_by = p_by, accepted_at = now(), accepted_fingerprint = l.deliverable_fingerprint,
         accepted_completed_at = l.completed_at, accepted_criteria_sha256 = p_criteria_sha256,
         accepted_deliverables = l.deliverables, updated_at = now()
   where id = l.id and org_id = p_org_id
  returning * into l;
  return l;
end;
$$;

-- Holding (A10): an accepted link whose task was reopened or changed, or can no longer be read, is held for review, and
-- the milestone's verification is taken back so the agent never pays it, unless the payment is under way or paid
-- (then only the link is held, as a dispute), the milestone is closed, or a person claimed its decision in the last ten
-- minutes (then nothing changes, and the next read tries again). Answers held, held_after_payment, deferred or
-- not_accepted.
create or replace function public.hold_asana_acceptance(p_org_id uuid, p_link_id uuid, p_reason text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  l public.asana_task_links;
  m public.milestones;
  underway boolean;
begin
  if p_reason not in ('reopened', 'deliverable_changed', 'task_unreachable', 'unlinked') then
    raise exception 'bad_reason: %', p_reason;
  end if;
  select * into l from public.asana_task_links where id = p_link_id and org_id = p_org_id and unlinked_at is null for update;
  if not found or l.state <> 'accepted' then
    return 'not_accepted';
  end if;
  select * into m from public.milestones where id = l.milestone_id and org_id = p_org_id for update;
  underway := m.status = 'paid' or exists (
    select 1 from public.payment_intents i
     where i.org_id = p_org_id and i.source_type = 'milestone' and i.source_id = m.id and i.status <> 'failed'
  );
  if not underway and m.status <> 'closed' and m.decision_claimed_at is not null and m.decision_claimed_at > now() - interval '10 minutes' then
    return 'deferred';
  end if;
  if not underway and m.status <> 'closed' and m.verification_method = 'asana' then
    update public.milestones
       set verified = false,
           status = case when m.status in ('verified', 'held') then 'pending' else m.status end,
           verification_status = 'unverified',
           verification_checked_at = now(),
           verified_at = null,
           verification_detail = coalesce(m.verification_detail, '{}'::jsonb) || jsonb_build_object('heldReason', p_reason, 'heldAt', now())
     where id = m.id and org_id = p_org_id;
  end if;
  update public.asana_task_links
     set state = 'held', held_reason = p_reason, held_at = now(), after_payment = underway, updated_at = now()
   where id = l.id and org_id = p_org_id;
  return case when underway then 'held_after_payment' else 'held' end;
end;
$$;

revoke execute on function public.accept_asana_task(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.hold_asana_acceptance(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_asana_task(uuid, uuid, uuid, text, text, text) to vestiarion_tenant, service_role;
grant execute on function public.hold_asana_acceptance(uuid, uuid, text) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.hold_asana_acceptance(uuid, uuid, text);
-- drop function if exists public.accept_asana_task(uuid, uuid, uuid, text, text, text);
-- drop table if exists public.asana_webhooks;
-- drop table if exists public.asana_task_links;
-- alter table public.milestones drop constraint if exists milestones_acceptance_criteria_check;
-- alter table public.milestones drop column if exists acceptance_criteria_at, drop column if exists acceptance_criteria_by,
--   drop column if exists acceptance_criteria;
-- and the checks without asana, once no row holds it.
