-- Project budgets, and the money set aside for each project (docs/superpowers/specs/2026-10-13-project-budgets-design.md).
--
-- An earmark in the application, never escrow and never locked on chain: the treasury stays one pool, the spending
-- limit contract on Arc still enforces only the workspace-wide caps, and every payment still needs its cash when it is
-- sent. What a project adds is a count that two decisions can never both spend.
--
-- projects: a workspace's projects. A name, a budget and a buffer in USDC cents (the buffer is the part of the budget
-- the agent keeps back: a bill that would reach into it waits for a person), active or archived. The tenant role reads
-- and adds them, and changes only the name, the figures and the status; a project is never deleted but with its
-- workspace. Archiving waits until nothing open is left in it.
--
-- invoices.project_id, milestones.project_id, deals.project_id: what belongs to a project. Payables in USDC and
-- milestones only, never a receivable; a bill or milestone already paid, or being paid, keeps its project. A deal
-- brings its collected revenue to the project's page (counted from the deal, never from here).
--
-- milestones.po_reference: the purchase order a milestone was agreed under, so a bill and a milestone for the same
-- order are seen as one piece of work (P9).
--
-- project_reservations: the money set aside for one open bill or milestone of a project, in USDC cents (a bill's amount
-- counts to the cent above). One live reservation per bill and per milestone. A reservation is made only through
-- reserve_project_budget, or by an insert the trigger below checks the same way: under a lock on the project's row, it
-- refuses one that would take what is reserved and paid past the budget less its buffer. So two decisions at once
-- never set aside the same money twice: the second waits for the first, then counts it. A reservation is released, in
-- the same transaction, when its bill is paid or rejected, its milestone paid or closed, its amount changes, or it moves
-- to another project; what it was released for is kept. The tenant role reads and adds reservations, and sets only the
-- release.
--
-- reserve_project_budget: the one way the app sets money aside. It locks the bill or milestone, then the project, and
-- answers what it did with the project's figures as they stood: reserved (or already reserved), over (nothing set
-- aside: the caller holds the payment for a person), or why it had nothing to do.
--
-- project_figures: each project's reserved, paid and open money, as the reservation's own check counts it.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. It redefines no earlier
-- migration's object.

create table if not exists public.projects (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  name             text not null constraint projects_name_check check (char_length(btrim(name)) between 1 and 80),
  currency         text not null default 'USDC' constraint projects_currency_check check (currency = 'USDC'),
  budget_minor     bigint not null constraint projects_budget_check check (budget_minor between 0 and 1000000000000000),
  buffer_minor     bigint not null default 0 constraint projects_buffer_check check (buffer_minor >= 0),
  status           text not null default 'active' constraint projects_status_check check (status in ('active', 'archived')),
  idempotency_key  text not null constraint projects_idempotency_key_check check (char_length(idempotency_key) between 8 and 100),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  constraint projects_buffer_within_budget check (buffer_minor <= budget_minor),
  constraint projects_org_id_key unique (org_id, id),
  constraint projects_idempotency_key unique (org_id, idempotency_key)
);

-- Two active projects of one workspace never share a name.
create unique index if not exists projects_name_key on public.projects (org_id, lower(btrim(name))) where status = 'active';

