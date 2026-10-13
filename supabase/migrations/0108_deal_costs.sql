-- Deal costs and escalations of held payables (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md).
--
-- deal_costs: what a deal is expected to cost, entered by a person: what it is, who it is for (an optional vendor or
-- contractor of the workspace), the amount in the deal's currency's minor units, the day it is expected to leave, and
-- whether a document backs it yet (K1). A cost that becomes a real payable or milestone is linked to it and counted from
-- it, never twice: one live cost per payable and per milestone, a payable only (K2). A cost is never edited: its terms
-- are fixed, a link is set once and never moved to another row, and a removal is kept with who removed it (K3). The
-- tenant role may insert and read, and update only the link and the removal.
--
-- approval_escalations: one row per held payable and decide-by day whose members were told it passed that day
-- undecided (E4). Claimed before the email is sent and released (deleted) when every send failed, so a payable is
-- escalated once per decide-by day, whichever cycle sends it.
--
-- approval_escalation_starts: the day a workspace's escalations started, set once by its first escalation run (E4). A
-- payable whose decide-by day is before it had passed its day before escalations began, and is never emailed: turning
-- escalations on sends no backlog.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.deal_costs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  deal_id          uuid not null,
  label            text not null constraint deal_costs_label_check check (char_length(btrim(label)) between 1 and 80),
  counterparty_id  uuid,
  amount_minor     bigint not null constraint deal_costs_amount_check check (amount_minor between 1 and 1000000000000000),
  expected_on      date not null,
  no_document      boolean not null default false,
  invoice_id       uuid,
  milestone_id     uuid,
  linked_at        timestamptz,
  linked_by        uuid references auth.users(id) on delete set null,
  removed_at       timestamptz,
  removed_by       uuid references auth.users(id) on delete set null,
  idempotency_key  text not null constraint deal_costs_idempotency_key_check check (char_length(idempotency_key) between 8 and 100),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint deal_costs_org_id_key unique (org_id, id),
  constraint deal_costs_idempotency_key unique (org_id, idempotency_key),
  constraint deal_costs_deal_fkey foreign key (org_id, deal_id) references public.deals (org_id, id) on delete cascade,
  constraint deal_costs_counterparty_fkey foreign key (org_id, counterparty_id) references public.counterparties (org_id, id) on delete set null (counterparty_id),
  constraint deal_costs_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete set null (invoice_id),
  constraint deal_costs_milestone_fkey foreign key (org_id, milestone_id) references public.milestones (org_id, id) on delete set null (milestone_id),
  constraint deal_costs_one_link check (invoice_id is null or milestone_id is null)
);

create index if not exists deal_costs_deal_idx on public.deal_costs (org_id, deal_id);

-- A payable or a milestone backs one live cost, of any deal: its money is counted once (K2).
create unique index if not exists deal_costs_invoice_key on public.deal_costs (org_id, invoice_id) where invoice_id is not null and removed_at is null;
create unique index if not exists deal_costs_milestone_key on public.deal_costs (org_id, milestone_id) where milestone_id is not null and removed_at is null;

create table if not exists public.approval_escalations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  invoice_id  uuid not null,
  decide_by   date not null,
  claimed_at  timestamptz not null default now(),
  sent_at     timestamptz,
  recipients  integer constraint approval_escalations_recipients_check check (recipients is null or recipients >= 0),
  failed      integer constraint approval_escalations_failed_check check (failed is null or failed >= 0),
  constraint approval_escalations_key unique (org_id, invoice_id, decide_by),
  constraint approval_escalations_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade
);

create table if not exists public.approval_escalation_starts (
  org_id      uuid primary key references public.orgs(id) on delete cascade,
  starts_on   date not null,
  created_at  timestamptz not null default now()
);

-- Row level security as every tenant table: a permissive policy and a restrictive guard, both on request_org_id().
do $$
declare
  t text;
begin
  foreach t in array array['deal_costs', 'approval_escalations', 'approval_escalation_starts'] loop
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

-- What the tenant role may do: add costs, link and remove them; nothing is deleted but with its deal or workspace.
grant select, insert on table public.deal_costs to vestiarion_tenant;
grant update (invoice_id, milestone_id, linked_at, linked_by, removed_at, removed_by) on table public.deal_costs to vestiarion_tenant;
-- An escalation is claimed, marked sent, or released when nobody received it.
grant select, insert, delete on table public.approval_escalations to vestiarion_tenant;
grant update (sent_at, recipients, failed) on table public.approval_escalations to vestiarion_tenant;
-- A workspace's start is set once, and never changed or deleted but with the workspace.
grant select, insert on table public.approval_escalation_starts to vestiarion_tenant;

