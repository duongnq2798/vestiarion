-- Commissions on money received (docs/superpowers/specs/2026-10-14-commissions-design.md C1-C15).
--
-- commission_plans: one row per version of a partner's plan: the partner (a counterparty), the member who is this
--   partner when one is, the rate in basis points, the basis (net or gross), the deals it covers (every deal, or those
--   in commission_plan_deals), the hold window in days and an optional reference. One version is in force per partner;
--   a change ends it and starts the next at the same instant (set_commission_plan). A version is never edited: it is
--   ended once (commission_plans_guard).
-- commission_lines: accruals (amount > 0) on money applied to a receivable of a covered deal, and adjustments (amount
--   < 0) of an accrual whose money was taken back off the receivable, recorded only by record_commissions. Partial
--   unique indexes allow one accrual per partner and allocation row, one per partner, whole-matched transfer, invoice
--   and occurrence, and one adjustment per accrual: replaying an event never records it twice. A line's terms never
--   change; what it was earned on may be deleted later (the foreign keys' set null), and the line, with its figures,
--   stays. It goes into a payout once, or again only out of a payout whose payable was rejected
--   (commission_lines_guard).
-- commission_payouts: one row per payable created from a review (create_commission_payout), which links the lines it
--   pays, in one transaction, under a lock per partner.
--
-- The tenant role only reads these tables: every write goes through the four functions below, which are definer
-- functions for that reason, each refusing another workspace than the request's (C1). They filter every read by the
-- workspace themselves, since a definer is not held by row-level security.
--
-- The partner never approves their own payout (C11): claim_invoice_decision is 0077's, with an approval refused to any
-- member a plan of the payout's partner ever named (commission_partner_members), and their open approvals not counted
-- as another person's. Whoever created a payout is treated as whoever created any payable (sole approver R1): naming a
-- member as the partner asks nothing of that member, so it never lets anyone approve what they created.
-- payment_approvals refuses the partner's approval row, inserted or changed. This file sorts after 0077, so every full
-- replay ends with this definition of the claim; a later migration that redefines the claim keeps these checks.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.commission_plans (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs(id) on delete cascade,
  beneficiary_id      uuid not null,
  beneficiary_member  uuid references auth.users(id) on delete set null,
  rate_bps            integer not null constraint commission_plans_rate_check check (rate_bps between 1 and 10000),
  basis               text not null constraint commission_plans_basis_check check (basis in ('net', 'gross')),
  scope               text not null constraint commission_plans_scope_check check (scope in ('all_deals', 'chosen_deals')),
  hold_days           integer not null constraint commission_plans_hold_days_check check (hold_days between 0 and 365),
  reference           text constraint commission_plans_reference_check check (reference is null or char_length(btrim(reference)) between 1 and 80),
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  replaces            uuid,
  created_by          uuid references auth.users(id) on delete set null,
  ended_by            uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint commission_plans_org_id_key unique (org_id, id),
  constraint commission_plans_ended_check check (ended_at is null or ended_at >= started_at),
  constraint commission_plans_beneficiary_fkey foreign key (org_id, beneficiary_id) references public.counterparties (org_id, id) on delete cascade,
  constraint commission_plans_replaces_fkey foreign key (org_id, replaces) references public.commission_plans (org_id, id) on delete set null (replaces)
);

-- One version in force per partner.
create unique index if not exists commission_plans_one_active on public.commission_plans (org_id, beneficiary_id) where ended_at is null;
create index if not exists commission_plans_beneficiary_idx on public.commission_plans (org_id, beneficiary_id, started_at);

create table if not exists public.commission_plan_deals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  plan_id     uuid not null,
  deal_id     uuid not null,
  created_at  timestamptz not null default now(),
  constraint commission_plan_deals_key unique (org_id, plan_id, deal_id),
  constraint commission_plan_deals_plan_fkey foreign key (org_id, plan_id) references public.commission_plans (org_id, id) on delete cascade,
  constraint commission_plan_deals_deal_fkey foreign key (org_id, deal_id) references public.deals (org_id, id) on delete cascade
);

create table if not exists public.commission_payouts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  beneficiary_id  uuid not null,
  invoice_id      uuid not null,
  statement       text not null constraint commission_payouts_statement_check check (statement ~ '^CS-[0-9A-F]{8}$'),
  currency        text not null constraint commission_payouts_currency_check check (currency in ('USDC', 'EURC')),
  amount          numeric(20, 6) not null constraint commission_payouts_amount_check check (amount > 0),
  line_count      integer not null constraint commission_payouts_line_count_check check (line_count >= 1),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint commission_payouts_org_id_key unique (org_id, id),
  constraint commission_payouts_invoice_key unique (org_id, invoice_id),
  constraint commission_payouts_beneficiary_fkey foreign key (org_id, beneficiary_id) references public.counterparties (org_id, id) on delete cascade,
  constraint commission_payouts_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade
);