alter table public.invoices add column if not exists project_id uuid;
alter table public.milestones add column if not exists project_id uuid;
alter table public.deals add column if not exists project_id uuid;
alter table public.milestones add column if not exists po_reference text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_project_fkey') then
    alter table public.invoices add constraint invoices_project_fkey
      foreign key (org_id, project_id) references public.projects (org_id, id) on delete set null (project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'milestones_project_fkey') then
    alter table public.milestones add constraint milestones_project_fkey
      foreign key (org_id, project_id) references public.projects (org_id, id) on delete set null (project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deals_project_fkey') then
    alter table public.deals add constraint deals_project_fkey
      foreign key (org_id, project_id) references public.projects (org_id, id) on delete set null (project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'milestones_po_reference_check') then
    alter table public.milestones add constraint milestones_po_reference_check
      check (po_reference is null or char_length(btrim(po_reference)) between 1 and 100);
  end if;
end $$;

create index if not exists invoices_project_idx on public.invoices (org_id, project_id) where project_id is not null;
create index if not exists milestones_project_idx on public.milestones (org_id, project_id) where project_id is not null;
create index if not exists deals_project_idx on public.deals (org_id, project_id) where project_id is not null;

create table if not exists public.project_reservations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  project_id      uuid not null,
  invoice_id      uuid,
  milestone_id    uuid,
  amount_minor    bigint not null constraint project_reservations_amount_check check (amount_minor between 1 and 1000000000000000),
  via             text not null constraint project_reservations_via_check check (via in ('entry', 'assignment', 'agent')),
  reserved_by     uuid references auth.users(id) on delete set null,
  reserved_at     timestamptz not null default now(),
  released_at     timestamptz,
  release_reason  text constraint project_reservations_release_reason_check check (release_reason in ('paid', 'rejected', 'closed', 'changed', 'moved')),
  constraint project_reservations_org_id_key unique (org_id, id),
  constraint project_reservations_project_fkey foreign key (org_id, project_id) references public.projects (org_id, id) on delete cascade,
  constraint project_reservations_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint project_reservations_milestone_fkey foreign key (org_id, milestone_id) references public.milestones (org_id, id) on delete cascade,
  constraint project_reservations_one_subject check (num_nonnulls(invoice_id, milestone_id) = 1),
  constraint project_reservations_release_check check ((released_at is null) = (release_reason is null))
);

-- One live reservation per bill and per milestone: its money is set aside once.
create unique index if not exists project_reservations_live_invoice on public.project_reservations (org_id, invoice_id) where invoice_id is not null and released_at is null;
create unique index if not exists project_reservations_live_milestone on public.project_reservations (org_id, milestone_id) where milestone_id is not null and released_at is null;
create index if not exists project_reservations_live_project on public.project_reservations (org_id, project_id) where released_at is null;

-- Row level security as every tenant table: a permissive policy and a restrictive guard, both on request_org_id().
do $$
declare
  t text;
begin
  foreach t in array array['projects', 'project_reservations'] loop
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

grant select, insert on table public.projects to vestiarion_tenant;
grant update (name, budget_minor, buffer_minor, status, updated_by, updated_at) on table public.projects to vestiarion_tenant;
grant select, insert on table public.project_reservations to vestiarion_tenant;
grant update (released_at, release_reason) on table public.project_reservations to vestiarion_tenant;
-- A deal is put in a project, or taken out of one; nothing else of it changes here.
grant update (project_id) on table public.deals to vestiarion_tenant;

-- A bill's or milestone's amount in USDC cents, to the cent above: what it sets aside and what it counts as paid.
create or replace function public.project_minor(p_amount numeric)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select ceil(p_amount * 100)::bigint;
$$;

revoke execute on function public.project_minor(numeric) from public, anon, authenticated;
grant execute on function public.project_minor(numeric) to vestiarion_tenant, service_role;

-- What a project's bills and milestones paid, in USDC cents: a bill at what its transfer carried, after any discount.
create or replace function public.project_paid_minor(p_org_id uuid, p_project_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce((select sum(public.project_minor(coalesce(i.paid_amount, i.amount)))
                     from public.invoices i
                    where i.org_id = p_org_id and i.project_id = p_project_id and i.direction = 'payable' and i.status = 'paid'), 0)::bigint
       + coalesce((select sum(public.project_minor(m.amount))
                     from public.milestones m
                    where m.org_id = p_org_id and m.project_id = p_project_id and m.status = 'paid'), 0)::bigint;
$$;

revoke execute on function public.project_paid_minor(uuid, uuid) from public, anon, authenticated;
grant execute on function public.project_paid_minor(uuid, uuid) to vestiarion_tenant, service_role;

-- What is set aside for a project now, in USDC cents.
create or replace function public.project_reserved_minor(p_org_id uuid, p_project_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(r.amount_minor), 0)::bigint
    from public.project_reservations r
   where r.org_id = p_org_id and r.project_id = p_project_id and r.released_at is null;
$$;

revoke execute on function public.project_reserved_minor(uuid, uuid) from public, anon, authenticated;
grant execute on function public.project_reserved_minor(uuid, uuid) to vestiarion_tenant, service_role;

-- A project's id, workspace, currency, key and creation never change; archiving waits until nothing open is left in it.
create or replace function public.projects_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.currency, new.idempotency_key, new.created_at) is distinct from (old.id, old.org_id, old.currency, old.idempotency_key, old.created_at)
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception 'project_fixed' using detail = 'A project keeps its workspace, currency and creation.';
  end if;
  if new.status = 'archived' and old.status = 'active' and (
       exists (select 1 from public.invoices i where i.org_id = new.org_id and i.project_id = new.id and i.direction = 'payable' and i.status not in ('paid', 'rejected'))
       or exists (select 1 from public.milestones m where m.org_id = new.org_id and m.project_id = new.id and m.status not in ('paid', 'closed'))
     ) then
    raise exception 'project_has_open_work' using detail = 'A project with open bills or milestones is not archived: pay, reject or move them first.';
  end if;
  return new;