-- A cost's terms never change; a link is set once and never moved; a removal is never undone (K3). A foreign key's own
-- set null (a counterparty, a payable or a milestone deleted, a person's account deleted) passes.
create or replace function public.deal_costs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.deal_id, new.label, new.amount_minor, new.expected_on, new.no_document, new.idempotency_key, new.created_at)
     is distinct from
     (old.id, old.org_id, old.deal_id, old.label, old.amount_minor, old.expected_on, old.no_document, old.idempotency_key, old.created_at) then
    raise exception 'deal_cost_fixed' using detail = 'A deal cost is never changed: remove it and enter it again.';
  end if;
  if new.counterparty_id is distinct from old.counterparty_id and new.counterparty_id is not null then
    raise exception 'deal_cost_fixed' using detail = 'A deal cost keeps who it is for.';
  end if;
  if new.created_by is distinct from old.created_by and new.created_by is not null then
    raise exception 'deal_cost_fixed' using detail = 'A deal cost keeps who entered it.';
  end if;
  if old.removed_at is not null and (new.removed_at is distinct from old.removed_at or (new.removed_by is distinct from old.removed_by and new.removed_by is not null)) then
    raise exception 'deal_cost_removed' using detail = 'A removed deal cost stays removed.';
  end if;
  if old.removed_at is null and new.removed_at is null and new.removed_by is not null then
    raise exception 'deal_cost_removed' using detail = 'A deal cost is removed with the time it was removed.';
  end if;
  -- A link is set from none to one row, on a cost still counted, and never moved to another. The app never clears one;
  -- the row it names being deleted does (the foreign key's set null), and the cost is planned again.
  if (new.invoice_id is distinct from old.invoice_id and new.invoice_id is not null)
     or (new.milestone_id is distinct from old.milestone_id and new.milestone_id is not null) then
    if old.invoice_id is not null or old.milestone_id is not null then
      raise exception 'deal_cost_linked' using detail = 'A deal cost stays linked to what it was linked to.';
    end if;
    if old.removed_at is not null then
      raise exception 'deal_cost_removed' using detail = 'A removed deal cost is not linked.';
    end if;
    if new.linked_at is null then
      raise exception 'deal_cost_linked' using detail = 'A deal cost is linked with the time it was linked.';
    end if;
  elsif (new.linked_at is distinct from old.linked_at or (new.linked_by is distinct from old.linked_by and new.linked_by is not null))
        and (old.invoice_id is not null or old.milestone_id is not null) then
    raise exception 'deal_cost_linked' using detail = 'A deal cost keeps when it was linked, and who linked it.';
  end if;
  -- Only the foreign key clears a link, once the row it names is gone: cleared by hand, a link could be moved in two
  -- steps, and the money the cost was counted at would change without a trace.
  if (old.invoice_id is not null and new.invoice_id is null and exists (select 1 from public.invoices i where i.org_id = old.org_id and i.id = old.invoice_id))
     or (old.milestone_id is not null and new.milestone_id is null and exists (select 1 from public.milestones m where m.org_id = old.org_id and m.id = old.milestone_id)) then
    raise exception 'deal_cost_linked' using detail = 'A deal cost stays linked to what it was linked to.';
  end if;
  return new;
end;
$$;

revoke execute on function public.deal_costs_guard() from public, anon, authenticated;

drop trigger if exists deal_costs_guard on public.deal_costs;
create trigger deal_costs_guard
  before update on public.deal_costs
  for each row execute function public.deal_costs_guard();

-- A cost becomes a payable, never a receivable: a receivable is a deal's money in (K2).
create or replace function public.deal_costs_link_payable()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_direction text;
begin
  if new.invoice_id is null then
    return new;
  end if;
  select i.direction into v_direction from public.invoices i where i.org_id = new.org_id and i.id = new.invoice_id;
  if found and v_direction <> 'payable' then
    raise exception 'deal_cost_not_payable' using detail = 'A deal cost is linked to a payable only.';
  end if;
  return new;
end;
$$;

revoke execute on function public.deal_costs_link_payable() from public, anon, authenticated;

drop trigger if exists deal_costs_link_payable on public.deal_costs;
create trigger deal_costs_link_payable
  before insert or update of invoice_id on public.deal_costs
  for each row execute function public.deal_costs_link_payable();

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop trigger if exists deal_costs_link_payable on public.deal_costs;
-- drop function if exists public.deal_costs_link_payable();
-- drop trigger if exists deal_costs_guard on public.deal_costs;
-- drop function if exists public.deal_costs_guard();
-- drop table if exists public.approval_escalation_starts;
-- drop table if exists public.approval_escalations;
-- drop table if exists public.deal_costs;