create index if not exists commission_payouts_beneficiary_idx on public.commission_payouts (org_id, beneficiary_id);

create table if not exists public.commission_lines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  kind            text not null constraint commission_lines_kind_check check (kind in ('accrual', 'adjustment')),
  plan_id         uuid not null,
  beneficiary_id  uuid not null,
  -- What it was earned on. Each is kept while it exists; deleted later (a customer, a deal or an invoice removed), it
  -- is set null and the line, with its figures, stays (C1).
  invoice_id      uuid,
  deal_id         uuid,
  source          text not null constraint commission_lines_source_check check (source in ('payment', 'fee', 'whole_match')),
  -- An accrual's payment or fee row; an adjustment's reversal row. Null for a whole match.
  allocation_id   uuid,
  transfer_id     uuid,
  -- The how-many-th accrual of the same whole match: a match released and adjusted, then made again, earns again.
  occurrence      integer not null default 1 constraint commission_lines_occurrence_check check (occurrence >= 1),
  adjusts         uuid,
  basis           text not null constraint commission_lines_basis_check check (basis in ('net', 'gross')),
  base_amount     numeric(20, 6) not null constraint commission_lines_base_check check (base_amount > 0),
  rate_bps        integer not null constraint commission_lines_rate_check check (rate_bps between 1 and 10000),
  amount          numeric(20, 6) not null constraint commission_lines_amount_check check (amount <> 0),
  currency        text not null constraint commission_lines_currency_check check (currency in ('USDC', 'EURC')),
  applied_at      timestamptz not null,
  due_at          timestamptz not null,
  reason          text constraint commission_lines_reason_check check (reason is null or reason in ('allocation_reversed', 'whole_match_released')),
  payout_id       uuid,
  created_at      timestamptz not null default now(),
  constraint commission_lines_shape check (
    (kind = 'accrual' and amount > 0 and adjusts is null and reason is null)
    or (kind = 'adjustment' and amount < 0 and adjusts is not null and reason is not null)
  ),
  constraint commission_lines_org_id_key unique (org_id, id),
  constraint commission_lines_plan_fkey foreign key (org_id, plan_id) references public.commission_plans (org_id, id) on delete cascade,
  constraint commission_lines_beneficiary_fkey foreign key (org_id, beneficiary_id) references public.counterparties (org_id, id) on delete cascade,
  constraint commission_lines_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete set null (invoice_id),
  constraint commission_lines_deal_fkey foreign key (org_id, deal_id) references public.deals (org_id, id) on delete set null (deal_id),
  constraint commission_lines_allocation_fkey foreign key (org_id, allocation_id) references public.receivable_allocations (org_id, id) on delete set null (allocation_id),
  constraint commission_lines_transfer_fkey foreign key (org_id, transfer_id) references public.incoming_transfers (org_id, id) on delete set null (transfer_id),
  constraint commission_lines_adjusts_fkey foreign key (org_id, adjusts) references public.commission_lines (org_id, id) on delete cascade,
  constraint commission_lines_payout_fkey foreign key (org_id, payout_id) references public.commission_payouts (org_id, id) on delete set null (payout_id)
);

-- Replaying an event never records it twice (C5).
create unique index if not exists commission_lines_one_accrual on public.commission_lines (org_id, beneficiary_id, allocation_id)
  where kind = 'accrual' and allocation_id is not null;
create unique index if not exists commission_lines_one_whole_match on public.commission_lines (org_id, beneficiary_id, transfer_id, invoice_id, occurrence)
  where kind = 'accrual' and source = 'whole_match' and transfer_id is not null and invoice_id is not null;
create unique index if not exists commission_lines_one_adjustment on public.commission_lines (org_id, adjusts)
  where kind = 'adjustment';
create index if not exists commission_lines_beneficiary_idx on public.commission_lines (org_id, beneficiary_id, currency, due_at);
create index if not exists commission_lines_open_idx on public.commission_lines (org_id, applied_at, id) where payout_id is null;
create index if not exists commission_lines_payout_idx on public.commission_lines (org_id, payout_id) where payout_id is not null;

-- Row level security as every tenant table: a permissive policy and a restrictive guard, both on request_org_id().
do $$
declare
  t text;
begin
  foreach t in array array['commission_plans', 'commission_plan_deals', 'commission_payouts', 'commission_lines'] loop
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
    -- The tenant role reads; the functions below write.
    execute format('grant select on table public.%I to vestiarion_tenant', t);
  end loop;
end $$;