end;
$$;

revoke execute on function public.projects_guard() from public, anon, authenticated;

drop trigger if exists projects_guard on public.projects;
create trigger projects_guard
  before update on public.projects
  for each row execute function public.projects_guard();

-- What may be in a project: a payable in USDC or a milestone, put in an active project; and a bill or milestone paid,
-- or being paid, keeps its project.
create or replace function public.project_assignment_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moved boolean := true;
begin
  if tg_op = 'UPDATE' then
    v_moved := new.project_id is distinct from old.project_id;
  end if;
  if v_moved and tg_op = 'UPDATE' then
    if tg_table_name = 'invoices' and old.status in ('paid', 'matched', 'processing') then
      raise exception 'project_locked' using detail = 'A bill that is paid, or being paid, keeps its project.';
    end if;
    if tg_table_name = 'milestones' and old.status = 'paid' then
      raise exception 'project_locked' using detail = 'A paid milestone keeps its project.';
    end if;
  end if;
  if new.project_id is null then
    return new;
  end if;
  if tg_table_name = 'invoices' then
    if new.direction <> 'payable' then
      raise exception 'project_payables_only' using detail = 'A project holds bills to pay and milestones; a receivable comes in through a deal.';
    end if;
    if coalesce(new.currency, 'USDC') <> 'USDC' then
      raise exception 'project_usdc_only' using detail = 'A project counts bills in USDC.';
    end if;
  end if;
  if v_moved and not exists (select 1 from public.projects p where p.org_id = new.org_id and p.id = new.project_id and p.status = 'active') then
    raise exception 'project_archived' using detail = 'Nothing new is put in an archived project.';
  end if;
  return new;
end;
$$;

revoke execute on function public.project_assignment_check() from public, anon, authenticated;

drop trigger if exists invoices_project_assignment on public.invoices;
create trigger invoices_project_assignment
  before insert or update of project_id, currency, direction on public.invoices
  for each row execute function public.project_assignment_check();

drop trigger if exists milestones_project_assignment on public.milestones;
create trigger milestones_project_assignment
  before insert or update of project_id on public.milestones
  for each row execute function public.project_assignment_check();

-- A deal joins an active project only.
create or replace function public.deals_project_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id is not null and new.project_id is distinct from old.project_id
     and not exists (select 1 from public.projects p where p.org_id = new.org_id and p.id = new.project_id and p.status = 'active') then
    raise exception 'project_archived' using detail = 'Nothing new is put in an archived project.';
  end if;
  return new;
end;
$$;

revoke execute on function public.deals_project_check() from public, anon, authenticated;

drop trigger if exists deals_project_check on public.deals;
create trigger deals_project_check
  before update of project_id on public.deals
  for each row execute function public.deals_project_check();

-- The check every reservation passes, however it is inserted: under a lock on the project's row, so reservations of
-- one project are made one at a time, it refuses one for a bill or milestone that is not open in that project at that
-- amount, and one that would take what is reserved and paid past the budget less its buffer. The bill or milestone is
-- locked before the project, the order reserve_project_budget takes them in, so an insert that skips the function and
-- the function, for one bill at once, wait on each other rather than deadlock.
create or replace function public.project_reservations_within_budget()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_budget bigint;
  v_buffer bigint;
  v_status text;
  v_reserved bigint;
  v_paid bigint;
