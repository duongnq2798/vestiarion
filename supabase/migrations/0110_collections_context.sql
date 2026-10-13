-- Collections that follow the customer's context (docs/superpowers/specs/2026-10-13-collections-context-design.md).
--
-- collection_policies: a customer's collection rules, one row per version, never changed: whether a reminder goes on its
-- own or waits for a person's OK first, the strongest tone allowed, the fewest days between two reminders (3 to 30), the
-- channel (email), and the member asked first. A new version is the last one plus one, for a client counterparty of the
-- same workspace. The tenant role reads and adds versions; nothing changes or deletes one but its customer, its workspace
-- or a person's account going (set null).
--
-- collection_tasks: what the collections stage asks a person to do for one receivable, once per receivable and subject
-- (subject_key): approve a reminder the rules hold, ask the HubSpot deal's owner before the first overdue reminder, find a
-- billing contact, review a promise whose day passed, check a claim of payment nobody found within a week, or follow up
-- once the agent's reminders are done. It keeps the
-- proposal it was opened for. A person resolves it once (approved, held until a day, no reminders, reminders resumed,
-- done); the stage closes one no longer needed (obsolete). A resolved task never changes again, but for the day its
-- members were emailed. The tenant role reads, adds and resolves; nothing deletes one but its invoice or workspace.
--
-- notification_deliveries: one row per email the collections stage sends, keyed by a SHA-256 of the recipient, the event
-- and the rules' version (I11), claimed before the send and marked sent after it. A claim whose send failed is deleted so
-- the next cycle tries again with the same key; a sent one is never deleted or changed. The tenant role reads, claims,
-- marks sent and releases.
--
-- collection_task_starts: the day the collections stage began opening tasks in a workspace, set once by its first run. A
-- need that was already so before it (a promise whose day was before it, a claim, reminders done, a missing contact, a
-- receivable already overdue) opens no task and emails nobody: turning tasks on sends no backlog. The tenant role reads
-- and sets it once.
--
-- invoices_open_receivables_idx: a workspace's open receivables by due day, as the collections stage reads them each
-- cycle.
--
-- crm_deals.owner_external_id: the CRM's owner of the deal (HubSpot's hubspot_owner_id), read with the deal.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. It redefines no earlier
-- migration's object.

alter table public.crm_deals add column if not exists owner_external_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_deals_owner_external_id_check' and conrelid = 'public.crm_deals'::regclass) then
    alter table public.crm_deals
      add constraint crm_deals_owner_external_id_check check (owner_external_id is null or char_length(owner_external_id) between 1 and 100);
  end if;
end $$;