-- A version's terms never change; it is ended once, when it is ended. A foreign key's own set null (a person's account
-- deleted, the version it replaced deleted with its partner) passes.
create or replace function public.commission_plans_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.beneficiary_id, new.rate_bps, new.basis, new.scope, new.hold_days, new.reference, new.started_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.beneficiary_id, old.rate_bps, old.basis, old.scope, old.hold_days, old.reference, old.started_at, old.created_at)
     or (new.beneficiary_member is distinct from old.beneficiary_member and new.beneficiary_member is not null)
     or (new.created_by is distinct from old.created_by and new.created_by is not null)
     or (new.replaces is distinct from old.replaces and new.replaces is not null) then
    raise exception 'commission_plan_fixed: a commission plan is never changed; set a new one' using errcode = 'P0001';
  end if;
  if old.ended_at is not null then
    if new.ended_at is distinct from old.ended_at or (new.ended_by is distinct from old.ended_by and new.ended_by is not null) then
      raise exception 'commission_plan_ended: an ended commission plan stays ended' using errcode = 'P0001';
    end if;
  elsif new.ended_at is not null then
    if new.ended_at <> now() then
      raise exception 'commission_plan_ended: a commission plan ends when it is ended' using errcode = 'P0001';
    end if;
  elsif new.ended_by is distinct from old.ended_by and new.ended_by is not null then
    raise exception 'commission_plan_ended: a commission plan is ended with the time it ended' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- A line's terms never change; what it was earned on may only be cleared, by its foreign key's set null. It goes into a
-- payout whose payable is still pending, of its own partner and currency, once it is due, from none or from a payout
-- whose payable was rejected; it leaves a payout only when the payout itself is deleted (with its payable).
create or replace function public.commission_lines_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_payout public.commission_payouts;
begin
  if (new.id, new.org_id, new.kind, new.plan_id, new.beneficiary_id, new.source, new.occurrence, new.basis, new.base_amount,
      new.rate_bps, new.amount, new.currency, new.applied_at, new.due_at, new.reason, new.created_at)
     is distinct from
     (old.id, old.org_id, old.kind, old.plan_id, old.beneficiary_id, old.source, old.occurrence, old.basis, old.base_amount,
      old.rate_bps, old.amount, old.currency, old.applied_at, old.due_at, old.reason, old.created_at)
     or (new.invoice_id is distinct from old.invoice_id and new.invoice_id is not null)
     or (new.deal_id is distinct from old.deal_id and new.deal_id is not null)
     or (new.allocation_id is distinct from old.allocation_id and new.allocation_id is not null)
     or (new.transfer_id is distinct from old.transfer_id and new.transfer_id is not null)
     or new.adjusts is distinct from old.adjusts then
    raise exception 'commission_line_fixed: a commission line is never changed' using errcode = 'P0001';
  end if;
  if new.payout_id is not distinct from old.payout_id then
    return new;
  end if;
  if new.payout_id is null then
    if exists (select 1 from public.commission_payouts p where p.org_id = old.org_id and p.id = old.payout_id) then
      raise exception 'commission_line_paid_out: a commission line stays in its payout' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.payout_id is not null then
    select i.status into v_status
      from public.commission_payouts p
      join public.invoices i on i.org_id = p.org_id and i.id = p.invoice_id
     where p.org_id = old.org_id and p.id = old.payout_id;
    if found and v_status <> 'rejected' then
      raise exception 'commission_line_paid_out: a commission line stays in its payout' using errcode = 'P0001';
    end if;
  end if;
  select * into v_payout from public.commission_payouts where org_id = new.org_id and id = new.payout_id;
  if not found or v_payout.beneficiary_id <> new.beneficiary_id or v_payout.currency <> new.currency then
    raise exception 'commission_line_payout: a commission line goes into a payout of its own partner and currency' using errcode = 'P0001';
  end if;
  select i.status into v_status from public.invoices i where i.org_id = v_payout.org_id and i.id = v_payout.invoice_id;
  if v_status is distinct from 'pending' then
    raise exception 'commission_line_payout: a commission line goes into a payable not decided yet' using errcode = 'P0001';
  end if;
  if new.due_at > now() then
    raise exception 'commission_line_not_due: a commission line is paid once its hold window has passed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.commission_plans_guard() from public, anon, authenticated;
revoke all on function public.commission_lines_guard() from public, anon, authenticated;

drop trigger if exists commission_plans_guard on public.commission_plans;
create trigger commission_plans_guard before update on public.commission_plans
  for each row execute function public.commission_plans_guard();

drop trigger if exists commission_lines_guard on public.commission_lines;
create trigger commission_lines_guard before update on public.commission_lines
  for each row execute function public.commission_lines_guard();

-- Every member a plan of the partner a payable pays ever named as that partner; none for a payable that pays no
-- commission (C11). Invoker rights: row-level security confines it to the token's workspace.
create or replace function public.commission_partner_members(p_org_id uuid, p_invoice_id uuid) returns uuid[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(distinct pl.beneficiary_member), '{}'::uuid[])
    from public.commission_payouts po
    join public.commission_plans pl on pl.org_id = po.org_id and pl.beneficiary_id = po.beneficiary_id
   where po.org_id = p_org_id and po.invoice_id = p_invoice_id and pl.beneficiary_member is not null
$$;