begin
  if new.invoice_id is not null then
    perform 1 from public.invoices i where i.org_id = new.org_id and i.id = new.invoice_id for update;
  else
    perform 1 from public.milestones m where m.org_id = new.org_id and m.id = new.milestone_id for update;
  end if;
  select p.budget_minor, p.buffer_minor, p.status into v_budget, v_buffer, v_status
    from public.projects p
   where p.org_id = new.org_id and p.id = new.project_id
     for update;
  if not found then
    raise exception 'project_not_found' using detail = 'No such project in this workspace.';
  end if;
  if v_status <> 'active' then
    raise exception 'project_archived' using detail = 'Nothing new is set aside in an archived project.';
  end if;
  if new.invoice_id is not null then
    perform 1 from public.invoices i
     where i.org_id = new.org_id and i.id = new.invoice_id and i.project_id = new.project_id and i.direction = 'payable'
       and i.status not in ('paid', 'rejected') and public.project_minor(i.amount) = new.amount_minor;
  else
    perform 1 from public.milestones m
     where m.org_id = new.org_id and m.id = new.milestone_id and m.project_id = new.project_id
       and m.status not in ('paid', 'closed') and public.project_minor(m.amount) = new.amount_minor;
  end if;
  if not found then
    raise exception 'project_reservation_mismatch' using detail = 'A reservation is for an open bill or milestone of the project, at its amount.';
  end if;
  -- One statement, so one snapshot: a bill paid meanwhile is counted once, as reserved or as paid, never as neither.
  select public.project_reserved_minor(new.org_id, new.project_id), public.project_paid_minor(new.org_id, new.project_id)
    into v_reserved, v_paid;
  if v_reserved + v_paid + new.amount_minor > v_budget - v_buffer then
    raise exception 'project_budget_exceeded'
      using detail = format('Needs %s; the budget less its buffer leaves %s.', new.amount_minor, v_budget - v_buffer - v_reserved - v_paid);
  end if;
  new.released_at := null;
  new.release_reason := null;
  return new;
end;
$$;

revoke execute on function public.project_reservations_within_budget() from public, anon, authenticated;

drop trigger if exists project_reservations_within_budget on public.project_reservations;
create trigger project_reservations_within_budget
  before insert on public.project_reservations
  for each row execute function public.project_reservations_within_budget();

-- A reservation's terms never change, and a release is set once, with its reason, and kept.
create or replace function public.project_reservations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.project_id, new.invoice_id, new.milestone_id, new.amount_minor, new.via, new.reserved_at)
     is distinct from
     (old.id, old.org_id, old.project_id, old.invoice_id, old.milestone_id, old.amount_minor, old.via, old.reserved_at)
     or (new.reserved_by is distinct from old.reserved_by and new.reserved_by is not null) then
    raise exception 'project_reservation_fixed' using detail = 'A reservation is never changed: it is released, and another is made.';
  end if;
  if old.released_at is not null and (new.released_at, new.release_reason) is distinct from (old.released_at, old.release_reason) then
    raise exception 'project_reservation_released' using detail = 'A released reservation stays released.';
  end if;
  return new;
end;
$$;

revoke execute on function public.project_reservations_guard() from public, anon, authenticated;

drop trigger if exists project_reservations_guard on public.project_reservations;
create trigger project_reservations_guard
  before update on public.project_reservations
  for each row execute function public.project_reservations_guard();

-- Released in the transaction that pays, rejects, closes, changes or moves the bill or milestone it was for.
create or replace function public.project_reservations_release()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reason text;
begin
  if tg_table_name = 'invoices' then
    v_reason := case
      when new.status = 'paid' and old.status is distinct from 'paid' then 'paid'
      when new.status = 'rejected' and old.status is distinct from 'rejected' then 'rejected'
      when new.project_id is distinct from old.project_id then 'moved'
      when new.amount is distinct from old.amount or new.currency is distinct from old.currency then 'changed'
    end;
    if v_reason is not null then
      update public.project_reservations r set released_at = now(), release_reason = v_reason
       where r.org_id = new.org_id and r.invoice_id = new.id and r.released_at is null;
    end if;
  else
    v_reason := case
      when new.status = 'paid' and old.status is distinct from 'paid' then 'paid'
      when new.status = 'closed' and old.status is distinct from 'closed' then 'closed'
      when new.project_id is distinct from old.project_id then 'moved'
      when new.amount is distinct from old.amount then 'changed'
    end;
    if v_reason is not null then
      update public.project_reservations r set released_at = now(), release_reason = v_reason
       where r.org_id = new.org_id and r.milestone_id = new.id and r.released_at is null;
    end if;
  end if;
  return null;