create table if not exists public.collection_policies (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  counterparty_id   uuid not null,
  version           integer not null constraint collection_policies_version_check check (version between 1 and 100000),
  approval          text not null constraint collection_policies_approval_check check (approval in ('auto', 'ask_first')),
  max_tone          text not null constraint collection_policies_max_tone_check check (max_tone in ('friendly', 'firm', 'final')),
  min_days_between  integer not null constraint collection_policies_min_days_check check (min_days_between between 3 and 30),
  channel           text not null default 'email' constraint collection_policies_channel_check check (channel in ('email')),
  account_owner     uuid references auth.users(id) on delete set null,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint collection_policies_org_id_key unique (org_id, id),
  constraint collection_policies_version_key unique (org_id, counterparty_id, version),
  constraint collection_policies_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

create table if not exists public.collection_tasks (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  invoice_id       uuid not null,
  counterparty_id  uuid not null,
  kind             text not null constraint collection_tasks_kind_check check (kind in ('ask_owner', 'finance_review')),
  reason           text not null constraint collection_tasks_reason_check
                     check (reason in ('policy_ask_first', 'hubspot_owner', 'no_contact', 'promise_passed', 'claim_unverified', 'reminders_done')),
  subject_key      text not null constraint collection_tasks_subject_key_check check (char_length(subject_key) between 1 and 120),
  assignee         uuid references auth.users(id) on delete set null,
  policy_version   integer not null default 0 constraint collection_tasks_policy_version_check check (policy_version between 0 and 100000),
  proposal         jsonb not null constraint collection_tasks_proposal_check
                     check (jsonb_typeof(proposal) = 'object' and octet_length(proposal::text) <= 6000),
  status           text not null default 'open' constraint collection_tasks_status_check check (status in ('open', 'done')),
  outcome          text constraint collection_tasks_outcome_check
                     check (outcome is null or outcome in ('approved', 'held', 'no_reminder', 'resumed', 'done', 'obsolete')),
  hold_until       date,
  approved_number  integer constraint collection_tasks_approved_number_check check (approved_number is null or approved_number between 1 and 4),
  approved_tone    text constraint collection_tasks_approved_tone_check check (approved_tone is null or approved_tone in ('friendly', 'firm', 'final')),
  resolved_at      timestamptz,
  resolved_by      uuid references auth.users(id) on delete set null,
  notified_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint collection_tasks_org_id_key unique (org_id, id),
  constraint collection_tasks_subject_key unique (org_id, invoice_id, subject_key),
  constraint collection_tasks_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint collection_tasks_counterparty_fkey foreign key (org_id, counterparty_id) references public.counterparties (org_id, id) on delete cascade,
  -- Open with no outcome, or done with one and the time it was resolved.
  constraint collection_tasks_resolved check ((status = 'open') = (outcome is null) and (status = 'open') = (resolved_at is null)),
  -- A hold names its last day; nothing else does.
  constraint collection_tasks_hold check ((outcome = 'held') = (hold_until is not null) or (outcome is null and hold_until is null)),
  -- An approval names the reminder and its tone; nothing else does.
  constraint collection_tasks_approval check (
    (outcome = 'approved' and approved_number is not null and approved_tone is not null)
    or (outcome is distinct from 'approved' and approved_number is null and approved_tone is null)
  )
);

create index if not exists collection_tasks_open_idx on public.collection_tasks (org_id, status, created_at);

-- The reasons as this file names them, on a table an earlier run of it created.
alter table public.collection_tasks drop constraint if exists collection_tasks_reason_check;
alter table public.collection_tasks add constraint collection_tasks_reason_check
  check (reason in ('policy_ask_first', 'hubspot_owner', 'no_contact', 'promise_passed', 'claim_unverified', 'reminders_done'));

create table if not exists public.notification_deliveries (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  idempotency_key  text not null constraint notification_deliveries_key_check check (idempotency_key ~ '^[0-9a-f]{64}$'),
  kind             text not null constraint notification_deliveries_kind_check check (kind in ('collection_reminder', 'collection_task')),
  -- The receivable a reminder is about, or the task an email is about.
  subject_id       uuid not null,
  recipient_hash   text not null constraint notification_deliveries_recipient_check check (recipient_hash ~ '^[0-9a-f]{64}$'),
  policy_version   integer not null default 0 constraint notification_deliveries_policy_version_check check (policy_version between 0 and 100000),
  claimed_at       timestamptz not null default now(),
  sent_at          timestamptz,
  provider_id      text constraint notification_deliveries_provider_id_check check (provider_id is null or char_length(provider_id) <= 200),
  constraint notification_deliveries_key unique (org_id, idempotency_key)
);

create index if not exists notification_deliveries_subject_idx on public.notification_deliveries (org_id, subject_id);

create table if not exists public.collection_task_starts (
  org_id      uuid primary key references public.orgs(id) on delete cascade,
  starts_on   date not null,
  created_at  timestamptz not null default now()
);

create index if not exists invoices_open_receivables_idx
  on public.invoices (org_id, due_date) where direction = 'receivable' and status in ('pending', 'matched');

-- Row level security as every tenant table: a permissive policy and a restrictive guard, both on request_org_id().
do $$
declare
  t text;
begin
  foreach t in array array['collection_policies', 'collection_tasks', 'notification_deliveries', 'collection_task_starts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from anon, authenticated, vestiarion_tenant', t);
    execute format('grant all privileges on table public.%I to service_role', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I for all to vestiarion_tenant
         using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))', t);
    execute format('drop policy if exists tenant_isolation_guard on public.%I', t);
    execute format(
      'create policy tenant_isolation_guard on public.%I as restrictive for all to vestiarion_tenant
         using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))', t);
  end loop;
end $$;

-- What the tenant role may do: add a version of a customer's rules; open and resolve a task; claim, mark and release a
-- delivery; set the day tasks began, once. Nothing else.
grant select, insert on table public.collection_policies to vestiarion_tenant;
grant select, insert on table public.collection_tasks to vestiarion_tenant;
grant update (status, outcome, hold_until, approved_number, approved_tone, resolved_at, resolved_by, notified_at) on table public.collection_tasks to vestiarion_tenant;
grant select, insert, delete on table public.notification_deliveries to vestiarion_tenant;
grant update (sent_at, provider_id) on table public.notification_deliveries to vestiarion_tenant;
grant select, insert on table public.collection_task_starts to vestiarion_tenant;

-- A version of a customer's rules: for a client of the same workspace, the last version plus one.
create or replace function public.collection_policies_next()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last integer;
begin
  if not exists (select 1 from public.counterparties c where c.org_id = new.org_id and c.id = new.counterparty_id and c.role = 'client') then
    raise exception 'collection_policy_not_client' using detail = 'Collection rules are for a customer.';
  end if;
  select max(p.version) into v_last from public.collection_policies p where p.org_id = new.org_id and p.counterparty_id = new.counterparty_id;
  if new.version <> coalesce(v_last, 0) + 1 then
    raise exception 'collection_policy_version' using detail = 'A new version of a customer''s rules is the last one plus one.';
  end if;
  return new;
end;
$$;

revoke execute on function public.collection_policies_next() from public, anon, authenticated;

drop trigger if exists collection_policies_next on public.collection_policies;
create trigger collection_policies_next
  before insert on public.collection_policies
  for each row execute function public.collection_policies_next();