revoke execute on function public.commission_partner_members(uuid, uuid) from public, anon, authenticated;
grant execute on function public.commission_partner_members(uuid, uuid) to vestiarion_tenant, service_role;

-- Whether this person may not approve this payable, because it pays the commission of a partner a plan named them as.
create or replace function public.commission_beneficiary_approval(p_org_id uuid, p_invoice_id uuid, p_user_id uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and p_user_id = any(public.commission_partner_members(p_org_id, p_invoice_id))
$$;

revoke execute on function public.commission_beneficiary_approval(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.commission_beneficiary_approval(uuid, uuid, uuid) to vestiarion_tenant, service_role;

-- An earlier draft of this file let a payout's creator approve it beside a partner-approver; anyone can name a member
-- as a partner, so that let an admin approve a payout they created. The draft ran only against test databases; this
-- removes its function wherever it might have been created, so every run ends without it.
drop function if exists public.commission_sole_approver(uuid, uuid, uuid);

-- A partner's plan, set or changed (C2): under a lock per partner, the version in force (the one the person changed,
-- or none) ends and the next starts at the same instant, with the deals it covers. A definer, since the tenant role does
-- not write the table; it refuses another workspace than the request's.
create or replace function public.set_commission_plan(
  p_org_id uuid, p_beneficiary_id uuid, p_rate_bps integer, p_basis text, p_scope text, p_deal_ids uuid[],
  p_hold_days integer, p_reference text, p_beneficiary_member uuid, p_replaces uuid, p_by uuid
) returns public.commission_plans
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_current public.commission_plans;
  v_plan    public.commission_plans;
  v_deals   uuid[];
begin
  if p_org_id is null or p_org_id is distinct from public.request_org_id() then
    raise exception 'commission_other_workspace: commissions are written in the request''s own workspace' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('commission:' || p_org_id::text || ':' || p_beneficiary_id::text, 0));
  select role into v_role from public.counterparties where org_id = p_org_id and id = p_beneficiary_id;
  if not found then
    raise exception 'commission_no_beneficiary: no such counterparty in this workspace' using errcode = 'P0001';
  end if;
  if v_role = 'client' then
    raise exception 'commission_beneficiary_client: a client pays the business and earns no commission' using errcode = 'P0001';
  end if;
  if p_beneficiary_member is not null and not exists (
    select 1 from public.memberships where org_id = p_org_id and user_id = p_beneficiary_member
  ) then
    raise exception 'commission_member_not_found: that person is not a member of this workspace' using errcode = 'P0001';
  end if;
  select * into v_current from public.commission_plans where org_id = p_org_id and beneficiary_id = p_beneficiary_id and ended_at is null;
  if (found and p_replaces is distinct from v_current.id) or (not found and p_replaces is not null) then
    raise exception 'commission_plan_changed: the plan changed since it was read' using errcode = 'P0001';
  end if;
  if p_by is not null and (p_by = p_beneficiary_member or exists (
    select 1 from public.commission_plans where org_id = p_org_id and beneficiary_id = p_beneficiary_id and beneficiary_member = p_by
  )) then
    raise exception 'commission_beneficiary: a partner does not set their own commission plan' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(distinct d), '{}') into v_deals from unnest(coalesce(p_deal_ids, '{}')) as d where d is not null;
  if p_scope = 'chosen_deals' and cardinality(v_deals) = 0 then
    raise exception 'commission_no_deals: choose at least one deal' using errcode = 'P0001';
  end if;

  if v_current.id is not null then
    update public.commission_plans set ended_at = now(), ended_by = p_by where org_id = p_org_id and id = v_current.id;
  end if;
  insert into public.commission_plans (org_id, beneficiary_id, beneficiary_member, rate_bps, basis, scope, hold_days, reference, started_at, replaces, created_by)
  values (p_org_id, p_beneficiary_id, p_beneficiary_member, p_rate_bps, p_basis, p_scope, p_hold_days, nullif(btrim(p_reference), ''), now(), v_current.id, p_by)
  returning * into v_plan;
  if p_scope = 'chosen_deals' then
    insert into public.commission_plan_deals (org_id, plan_id, deal_id) select p_org_id, v_plan.id, d from unnest(v_deals) as d;
  end if;
  return v_plan;
end;
$$;