end;
$$;

revoke execute on function public.project_reservations_release() from public, anon, authenticated;

drop trigger if exists invoices_project_release on public.invoices;
create trigger invoices_project_release
  after update of status, amount, currency, project_id on public.invoices
  for each row execute function public.project_reservations_release();

drop trigger if exists milestones_project_release on public.milestones;
create trigger milestones_project_release
  after update of status, amount, project_id on public.milestones
  for each row execute function public.project_reservations_release();

-- The one way the app sets money aside (invoker rights: the tenant role runs it, and row level security confines it to
-- the token's workspace). The bill or milestone is locked first, so its amount, project and status cannot change under
-- the reservation; then the project, so reservations of one project are made one at a time. Answers what it did, with
-- the project's figures as it found them, before this reservation:
--   reserved (already: true when this amount was set aside before), over (nothing set aside), no_project, settled
--   (paid, rejected or closed: nothing to set aside), archived, not_found.
create or replace function public.reserve_project_budget(p_org_id uuid, p_invoice_id uuid, p_milestone_id uuid, p_via text, p_by uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_amount numeric;
  v_status text;
  v_needed bigint;
  v_project public.projects%rowtype;
  v_live public.project_reservations%rowtype;
  v_has_live boolean;
  v_reserved bigint;
  v_paid bigint;
  v_available bigint;
  v_id uuid;
  v_figures jsonb;
begin
  if num_nonnulls(p_invoice_id, p_milestone_id) <> 1 then
    raise exception 'project_subject' using detail = 'A reservation is for one bill or one milestone.';
  end if;
  if p_via not in ('entry', 'assignment', 'agent') then
    raise exception 'project_via' using detail = 'A reservation is made at entry, at assignment, or by the agent.';
  end if;
  if p_invoice_id is not null then
    select i.project_id, i.amount, i.status into v_project_id, v_amount, v_status
      from public.invoices i
     where i.org_id = p_org_id and i.id = p_invoice_id and i.direction = 'payable'
       for update;
  else
    select m.project_id, m.amount, m.status into v_project_id, v_amount, v_status
      from public.milestones m
     where m.org_id = p_org_id and m.id = p_milestone_id
       for update;
  end if;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;
  if v_project_id is null then
    return jsonb_build_object('state', 'no_project');
  end if;
  if v_status in ('paid', 'rejected', 'closed') then
    return jsonb_build_object('state', 'settled', 'projectId', v_project_id);
  end if;
  v_needed := public.project_minor(v_amount);

  select * into v_project from public.projects p where p.org_id = p_org_id and p.id = v_project_id for update;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;

  select * into v_live from public.project_reservations r
   where r.org_id = p_org_id and r.released_at is null
     and (r.invoice_id = p_invoice_id or r.milestone_id = p_milestone_id);
  v_has_live := found;

  -- One statement, so one snapshot: a bill paid meanwhile is counted once, as reserved or as paid, never as neither.
  select public.project_reserved_minor(p_org_id, v_project_id), public.project_paid_minor(p_org_id, v_project_id)
    into v_reserved, v_paid;
  v_figures := jsonb_build_object(
    'projectId', v_project.id,
    'projectName', v_project.name,
    'neededMinor', v_needed,
    'budgetMinor', v_project.budget_minor,
    'bufferMinor', v_project.buffer_minor,
    'paidMinor', v_paid
  );

  if v_has_live and v_live.project_id = v_project_id and v_live.amount_minor = v_needed then
    v_available := v_project.budget_minor - v_project.buffer_minor - v_reserved - v_paid;
    return v_figures || jsonb_build_object('state', 'reserved', 'already', true, 'reservationId', v_live.id,
      'reservedMinor', v_reserved - v_needed, 'availableMinor', v_available + v_needed);
  end if;
  if v_has_live then
    -- Set aside at another amount or in another project: the triggers release such a reservation as it changes, so
    -- this is only belt and braces.
    update public.project_reservations r set released_at = now(), release_reason = 'changed' where r.id = v_live.id;
    if v_live.project_id = v_project_id then
      v_reserved := v_reserved - v_live.amount_minor;
    end if;
  end if;

  v_available := v_project.budget_minor - v_project.buffer_minor - v_reserved - v_paid;
  v_figures := v_figures || jsonb_build_object('reservedMinor', v_reserved, 'availableMinor', v_available);
  if v_project.status <> 'active' then
    return v_figures || jsonb_build_object('state', 'archived');
  end if;
  if v_needed > v_available then
    return v_figures || jsonb_build_object('state', 'over');
  end if;
  insert into public.project_reservations (org_id, project_id, invoice_id, milestone_id, amount_minor, via, reserved_by)
  values (p_org_id, v_project_id, p_invoice_id, p_milestone_id, v_needed, p_via, p_by)
  returning id into v_id;
  return v_figures || jsonb_build_object('state', 'reserved', 'already', false, 'reservationId', v_id);
end;
$$;

revoke execute on function public.reserve_project_budget(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reserve_project_budget(uuid, uuid, uuid, text, uuid) to vestiarion_tenant, service_role;

-- Each project's money as the reservation's own check counts it, in USDC cents: what is set aside, what was paid, and
-- the open bills and milestones (not paid, rejected or closed) with what of them holds no reservation.
create or replace function public.project_figures(p_org_id uuid)
returns table (
  project_id uuid,
  reserved_minor bigint,
  paid_minor bigint,
  open_minor bigint,
  open_count integer,
  unreserved_minor bigint,
  unreserved_count integer
)
language sql
stable
set search_path = ''
as $$
  with open_work as (
    select i.project_id, public.project_minor(i.amount) as minor,
           exists (select 1 from public.project_reservations r where r.org_id = i.org_id and r.invoice_id = i.id and r.released_at is null) as reserved
      from public.invoices i
     where i.org_id = p_org_id and i.project_id is not null and i.direction = 'payable' and i.status not in ('paid', 'rejected')
    union all
    select m.project_id, public.project_minor(m.amount),
           exists (select 1 from public.project_reservations r where r.org_id = m.org_id and r.milestone_id = m.id and r.released_at is null)
      from public.milestones m
     where m.org_id = p_org_id and m.project_id is not null and m.status not in ('paid', 'closed')
  )
  select p.id,
         public.project_reserved_minor(p_org_id, p.id),
         public.project_paid_minor(p_org_id, p.id),
         coalesce((select sum(o.minor) from open_work o where o.project_id = p.id), 0)::bigint,
         (select count(*) from open_work o where o.project_id = p.id)::integer,
         coalesce((select sum(o.minor) from open_work o where o.project_id = p.id and not o.reserved), 0)::bigint,
         (select count(*) from open_work o where o.project_id = p.id and not o.reserved)::integer
    from public.projects p
   where p.org_id = p_org_id;
$$;

revoke execute on function public.project_figures(uuid) from public, anon, authenticated;
grant execute on function public.project_figures(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.project_figures(uuid);
-- drop function if exists public.reserve_project_budget(uuid, uuid, uuid, text, uuid);
-- drop trigger if exists milestones_project_release on public.milestones;
-- drop trigger if exists invoices_project_release on public.invoices;
-- drop function if exists public.project_reservations_release();
-- drop trigger if exists project_reservations_guard on public.project_reservations;
-- drop function if exists public.project_reservations_guard();
-- drop trigger if exists project_reservations_within_budget on public.project_reservations;
-- drop function if exists public.project_reservations_within_budget();
-- drop trigger if exists deals_project_check on public.deals;
-- drop function if exists public.deals_project_check();
-- drop trigger if exists milestones_project_assignment on public.milestones;
-- drop trigger if exists invoices_project_assignment on public.invoices;
-- drop function if exists public.project_assignment_check();
-- drop trigger if exists projects_guard on public.projects;
-- drop function if exists public.projects_guard();
-- drop function if exists public.project_reserved_minor(uuid, uuid);
-- drop function if exists public.project_paid_minor(uuid, uuid);
-- drop function if exists public.project_minor(numeric);
-- drop table if exists public.project_reservations;
-- alter table public.deals drop constraint if exists deals_project_fkey, drop column if exists project_id;
-- alter table public.milestones drop constraint if exists milestones_po_reference_check, drop column if exists po_reference;
-- alter table public.milestones drop constraint if exists milestones_project_fkey, drop column if exists project_id;
-- alter table public.invoices drop constraint if exists invoices_project_fkey, drop column if exists project_id;
-- drop table if exists public.projects;
