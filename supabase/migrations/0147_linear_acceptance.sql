-- Contractor work accepted from Linear (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN1 to LN10).
--
-- 1. The connector core's checks take linear as a provider: a workspace connects Linear as it connects Asana, its
--    tokens kept in accounting_tokens. Each check keeps every value it took before (0145: xero, quickbooks, hubspot,
--    asana, pipedrive, zohobooks, zohocrm, googlesheets), and is replaced only while it does not take linear yet: a
--    re-run of this migration never narrows a later widening, and 0101, 0105, 0115, 0116, 0122, 0123 and 0145, re-run
--    after it, see their own value already taken and leave the check as it is.
--    A later widening must keep linear beside its own value.
-- 2. milestones.verification_method takes linear: a milestone a person accepted against its criteria once its Linear
--    issue was completed. It keeps every value it took (0115: unverified, github, manual, seed, asana), and is replaced
--    only while it does not take linear yet.
-- 3. linear_issue_links: the Linear issue a milestone's work is delivered in, once per milestone and once per issue while
--    linked (one issue never pays two milestones), with what Linear says of it as last read (its workflow state, whether
--    and when it was completed and by whom, archived or deleted, the deliverables' links and their fingerprint, how many
--    attachments and comments were read), its state (waiting, ready for acceptance, accepted, held for review) and the
--    version a person accepted. Never an amount, a payee or an address. The tenant role reads, inserts and updates its
--    own workspace's rows and deletes none. The acceptance criteria are 0115's milestones.acceptance_criteria.
-- 4. accept_linear_issue and hold_linear_acceptance: the two moves that touch the milestone, as accept_asana_task and
--    hold_asana_acceptance, each in one transaction under the link's and the milestone's row locks. Accepting makes a
--    pending milestone verified (method linear) only when the issue read last is completed and not archived, its
--    deliverables are the version the person saw and the criteria are the ones they saw. Holding takes the verification
--    back from an accepted milestone, unless a payment for it is under way or paid, or a person is deciding it right now
--    (then it waits for the next read). Neither writes an amount or a payee.
-- 5. linear_connector_ready(p_org_id): true once this migration has run. The connect flow asks it before anyone is sent
--    to Linear. It takes the workspace, as the tenant data layer passes p_org_id to every tenant function (0117), and
--    reads nothing.
--
-- No webhook table: Linear's app webhook is one address and one signing secret, kept in the deployment's environment
-- (LN11). A delivery names the Linear organization, and accounting_connections_by_external (0105) finds its workspaces.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. Before it runs, the app
-- treats 42P01, PGRST205, PGRST202 and 42703 as "Linear is not set up yet" and shows no Linear controls.

do $$
declare
  c record;
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_provider_check' and conrelid = 'public.accounting_connections'::regclass and pg_get_constraintdef(oid) like '%linear%') then
    alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
    alter table public.accounting_connections
      add constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm', 'googlesheets', 'linear'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_tokens_provider_check' and conrelid = 'public.accounting_tokens'::regclass and pg_get_constraintdef(oid) like '%linear%') then
    alter table public.accounting_tokens drop constraint if exists accounting_tokens_provider_check;
    alter table public.accounting_tokens
      add constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks', 'hubspot', 'asana', 'pipedrive', 'zohobooks', 'zohocrm', 'googlesheets', 'linear'));
  end if;
  -- One named check since 0115; whatever its name, every check on the method is replaced once, by the named one.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.milestones'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%verification_method%' and pg_get_constraintdef(oid) like '%linear%'
  ) then
    for c in
      select conname from pg_constraint
       where conrelid = 'public.milestones'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%verification_method%'
    loop
      execute format('alter table public.milestones drop constraint %I', c.conname);
    end loop;
    alter table public.milestones
      add constraint milestones_verification_method_check check (verification_method in ('unverified', 'github', 'manual', 'seed', 'asana', 'linear'));
  end if;
end $$;