-- A version never changes. A person's account deleted (the foreign keys' set null) passes.
create or replace function public.collection_policies_fixed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.counterparty_id, new.version, new.approval, new.max_tone, new.min_days_between, new.channel, new.created_at)
     is distinct from
     (old.id, old.org_id, old.counterparty_id, old.version, old.approval, old.max_tone, old.min_days_between, old.channel, old.created_at)
     or (new.account_owner is distinct from old.account_owner and new.account_owner is not null)
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception 'collection_policy_fixed' using detail = 'A version of a customer''s rules never changes: save a new one.';
  end if;
  return new;
end;
$$;

revoke execute on function public.collection_policies_fixed() from public, anon, authenticated;

drop trigger if exists collection_policies_fixed on public.collection_policies;
create trigger collection_policies_fixed
  before update on public.collection_policies
  for each row execute function public.collection_policies_fixed();

-- A task is for a receivable of the customer it names, in the same workspace.
create or replace function public.collection_tasks_consistent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.invoices i
     where i.org_id = new.org_id and i.id = new.invoice_id and i.counterparty_id = new.counterparty_id and i.direction = 'receivable'
  ) then
    raise exception 'collection_task_receivable' using detail = 'A collection task is for a receivable of the customer it names.';
  end if;
  if new.status <> 'open' then
    raise exception 'collection_task_open' using detail = 'A collection task is opened open.';
  end if;
  return new;
end;
$$;

revoke execute on function public.collection_tasks_consistent() from public, anon, authenticated;

drop trigger if exists collection_tasks_consistent on public.collection_tasks;
create trigger collection_tasks_consistent
  before insert on public.collection_tasks
  for each row execute function public.collection_tasks_consistent();

-- A task is resolved once, and a resolved task never changes: but for the day its members were first emailed, and a
-- person's account deleted (set null).
create or replace function public.collection_tasks_resolve_once()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.invoice_id, new.counterparty_id, new.kind, new.reason, new.subject_key, new.policy_version, new.proposal, new.created_at)
     is distinct from
     (old.id, old.org_id, old.invoice_id, old.counterparty_id, old.kind, old.reason, old.subject_key, old.policy_version, old.proposal, old.created_at)
     or (new.assignee is distinct from old.assignee and new.assignee is not null) then
    raise exception 'collection_task_fixed' using detail = 'What a collection task is for never changes.';
  end if;
  if new.notified_at is distinct from old.notified_at and old.notified_at is not null then
    raise exception 'collection_task_fixed' using detail = 'A collection task keeps the time its members were first emailed.';
  end if;
  if old.status = 'done'
     and ((new.status, new.outcome, new.hold_until, new.approved_number, new.approved_tone, new.resolved_at)
            is distinct from (old.status, old.outcome, old.hold_until, old.approved_number, old.approved_tone, old.resolved_at)
          or (new.resolved_by is distinct from old.resolved_by and new.resolved_by is not null)) then
    raise exception 'collection_task_resolved' using detail = 'A resolved collection task stays as it was resolved.';
  end if;
  return new;
end;
$$;

revoke execute on function public.collection_tasks_resolve_once() from public, anon, authenticated;

drop trigger if exists collection_tasks_resolve_once on public.collection_tasks;
create trigger collection_tasks_resolve_once
  before update on public.collection_tasks
  for each row execute function public.collection_tasks_resolve_once();

-- A delivery is marked sent once, and a sent one is never released or changed (I11): a retry never sends twice. Only its
-- workspace being deleted removes a sent one.
create or replace function public.notification_deliveries_sent_once()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Its workspace being deleted takes it along: that delete comes from the foreign key's own trigger, one level down.
    if old.sent_at is not null and pg_trigger_depth() < 2 then
      raise exception 'notification_sent' using detail = 'A notification that was sent stays recorded.';
    end if;
    return old;
  end if;
  if (new.id, new.org_id, new.idempotency_key, new.kind, new.subject_id, new.recipient_hash, new.policy_version, new.claimed_at)
     is distinct from
     (old.id, old.org_id, old.idempotency_key, old.kind, old.subject_id, old.recipient_hash, old.policy_version, old.claimed_at)
     or (old.sent_at is not null and (new.sent_at is distinct from old.sent_at or new.provider_id is distinct from old.provider_id)) then
    raise exception 'notification_sent' using detail = 'A notification is marked sent once.';
  end if;
  return new;
end;
$$;

revoke execute on function public.notification_deliveries_sent_once() from public, anon, authenticated;

drop trigger if exists notification_deliveries_sent_once on public.notification_deliveries;
create trigger notification_deliveries_sent_once
  before update or delete on public.notification_deliveries
  for each row execute function public.notification_deliveries_sent_once();

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop index if exists public.invoices_open_receivables_idx;
-- drop table if exists public.collection_task_starts;
-- drop table if exists public.notification_deliveries;
-- drop table if exists public.collection_tasks;
-- drop table if exists public.collection_policies;
-- drop function if exists public.notification_deliveries_sent_once();
-- drop function if exists public.collection_tasks_resolve_once();
-- drop function if exists public.collection_tasks_consistent();
-- drop function if exists public.collection_policies_fixed();
-- drop function if exists public.collection_policies_next();
-- alter table public.crm_deals drop constraint if exists crm_deals_owner_external_id_check;
-- alter table public.crm_deals drop column if exists owner_external_id;