revoke execute on function public.set_commission_plan(uuid, uuid, integer, text, text, uuid[], integer, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_commission_plan(uuid, uuid, integer, text, text, uuid[], integer, text, uuid, uuid, uuid) to vestiarion_tenant, service_role;

-- A plan ended (C2): money that arrives from now on earns nothing under it; what it earned before stays.
create or replace function public.end_commission_plan(p_org_id uuid, p_plan_id uuid, p_by uuid) returns public.commission_plans
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.commission_plans;
begin
  if p_org_id is null or p_org_id is distinct from public.request_org_id() then
    raise exception 'commission_other_workspace: commissions are written in the request''s own workspace' using errcode = 'P0001';
  end if;
  select * into v_plan from public.commission_plans where org_id = p_org_id and id = p_plan_id;
  if not found then
    raise exception 'commission_plan_not_found: no such commission plan in this workspace' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('commission:' || p_org_id::text || ':' || v_plan.beneficiary_id::text, 0));
  select * into v_plan from public.commission_plans where org_id = p_org_id and id = p_plan_id for update;
  if v_plan.ended_at is not null then
    raise exception 'commission_plan_changed: the plan changed since it was read' using errcode = 'P0001';
  end if;
  if p_by is not null and exists (
    select 1 from public.commission_plans where org_id = p_org_id and beneficiary_id = v_plan.beneficiary_id and beneficiary_member = p_by
  ) then
    raise exception 'commission_beneficiary: a partner does not end their own commission plan' using errcode = 'P0001';
  end if;
  update public.commission_plans set ended_at = now(), ended_by = p_by where org_id = p_org_id and id = p_plan_id returning * into v_plan;
  return v_plan;
end;
$$;