create table if not exists public.linear_issue_links (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.orgs(id) on delete cascade,
  milestone_id              uuid not null,
  connection_id             uuid not null,
  -- Linear's own id for the issue, which stays when the issue moves to another team; its identifier (ENG-123) does not.
  issue_id                  text not null constraint linear_issue_links_issue_id_check
                              check (issue_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  identifier                text not null constraint linear_issue_links_identifier_check check (identifier ~ '^[A-Z][A-Z0-9_]{0,9}-[0-9]{1,9}$'),
  team_id                   text constraint linear_issue_links_team_id_check
                              check (team_id is null or team_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  team_key                  text constraint linear_issue_links_team_key_check check (team_key is null or team_key ~ '^[A-Z][A-Z0-9_]{0,9}$'),
  issue_title               text not null constraint linear_issue_links_issue_title_check check (char_length(issue_title) between 1 and 200),
  issue_url                 text constraint linear_issue_links_issue_url_check
                              check (issue_url is null or (issue_url like 'https://linear.app/%' and char_length(issue_url) <= 500)),
  -- waiting: not completed in Linear; ready: completed, with criteria, for a person to accept; accepted: a person accepted
  -- the version they saw; held: for a person to review (reopened, canceled, changed, archived or deleted after
  -- acceptance, unreachable, no criteria).
  state                     text not null default 'waiting'
                              constraint linear_issue_links_state_check check (state in ('waiting', 'ready', 'accepted', 'held')),
  held_reason               text constraint linear_issue_links_held_reason_check
                              check (held_reason is null or held_reason in ('reopened', 'canceled', 'deliverable_changed', 'archived', 'issue_unreachable', 'no_criteria', 'unlinked')),
  -- Changed in Linear after the payment was sent or paid: shown as a dispute; the payment is not taken back.
  after_payment             boolean not null default false,
  held_at                   timestamptz,
  -- What Linear says of the issue as last read: its workflow state's type (completed, canceled, started and so on) and
  -- name, whether and when it was completed and by whom, its assignee, and whether it is archived or in the trash.
  state_type                text constraint linear_issue_links_state_type_check check (state_type is null or state_type ~ '^[a-z_]{1,40}$'),
  state_name                text constraint linear_issue_links_state_name_check check (state_name is null or char_length(state_name) between 1 and 200),
  completed                 boolean not null default false,
  completed_at              timestamptz,
  completed_by_id           text constraint linear_issue_links_completed_by_id_check
                              check (completed_by_id is null or completed_by_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  completed_by_name         text constraint linear_issue_links_completed_by_name_check check (completed_by_name is null or char_length(completed_by_name) between 1 and 200),
  assignee_id               text constraint linear_issue_links_assignee_id_check
                              check (assignee_id is null or assignee_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  assignee_name             text constraint linear_issue_links_assignee_name_check check (assignee_name is null or char_length(assignee_name) between 1 and 200),
  archived                  boolean not null default false,
  -- The deliverables' links: the attachments', the description's and the comments', each a kind, a label and a link.
  deliverables              jsonb not null default '[]'::jsonb constraint linear_issue_links_deliverables_check
                              check (jsonb_typeof(deliverables) = 'array' and octet_length(deliverables::text) <= 32000),
  deliverable_fingerprint   text constraint linear_issue_links_fingerprint_check check (deliverable_fingerprint is null or deliverable_fingerprint ~ '^[0-9a-f]{64}$'),
  -- How many attachments (at most 50) and comments (at most 100) the last read took, and whether Linear had more.
  attachments_read          integer not null default 0 constraint linear_issue_links_attachments_read_check check (attachments_read between 0 and 50),
  comments_read             integer not null default 0 constraint linear_issue_links_comments_read_check check (comments_read between 0 and 100),
  more_unread               boolean not null default false,
  issue_updated_at          timestamptz,
  last_read_at              timestamptz,
  read_error                text constraint linear_issue_links_read_error_check check (read_error is null or char_length(read_error) between 1 and 300),
  -- The version a person accepted: who, when, the deliverables they saw, the completion they saw and the criteria.
  accepted_by               uuid references auth.users(id) on delete set null,
  accepted_at               timestamptz,
  accepted_fingerprint      text constraint linear_issue_links_accepted_fingerprint_check check (accepted_fingerprint is null or accepted_fingerprint ~ '^[0-9a-f]{64}$'),
  accepted_completed_at     timestamptz,
  accepted_criteria_sha256  text constraint linear_issue_links_accepted_criteria_check check (accepted_criteria_sha256 is null or accepted_criteria_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_deliverables     jsonb constraint linear_issue_links_accepted_deliverables_check
                              check (accepted_deliverables is null or (jsonb_typeof(accepted_deliverables) = 'array' and octet_length(accepted_deliverables::text) <= 32000)),
  linked_by                 uuid references auth.users(id) on delete set null,
  linked_at                 timestamptz not null default now(),
  unlinked_by               uuid references auth.users(id) on delete set null,
  unlinked_at               timestamptz,
  updated_at                timestamptz not null default now(),
  constraint linear_issue_links_org_id_key unique (org_id, id),
  constraint linear_issue_links_milestone_fkey foreign key (org_id, milestone_id)
    references public.milestones (org_id, id) on delete cascade,
  constraint linear_issue_links_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade,
  constraint linear_issue_links_held_check check ((state = 'held') = (held_reason is not null)),
  constraint linear_issue_links_accepted_check check (state <> 'accepted' or (accepted_at is not null and accepted_fingerprint is not null)),
  constraint linear_issue_links_completed_check check (completed or completed_at is null)
);

-- One live link per milestone, and one per issue: the same delivered work never verifies two milestones. The issue's
-- index is also how a webhook delivery finds the links it names.
create unique index if not exists linear_issue_links_milestone_key on public.linear_issue_links (org_id, milestone_id) where unlinked_at is null;
create unique index if not exists linear_issue_links_issue_key on public.linear_issue_links (org_id, issue_id) where unlinked_at is null;
create index if not exists linear_issue_links_connection_idx on public.linear_issue_links (org_id, connection_id) where unlinked_at is null;

alter table public.linear_issue_links enable row level security;
revoke all privileges on table public.linear_issue_links from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.linear_issue_links to vestiarion_tenant;
grant all privileges on table public.linear_issue_links to service_role;
drop policy if exists tenant_isolation on public.linear_issue_links;
create policy tenant_isolation on public.linear_issue_links for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.linear_issue_links;
create policy tenant_isolation_guard on public.linear_issue_links as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- Accepting (LN8): a pending milestone becomes verified by a person's acceptance of its completed issue, as seen.
-- Invoker rights, as accept_asana_task: the tenant role runs it and RLS confines it to the token's workspace.
create or replace function public.accept_linear_issue(
  p_org_id uuid, p_link_id uuid, p_by uuid, p_fingerprint text, p_criteria_sha256 text, p_note text
) returns public.linear_issue_links
language plpgsql
set search_path = ''
as $$
declare
  l public.linear_issue_links;
  m public.milestones;
begin
  select * into l from public.linear_issue_links where id = p_link_id and org_id = p_org_id and unlinked_at is null for update;
  if not found then
    raise exception 'link_not_found: no linked issue with that id in this organization';
  end if;
  if l.state = 'accepted' then
    raise exception 'already_accepted: this work was accepted already';
  end if;
  if l.after_payment then
    raise exception 'after_payment: a payment for this milestone was sent before the issue changed';
  end if;
  if not l.completed then
    raise exception 'not_completed: the issue is not completed in Linear';
  end if;
  if l.archived then
    raise exception 'archived: the issue is archived or deleted in Linear';
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
         verification_method = 'linear',
         verification_status = 'verified',
         verification_checked_at = now(),
         verified_at = now(),
         verification_detail = jsonb_build_object(
           'note', p_note,
           'linearIssue', l.issue_url,
           'issueId', l.issue_id,
           'identifier', l.identifier,
           'completedAt', l.completed_at,
           'fingerprint', l.deliverable_fingerprint,
           'criteriaSha256', p_criteria_sha256,
           'acceptedBy', p_by
         )
   where id = m.id and org_id = p_org_id;

  update public.linear_issue_links
     set state = 'accepted', held_reason = null, held_at = null,
         accepted_by = p_by, accepted_at = now(), accepted_fingerprint = l.deliverable_fingerprint,
         accepted_completed_at = l.completed_at, accepted_criteria_sha256 = p_criteria_sha256,
         accepted_deliverables = l.deliverables, updated_at = now()
   where id = l.id and org_id = p_org_id
  returning * into l;
  return l;
end;
$$;

-- Holding (LN10): an accepted link whose issue was reopened, canceled, changed, archived or deleted, or can no longer be
-- read, is held for review, and the milestone's verification is taken back so the agent never pays it, unless the
-- payment is under way or paid (then only the link is held, as a dispute), the milestone is closed, or a person claimed
-- its decision in the last ten minutes (then nothing changes, and the next read tries again). Answers held,
-- held_after_payment, deferred or not_accepted.
create or replace function public.hold_linear_acceptance(p_org_id uuid, p_link_id uuid, p_reason text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  l public.linear_issue_links;
  m public.milestones;
  underway boolean;
begin
  if p_reason not in ('reopened', 'canceled', 'deliverable_changed', 'archived', 'issue_unreachable', 'unlinked') then
    raise exception 'bad_reason: %', p_reason;
  end if;
  select * into l from public.linear_issue_links where id = p_link_id and org_id = p_org_id and unlinked_at is null for update;
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
  if not underway and m.status <> 'closed' and m.verification_method = 'linear' then
    update public.milestones
       set verified = false,
           status = case when m.status in ('verified', 'held') then 'pending' else m.status end,
           verification_status = 'unverified',
           verification_checked_at = now(),
           verified_at = null,
           verification_detail = coalesce(m.verification_detail, '{}'::jsonb) || jsonb_build_object('heldReason', p_reason, 'heldAt', now())
     where id = m.id and org_id = p_org_id;
  end if;
  update public.linear_issue_links
     set state = 'held', held_reason = p_reason, held_at = now(), after_payment = underway, updated_at = now()
   where id = l.id and org_id = p_org_id;
  return case when underway then 'held_after_payment' else 'held' end;
end;
$$;

create or replace function public.linear_connector_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.accept_linear_issue(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.hold_linear_acceptance(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.linear_connector_ready(uuid) from public, anon, authenticated;
grant execute on function public.accept_linear_issue(uuid, uuid, uuid, text, text, text) to vestiarion_tenant, service_role;
grant execute on function public.hold_linear_acceptance(uuid, uuid, text) to vestiarion_tenant, service_role;
grant execute on function public.linear_connector_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.linear_connector_ready(uuid);
-- drop function if exists public.hold_linear_acceptance(uuid, uuid, text);
-- drop function if exists public.accept_linear_issue(uuid, uuid, uuid, text, text, text);
-- drop table if exists public.linear_issue_links;
-- and the checks without linear, once no row holds it.