revoke execute on function public.end_commission_plan(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.end_commission_plan(uuid, uuid, uuid) to vestiarion_tenant, service_role;

-- Accruals and adjustments not recorded yet, recorded; the rows this call inserted, answered (C3-C7). A commission is
-- the base times the rate, rounded down to the millionth, under the plan version in force when the money arrived on Arc
-- (C3). Replaying, or two callers at once, records nothing twice: each insert skips what a unique index already holds.
-- Each of the three inserts takes at most 300 rows, oldest first, so one answer stays under PostgREST's 1,000 rows; a
-- caller answered 300 or more calls again.
create or replace function public.record_commissions(p_org_id uuid) returns setof public.commission_lines
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids  uuid[] := '{}';
  v_more uuid[];
begin
  if p_org_id is null or p_org_id is distinct from public.request_org_id() then
    raise exception 'commission_other_workspace: commissions are written in the request''s own workspace' using errcode = 'P0001';
  end if;

  -- Payment rows, and fee rows under the gross basis, applied to a receivable of a covered deal and still in force. The
  -- money's time is its arrival on Arc: a payment's own transfer, a fee's the latest payment in force beside it.
  with applied as (
    select a.id, a.org_id, a.kind, a.invoice_id, a.transfer_id, a.amount, a.currency, a.created_at, i.deal_id,
           coalesce(
             case when a.kind = 'payment' then t.received_at
                  else (select max(pt.received_at)
                          from public.receivable_allocations pa
                          join public.incoming_transfers pt on pt.org_id = pa.org_id and pt.id = pa.transfer_id
                         where pa.org_id = a.org_id and pa.invoice_id = a.invoice_id and pa.kind = 'payment'
                           and not exists (select 1 from public.receivable_allocations pr where pr.org_id = pa.org_id and pr.reverses = pa.id))
             end,
             a.created_at) as money_at
      from public.receivable_allocations a
      join public.invoices i on i.org_id = a.org_id and i.id = a.invoice_id
      left join public.incoming_transfers t on t.org_id = a.org_id and t.id = a.transfer_id
     where a.org_id = p_org_id and a.kind in ('payment', 'fee')
       and i.direction = 'receivable' and i.deal_id is not null
       and not exists (select 1 from public.receivable_allocations r where r.org_id = a.org_id and r.reverses = a.id)
  ),
  candidates as (
    select a.org_id, p.id as plan_id, p.beneficiary_id, a.invoice_id, a.deal_id, a.kind as source, a.id as allocation_id,
           a.transfer_id, p.basis, a.amount as base_amount, p.rate_bps,
           floor(a.amount * p.rate_bps * 100) / 1000000 as commission,
           a.currency, a.created_at as applied_at, a.created_at + make_interval(days => p.hold_days) as due_at
      from applied a
      join public.commission_plans p
        on p.org_id = a.org_id and p.started_at <= a.money_at and (p.ended_at is null or a.money_at < p.ended_at)
     where (a.kind = 'payment' or p.basis = 'gross')
       and (p.scope = 'all_deals'
            or exists (select 1 from public.commission_plan_deals d where d.org_id = p.org_id and d.plan_id = p.id and d.deal_id = a.deal_id))
       and floor(a.amount * p.rate_bps * 100) > 0
       and not exists (select 1 from public.commission_lines l
                        where l.org_id = a.org_id and l.beneficiary_id = p.beneficiary_id and l.allocation_id = a.id and l.kind = 'accrual')
     order by a.created_at, a.id
     limit 300
  ),
  inserted as (
    insert into public.commission_lines (org_id, kind, plan_id, beneficiary_id, invoice_id, deal_id, source, allocation_id, transfer_id,
                                         basis, base_amount, rate_bps, amount, currency, applied_at, due_at)
    select c.org_id, 'accrual', c.plan_id, c.beneficiary_id, c.invoice_id, c.deal_id, c.source, c.allocation_id, c.transfer_id,
           c.basis, c.base_amount, c.rate_bps, c.commission, c.currency, c.applied_at, c.due_at
      from candidates c
    on conflict (org_id, beneficiary_id, allocation_id) where kind = 'accrual' and allocation_id is not null do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_more from inserted;
  v_ids := v_ids || v_more;

  -- Whole matches (allocations L3): a transfer matched to the receivable in full, once the receivable is settled by it,
  -- at its arrival. A match released and adjusted, then made again, is its next occurrence and earns again.
  with matched as (
    select t.org_id, t.id as transfer_id, t.invoice_id, t.amount, t.token, t.received_at, i.deal_id
      from public.incoming_transfers t
      join public.invoices i on i.org_id = t.org_id and i.id = t.invoice_id
     where t.org_id = p_org_id and t.invoice_id is not null
       and i.direction = 'receivable' and i.status = 'received' and i.deal_id is not null
  ),
  candidates as (
    select m.org_id, p.id as plan_id, p.beneficiary_id, m.invoice_id, m.deal_id, m.transfer_id, p.basis,
           m.amount as base_amount, p.rate_bps, floor(m.amount * p.rate_bps * 100) / 1000000 as commission,
           m.token as currency, m.received_at as applied_at, m.received_at + make_interval(days => p.hold_days) as due_at,
           (select count(*) from public.commission_lines l
             where l.org_id = m.org_id and l.beneficiary_id = p.beneficiary_id and l.transfer_id = m.transfer_id
               and l.invoice_id = m.invoice_id and l.kind = 'accrual' and l.source = 'whole_match')::integer + 1 as occurrence
      from matched m
      join public.commission_plans p
        on p.org_id = m.org_id and p.started_at <= m.received_at and (p.ended_at is null or m.received_at < p.ended_at)
     where (p.scope = 'all_deals'
            or exists (select 1 from public.commission_plan_deals d where d.org_id = p.org_id and d.plan_id = p.id and d.deal_id = m.deal_id))
       and floor(m.amount * p.rate_bps * 100) > 0
       and not exists (select 1 from public.commission_lines l
                        where l.org_id = m.org_id and l.beneficiary_id = p.beneficiary_id and l.transfer_id = m.transfer_id
                          and l.invoice_id = m.invoice_id and l.kind = 'accrual' and l.source = 'whole_match'
                          and not exists (select 1 from public.commission_lines adj where adj.org_id = l.org_id and adj.adjusts = l.id))
     order by m.received_at, m.transfer_id
     limit 300
  ),
  inserted as (
    insert into public.commission_lines (org_id, kind, plan_id, beneficiary_id, invoice_id, deal_id, source, allocation_id, transfer_id, occurrence,
                                         basis, base_amount, rate_bps, amount, currency, applied_at, due_at)
    select c.org_id, 'accrual', c.plan_id, c.beneficiary_id, c.invoice_id, c.deal_id, 'whole_match', null, c.transfer_id, c.occurrence,
           c.basis, c.base_amount, c.rate_bps, c.commission, c.currency, c.applied_at, c.due_at
      from candidates c
    on conflict (org_id, beneficiary_id, transfer_id, invoice_id, occurrence)
      where kind = 'accrual' and source = 'whole_match' and transfer_id is not null and invoice_id is not null do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_more from inserted;
  v_ids := v_ids || v_more;

  -- An accrual whose allocation row was reversed (allocations L8), or whose transfer now names another invoice or none
  -- (a whole match released), adjusted by exactly minus itself (C7): due with the accrual while it is not in a payout,
  -- else at once, carried forward. An accrual whose transfer or invoice was deleted is not adjusted.
  with taken_back as (
    select acc.*, r.id as reversal_id, r.created_at as taken_at, 'allocation_reversed'::text as why
      from public.commission_lines acc
      join public.receivable_allocations r on r.org_id = acc.org_id and r.reverses = acc.allocation_id and r.kind = 'reversal'
     where acc.org_id = p_org_id and acc.kind = 'accrual' and acc.allocation_id is not null
    union all
    select acc.*, null::uuid, now(), 'whole_match_released'::text
      from public.commission_lines acc
     where acc.org_id = p_org_id and acc.kind = 'accrual' and acc.source = 'whole_match'
       and acc.transfer_id is not null and acc.invoice_id is not null
       and exists (select 1 from public.incoming_transfers t
                    where t.org_id = acc.org_id and t.id = acc.transfer_id and t.invoice_id is distinct from acc.invoice_id)
  ),
  candidates as (
    select b.*,
           (b.payout_id is null or exists (
              select 1 from public.commission_payouts po
                join public.invoices pi on pi.org_id = po.org_id and pi.id = po.invoice_id
               where po.org_id = b.org_id and po.id = b.payout_id and pi.status = 'rejected')) as unpaid
      from taken_back b
     where not exists (select 1 from public.commission_lines adj where adj.org_id = b.org_id and adj.adjusts = b.id and adj.kind = 'adjustment')
     order by b.taken_at, b.id
     limit 300
  ),
  inserted as (
    insert into public.commission_lines (org_id, kind, plan_id, beneficiary_id, invoice_id, deal_id, source, allocation_id, transfer_id, adjusts,
                                         basis, base_amount, rate_bps, amount, currency, applied_at, due_at, reason)
    select c.org_id, 'adjustment', c.plan_id, c.beneficiary_id, c.invoice_id, c.deal_id, c.source, c.reversal_id, c.transfer_id, c.id,
           c.basis, c.base_amount, c.rate_bps, -c.amount, c.currency, c.taken_at,
           case when c.unpaid then c.due_at else c.taken_at end, c.why
      from candidates c
    on conflict (org_id, adjusts) where kind = 'adjustment' do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_more from inserted;
  v_ids := v_ids || v_more;

  return query
    select * from public.commission_lines l where l.org_id = p_org_id and l.id = any(v_ids) order by l.kind, l.applied_at, l.id;
end;
$$;

revoke execute on function public.record_commissions(uuid) from public, anon, authenticated;
grant execute on function public.record_commissions(uuid) to vestiarion_tenant, service_role;

-- One payable for what a partner is due now in one currency (C10): under the lock per partner, exactly the lines the
-- person reviewed, or a refusal; then the payable, the payout and the lines' link, in one transaction. It answers, for
-- the payable's entries, how many accruals and adjustments it pays and what each adds up to.
create or replace function public.create_commission_payout(
  p_org_id uuid, p_beneficiary_id uuid, p_currency text, p_line_ids uuid[], p_memo text, p_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open      uuid[];
  v_seen      uuid[];
  v_total     numeric;
  v_count     integer;
  v_accrued   numeric;
  v_adjusted  numeric;
  v_accruals  integer;
  v_payout    uuid := gen_random_uuid();
  v_statement text;
  v_invoice   uuid;
begin
  if p_org_id is null or p_org_id is distinct from public.request_org_id() then
    raise exception 'commission_other_workspace: commissions are written in the request''s own workspace' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('commission:' || p_org_id::text || ':' || p_beneficiary_id::text, 0));
  if not exists (select 1 from public.counterparties where org_id = p_org_id and id = p_beneficiary_id) then
    raise exception 'commission_no_beneficiary: no such counterparty in this workspace' using errcode = 'P0001';
  end if;
  if p_by is not null and exists (
    select 1 from public.commission_plans where org_id = p_org_id and beneficiary_id = p_beneficiary_id and beneficiary_member = p_by
  ) then
    raise exception 'commission_beneficiary: a partner does not create the payable for their own commission' using errcode = 'P0001';
  end if;
  if p_memo is null or char_length(btrim(p_memo)) not between 1 and 280 then
    raise exception 'commission_memo: a payable names what it pays' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(l.id order by l.id), '{}'), coalesce(sum(l.amount), 0), count(*),
         coalesce(sum(l.amount) filter (where l.kind = 'accrual'), 0), coalesce(sum(l.amount) filter (where l.kind = 'adjustment'), 0),
         count(*) filter (where l.kind = 'accrual')
    into v_open, v_total, v_count, v_accrued, v_adjusted, v_accruals
    from public.commission_lines l
   where l.org_id = p_org_id and l.beneficiary_id = p_beneficiary_id and l.currency = p_currency and l.due_at <= now()
     and (l.payout_id is null or exists (
            select 1 from public.commission_payouts po
              join public.invoices pi on pi.org_id = po.org_id and pi.id = po.invoice_id
             where po.org_id = l.org_id and po.id = l.payout_id and pi.status = 'rejected'));
  select coalesce(array_agg(distinct x order by x), '{}') into v_seen from unnest(coalesce(p_line_ids, '{}')) as x;
  if v_open <> v_seen then
    raise exception 'commission_changed: the commissions due changed since they were read' using errcode = 'P0001';
  end if;
  if v_count = 0 or v_total <= 0 then
    raise exception 'commission_nothing_due: nothing is due to pay' using errcode = 'P0001';
  end if;

  v_statement := 'CS-' || upper(left(replace(v_payout::text, '-', ''), 8));
  insert into public.invoices (org_id, direction, counterparty_id, amount, currency, memo, po_reference, goods_received, due_date, created_by)
  values (p_org_id, 'payable', p_beneficiary_id, v_total, p_currency, btrim(p_memo), v_statement, true, now(), p_by)
  returning id into v_invoice;
  insert into public.commission_payouts (id, org_id, beneficiary_id, invoice_id, statement, currency, amount, line_count, created_by)
  values (v_payout, p_org_id, p_beneficiary_id, v_invoice, v_statement, p_currency, v_total, v_count, p_by);
  update public.commission_lines set payout_id = v_payout where org_id = p_org_id and id = any(v_open);

  return jsonb_build_object(
    'payoutId', v_payout, 'invoiceId', v_invoice, 'statement', v_statement, 'amount', v_total, 'currency', p_currency, 'lineCount', v_count,
    'accrued', v_accrued, 'adjusted', v_adjusted, 'accruals', v_accruals, 'adjustments', v_count - v_accruals
  );
end;
$$;

revoke execute on function public.create_commission_payout(uuid, uuid, text, uuid[], text, uuid) from public, anon, authenticated;
grant execute on function public.create_commission_payout(uuid, uuid, text, uuid[], text, uuid) to vestiarion_tenant, service_role;

-- 0077's claim, with C11: the partner a commission payout pays never claims its approval, sole approver or not, and
-- their open approval is not another person's. Whoever created it is treated as 0077 treats whoever created any payable.
-- For a payable that pays no commission, both are no-ops.
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

  update public.invoices as i
     set status = 'processing', reviewed_by = p_by, reviewed_at = now()
   where i.id = p_invoice_id and i.org_id = p_org_id and i.direction = 'payable'
     and (i.status in ('held', 'flagged', 'awaiting_info')
          or (i.status = 'processing' and coalesce(i.reviewed_at, '-infinity'::timestamptz) < now() - interval '10 minutes'))
     and (p_decision <> 'approve' or not public.commission_beneficiary_approval(p_org_id, p_invoice_id, p_by))
     and (p_decision <> 'approve' or i.created_by is distinct from p_by or public.sole_approver(p_org_id, p_by)
          or exists (
            select 1 from public.payment_approvals a
             where a.org_id = p_org_id and a.source_type = 'invoice' and a.source_id = p_invoice_id
               and a.approved_by <> p_by and a.used_at is null
               and a.amount = i.amount and a.currency = coalesce(i.currency, 'USDC')
               and a.approved_by = any(public.approvers_among(p_org_id, array[a.approved_by]))
               and not (a.approved_by = any(public.commission_partner_members(p_org_id, p_invoice_id)))))
  returning i.* into v;
  if found then
    return v;
  end if;

  select * into v from public.invoices where id = p_invoice_id and org_id = p_org_id and direction = 'payable';
  if not found then
    raise exception 'invoice_not_found: no payable with that id in this organization';
  end if;
  if p_decision = 'approve' and (
       v.status in ('held', 'flagged', 'awaiting_info')
       or (v.status = 'processing' and coalesce(v.reviewed_at, '-infinity'::timestamptz) < now() - interval '10 minutes')
     ) then
    if public.commission_beneficiary_approval(p_org_id, p_invoice_id, p_by) then
      raise exception 'beneficiary_approval: the partner a commission pays cannot approve it';
    end if;
    if v.created_by = p_by and not public.sole_approver(p_org_id, p_by) then
      raise exception 'self_approval: the person who created an invoice cannot approve it';
    end if;
  end if;
  raise exception 'already_decided: the invoice is % now', v.status;
end;
$$;

revoke execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_invoice_decision(uuid, uuid, uuid, text) to vestiarion_tenant, service_role;

-- Nor gives one of two approvals (two approvals T4), nor the paying one stored as used (I4), inserted or changed.
create or replace function public.payment_approvals_not_beneficiary() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source_type = 'invoice' and public.commission_beneficiary_approval(new.org_id, new.source_id, new.approved_by) then
    raise exception 'beneficiary_approval: the partner a commission pays cannot approve it' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.payment_approvals_not_beneficiary() from public, anon, authenticated;

drop trigger if exists payment_approvals_not_beneficiary on public.payment_approvals;
create trigger payment_approvals_not_beneficiary before insert or update on public.payment_approvals
  for each row execute function public.payment_approvals_not_beneficiary();

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts). First re-run 0077_payment_integrity.sql for its claim_invoice_decision, which
-- names no commission; then:
-- drop trigger if exists payment_approvals_not_beneficiary on public.payment_approvals;
-- drop function if exists public.payment_approvals_not_beneficiary();
-- drop function if exists public.create_commission_payout(uuid, uuid, text, uuid[], text, uuid);
-- drop function if exists public.record_commissions(uuid);
-- drop function if exists public.end_commission_plan(uuid, uuid, uuid);
-- drop function if exists public.set_commission_plan(uuid, uuid, integer, text, text, uuid[], integer, text, uuid, uuid, uuid);
-- drop function if exists public.commission_beneficiary_approval(uuid, uuid, uuid);
-- drop function if exists public.commission_partner_members(uuid, uuid);
-- drop table if exists public.commission_lines;
-- drop table if exists public.commission_payouts;
-- drop table if exists public.commission_plan_deals;
-- drop table if exists public.commission_plans;
-- drop function if exists public.commission_lines_guard();
-- drop function if exists public.commission_plans_guard();
