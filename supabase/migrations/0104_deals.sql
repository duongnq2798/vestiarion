-- Deals: a signed deal as a collection schedule (docs/superpowers/specs/2026-10-12-deal-schedule-design.md).
--
-- deals: the agreement on the receivables side: the customer (a counterparty of the workspace), a title, the currency
-- (USDC, EURC, or a three-letter code a shadow-mode workspace keeps its books in; never VND), the total of the current
-- version in the currency's minor units, the start date, the payment terms, an optional external reference (a CRM deal
-- id, unique per workspace), the template the schedule started from, whether it is active or cancelled, its current
-- version, whether the agent releases each line on its invoice day, and the idempotency key of the confirm that made it.
--
-- deal_versions: one row per version: version 1 is signed when the deal is confirmed; a change, a reopen or a cancel is
-- the next one, with its total, its reason, the changes as shown and its own key. Append-only for the tenant role.
--
-- deal_lines: the schedule. A line is a charge (positive) or a credit owed back to the customer (negative), with its
-- name, invoice day, due day, amount and the rounding it carries, added by a version. A version never changes a line: it
-- ends planned lines (superseded or cancelled) and adds new ones. The tenant role may update only a line's status and
-- release, and a trigger allows only planned to released, superseded or cancelled, and released back to planned only
-- while no receivable names the line. So a released line, and its receivable, never change through a deal.
--
-- A deferred constraint trigger checks at commit that the lines in force at every version add up to that version's
-- total, and that the deal names its latest version and that version's total.
--
-- invoices.deal_id, invoices.deal_line_id: the receivable a released line became, both or neither, a receivable only,
-- one per line, in the line's own deal (composite foreign key), made only while the line is released, never moved to
-- another line once set.
--
-- create_deal and revise_deal write a deal's first version and each later one whole, in one transaction, as the tenant
-- (security invoker): create_deal answers the deal already made for the same key; revise_deal refuses a change made
-- from a version that is no longer the current one.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.deals (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  counterparty_id  uuid not null,
  title            text not null constraint deals_title_check check (char_length(btrim(title)) between 1 and 120),
  currency         text not null constraint deals_currency_check check (currency in ('USDC', 'EURC') or (currency ~ '^[A-Z]{3}$' and currency <> 'VND')),
  minor_digits     smallint not null constraint deals_minor_digits_check check (minor_digits in (0, 2)),
  total_minor      bigint not null constraint deals_total_check check (total_minor between 0 and 1000000000000000),
  starts_on        date not null,
  terms_days       integer not null default 14 constraint deals_terms_check check (terms_days between 0 and 365),
  external_ref     text constraint deals_external_ref_check check (external_ref is null or char_length(btrim(external_ref)) between 1 and 200),
  template         text not null constraint deals_template_check check (template in ('deposit', 'milestones', 'retainer', 'custom')),
  status           text not null default 'active' constraint deals_status_check check (status in ('active', 'cancelled')),
  current_version  integer not null default 1 constraint deals_current_version_check check (current_version >= 1),
  auto_release     boolean not null default false,
  auto_release_by  uuid references auth.users(id) on delete set null,
  auto_release_at  timestamptz,
  idempotency_key  text not null constraint deals_idempotency_key_check check (char_length(idempotency_key) between 8 and 100),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint deals_org_id_key unique (org_id, id),
  constraint deals_idempotency_key unique (org_id, idempotency_key),
  constraint deals_counterparty_fkey foreign key (org_id, counterparty_id) references public.counterparties (org_id, id) on delete cascade
);

-- A CRM connector finds its deal again by its own id.
create unique index if not exists deals_external_ref_key on public.deals (org_id, external_ref) where external_ref is not null;

create table if not exists public.deal_versions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  deal_id          uuid not null,
  version          integer not null constraint deal_versions_version_check check (version >= 1),
  kind             text not null constraint deal_versions_kind_check check (kind in ('signed', 'revised', 'cancelled', 'reopened')),
  total_minor      bigint not null constraint deal_versions_total_check check (total_minor between 0 and 1000000000000000),
  reason           text constraint deal_versions_reason_check check (reason is null or char_length(btrim(reason)) between 1 and 280),
  changes          jsonb not null default '[]'::jsonb,
  idempotency_key  text constraint deal_versions_idempotency_key_check check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint deal_versions_key unique (org_id, deal_id, version),
  constraint deal_versions_idempotency_key unique (org_id, idempotency_key),
  constraint deal_versions_first_signed check ((version = 1) = (kind = 'signed')),
  constraint deal_versions_deal_fkey foreign key (org_id, deal_id) references public.deals (org_id, id) on delete cascade
);

create table if not exists public.deal_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  deal_id          uuid not null,
  added_in         integer not null,
  position         integer not null constraint deal_lines_position_check check (position >= 1),
  kind             text not null constraint deal_lines_kind_check check (kind in ('charge', 'credit')),
  label            text not null constraint deal_lines_label_check check (char_length(btrim(label)) between 1 and 80),
  invoice_on       date not null,
  due_on           date not null,
  amount_minor     bigint not null,
  rounding_minor   bigint not null default 0 constraint deal_lines_rounding_check check (rounding_minor >= 0),
  replaces         uuid,
  status           text not null default 'planned' constraint deal_lines_status_check check (status in ('planned', 'released', 'superseded', 'cancelled')),
  ended_in         integer,
  released_at      timestamptz,
  released_by      uuid references auth.users(id) on delete set null,
  released_via     text constraint deal_lines_released_via_check check (released_via is null or released_via in ('person', 'schedule')),
  created_at       timestamptz not null default now(),
  constraint deal_lines_org_id_key unique (org_id, id),
  constraint deal_lines_org_deal_id_key unique (org_id, deal_id, id),
  constraint deal_lines_position_key unique (org_id, deal_id, position),
  constraint deal_lines_deal_fkey foreign key (org_id, deal_id) references public.deals (org_id, id) on delete cascade,
  constraint deal_lines_added_in_fkey foreign key (org_id, deal_id, added_in) references public.deal_versions (org_id, deal_id, version) on delete cascade,
  constraint deal_lines_ended_in_fkey foreign key (org_id, deal_id, ended_in) references public.deal_versions (org_id, deal_id, version) on delete cascade,
  constraint deal_lines_replaces_fkey foreign key (org_id, deal_id, replaces) references public.deal_lines (org_id, deal_id, id) on delete cascade,
  constraint deal_lines_amount_sign check ((kind = 'charge' and amount_minor between 1 and 1000000000000000) or (kind = 'credit' and amount_minor between -1000000000000000 and -1)),
  constraint deal_lines_due_after_invoice check (due_on >= invoice_on),
  constraint deal_lines_credit_unreleased check (kind = 'charge' or status <> 'released'),
  constraint deal_lines_ended check ((status in ('superseded', 'cancelled')) = (ended_in is not null) and (ended_in is null or ended_in > added_in)),
  constraint deal_lines_release_fields check (
    (status = 'released') = (released_at is not null) and (status = 'released') = (released_via is not null) and (released_by is null or status = 'released')
  )
);

create index if not exists deal_lines_planned_idx on public.deal_lines (org_id, invoice_on) where status = 'planned';

-- The receivable a released line became.
alter table public.invoices
  add column if not exists deal_id uuid,
  add column if not exists deal_line_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_deal_line_fkey' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices add constraint invoices_deal_line_fkey foreign key (org_id, deal_id, deal_line_id)
      references public.deal_lines (org_id, deal_id, id) on delete set null (deal_id, deal_line_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_deal_pair' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices add constraint invoices_deal_pair check ((deal_id is null) = (deal_line_id is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_deal_receivable' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices add constraint invoices_deal_receivable check (deal_line_id is null or direction = 'receivable');
  end if;
end $$;

-- One receivable per line.
create unique index if not exists invoices_deal_line_key on public.invoices (org_id, deal_line_id) where deal_line_id is not null;

-- Row level security as every tenant table: a permissive policy and a restrictive guard, both on request_org_id().
do $$
declare
  t text;
begin
  foreach t in array array['deals', 'deal_versions', 'deal_lines'] loop
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

-- What the tenant role may do: add deals and change only their standing; add versions; add lines and change only their
-- status and release. Nothing is deleted but with its workspace.
grant select, insert on table public.deals to vestiarion_tenant;
grant update (status, current_version, total_minor, auto_release, auto_release_by, auto_release_at, updated_at) on table public.deals to vestiarion_tenant;
grant select, insert on table public.deal_versions to vestiarion_tenant;
grant select, insert on table public.deal_lines to vestiarion_tenant;
grant update (status, ended_in, released_at, released_by, released_via) on table public.deal_lines to vestiarion_tenant;

-- A line's terms never change, and its status moves only forward (D7, D10).
create or replace function public.deal_lines_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.org_id, new.deal_id, new.added_in, new.position, new.kind, new.label, new.invoice_on, new.due_on, new.amount_minor,
      new.rounding_minor, new.replaces, new.created_at)
     is distinct from
     (old.org_id, old.deal_id, old.added_in, old.position, old.kind, old.label, old.invoice_on, old.due_on, old.amount_minor,
      old.rounding_minor, old.replaces, old.created_at) then
    raise exception 'deal_line_fixed' using detail = 'A deal line is never changed: a new version replaces it.';
  end if;
  if new.status is distinct from old.status then
    if old.status = 'planned' and new.status in ('released', 'superseded', 'cancelled') then
      return new;
    end if;
    -- A release whose receivable was never made is undone.
    if old.status = 'released' and new.status = 'planned'
       and not exists (select 1 from public.invoices i where i.org_id = old.org_id and i.deal_line_id = old.id) then
      return new;
    end if;
    raise exception 'deal_line_status' using detail = format('A deal line does not go from %s to %s.', old.status, new.status);
  end if;
  -- A release is never rewritten; who released it is cleared only with that person's account.
  if old.status = 'released'
     and (new.released_at is distinct from old.released_at or new.released_via is distinct from old.released_via
          or (new.released_by is distinct from old.released_by and new.released_by is not null)) then
    raise exception 'deal_line_released' using detail = 'A released deal line is never changed.';
  end if;
  if new.ended_in is distinct from old.ended_in then
    raise exception 'deal_line_fixed' using detail = 'A deal line ends only with its status.';
  end if;
  return new;
end;
$$;

revoke execute on function public.deal_lines_guard() from public, anon, authenticated;

drop trigger if exists deal_lines_guard on public.deal_lines;
create trigger deal_lines_guard
  before update on public.deal_lines
  for each row execute function public.deal_lines_guard();

-- A receivable stays with the line it was made from; only the link's own cascade clears it.
create or replace function public.invoices_deal_link_fixed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deal_line_id is not null and new.deal_line_id is not null
     and (new.deal_line_id is distinct from old.deal_line_id or new.deal_id is distinct from old.deal_id) then
    raise exception 'invoice_deal_link_fixed' using detail = 'A receivable made from a deal line stays with that line.';
  end if;
  if old.deal_line_id is null and new.deal_line_id is not null then
    raise exception 'invoice_deal_link_fixed' using detail = 'A receivable is linked to a deal line when it is made.';
  end if;
  return new;
end;
$$;

revoke execute on function public.invoices_deal_link_fixed() from public, anon, authenticated;

drop trigger if exists invoices_deal_link_fixed on public.invoices;
create trigger invoices_deal_link_fixed
  before update of deal_id, deal_line_id on public.invoices
  for each row execute function public.invoices_deal_link_fixed();

-- A receivable is made only from a released line (D10). The line is held (for share) until the receivable commits, so
-- a release undone meanwhile (its own receivable failed) waits, then finds this one and stays; and an undo that came
-- first leaves the line planned, which this refuses. A line never stands planned with a receivable beside it. A line
-- not found is left to the foreign key.
create or replace function public.invoices_deal_line_released()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select l.status into v_status
    from public.deal_lines l
   where l.org_id = new.org_id and l.deal_id = new.deal_id and l.id = new.deal_line_id
     for share;
  if found and v_status <> 'released' then
    raise exception 'deal_line_not_released' using detail = format('A receivable is made from a released deal line; this one is %s.', v_status);
  end if;
  return new;
end;
$$;

revoke execute on function public.invoices_deal_line_released() from public, anon, authenticated;

drop trigger if exists invoices_deal_line_released on public.invoices;
create trigger invoices_deal_line_released
  before insert on public.invoices
  for each row when (new.deal_line_id is not null) execute function public.invoices_deal_line_released();

-- At commit: every version's total is what its lines in force add up to, and the deal names its latest version and
-- that version's total (D5, D7).
create or replace function public.deal_sums_hold()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_deal uuid;
  v_bad record;
begin
  -- Each assignment is prepared only when it runs: a deals row has no deal_id.
  if tg_table_name = 'deals' then
    v_deal := new.id;
  else
    v_deal := new.deal_id;
  end if;
  -- A deal deleted in the same transaction has nothing left to check.
  if not exists (select 1 from public.deals d where d.org_id = new.org_id and d.id = v_deal) then
    return null;
  end if;
  select v.version, v.total_minor, coalesce(sum(l.amount_minor), 0) as lines_minor
    into v_bad
    from public.deal_versions v
    left join public.deal_lines l
      on l.org_id = v.org_id and l.deal_id = v.deal_id and l.added_in <= v.version and (l.ended_in is null or l.ended_in > v.version)
   where v.org_id = new.org_id and v.deal_id = v_deal
   group by v.version, v.total_minor
  having v.total_minor <> coalesce(sum(l.amount_minor), 0)
   limit 1;
  if found then
    raise exception 'deal_sum_mismatch' using detail = format('Version %s totals %s; its lines add up to %s.', v_bad.version, v_bad.total_minor, v_bad.lines_minor);
  end if;
  if not exists (
    select 1
      from public.deals d
      join public.deal_versions v on v.org_id = d.org_id and v.deal_id = d.id and v.version = d.current_version
     where d.org_id = new.org_id and d.id = v_deal and d.total_minor = v.total_minor
       and not exists (select 1 from public.deal_versions w where w.org_id = d.org_id and w.deal_id = d.id and w.version > d.current_version)
  ) then
    raise exception 'deal_version_mismatch' using detail = 'A deal names its latest version and that version''s total.';
  end if;
  return null;
end;
$$;

revoke execute on function public.deal_sums_hold() from public, anon, authenticated;

drop trigger if exists deals_sums_hold on public.deals;
create constraint trigger deals_sums_hold
  after insert or update on public.deals
  deferrable initially deferred
  for each row execute function public.deal_sums_hold();

drop trigger if exists deal_versions_sums_hold on public.deal_versions;
create constraint trigger deal_versions_sums_hold
  after insert on public.deal_versions
  deferrable initially deferred
  for each row execute function public.deal_sums_hold();

drop trigger if exists deal_lines_sums_hold on public.deal_lines;
create constraint trigger deal_lines_sums_hold
  after insert or update on public.deal_lines
  deferrable initially deferred
  for each row execute function public.deal_sums_hold();

-- The deal, its first version and its lines, at once (D12). The same key answers the deal already made.
create or replace function public.create_deal(p_org_id uuid, p_deal jsonb, p_lines jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_key text := p_deal->>'idempotencyKey';
  v_id uuid;
  v_by uuid := nullif(p_deal->>'createdBy', '')::uuid;
  v_total bigint := (p_deal->>'totalMinor')::bigint;
begin
  select d.id into v_id from public.deals d where d.org_id = p_org_id and d.idempotency_key = v_key;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'created', false);
  end if;

  insert into public.deals (org_id, counterparty_id, title, currency, minor_digits, total_minor, starts_on, terms_days, external_ref, template,
                            status, current_version, auto_release, auto_release_by, auto_release_at, idempotency_key, created_by)
  values (p_org_id, (p_deal->>'counterpartyId')::uuid, btrim(p_deal->>'title'), p_deal->>'currency', (p_deal->>'minorDigits')::smallint, v_total,
          (p_deal->>'startsOn')::date, (p_deal->>'termsDays')::integer, nullif(btrim(coalesce(p_deal->>'externalRef', '')), ''), p_deal->>'template',
          'active', 1, coalesce((p_deal->>'autoRelease')::boolean, false),
          case when coalesce((p_deal->>'autoRelease')::boolean, false) then v_by end,
          case when coalesce((p_deal->>'autoRelease')::boolean, false) then now() end,
          v_key, v_by)
  on conflict (org_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select d.id into v_id from public.deals d where d.org_id = p_org_id and d.idempotency_key = v_key;
    return jsonb_build_object('id', v_id, 'created', false);
  end if;

  insert into public.deal_versions (org_id, deal_id, version, kind, total_minor, changes, created_by)
  values (p_org_id, v_id, 1, 'signed', v_total, coalesce(p_deal->'changes', '[]'::jsonb), v_by);

  insert into public.deal_lines (org_id, deal_id, added_in, position, kind, label, invoice_on, due_on, amount_minor, rounding_minor)
  select p_org_id, v_id, 1, (l->>'position')::integer, 'charge', btrim(l->>'label'), (l->>'invoiceOn')::date, (l->>'dueOn')::date,
         (l->>'amountMinor')::bigint, coalesce((l->>'roundingMinor')::bigint, 0)
    from jsonb_array_elements(p_lines) as l;

  return jsonb_build_object('id', v_id, 'created', true);
end;
$$;

revoke execute on function public.create_deal(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_deal(uuid, jsonb, jsonb) to service_role;
grant execute on function public.create_deal(uuid, jsonb, jsonb) to vestiarion_tenant;

-- The next version, whole (D7-D9), from the version the person saw: one made since refuses it (`deal_changed`), and a
-- planned line released since refuses it too (`deal_line_not_planned`). The same key answers the version already made.
create or replace function public.revise_deal(p_org_id uuid, p_deal_id uuid, p_base_version integer, p_revision jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_key text := nullif(p_revision->>'idempotencyKey', '');
  v_kind text := p_revision->>'kind';
  v_by uuid := nullif(p_revision->>'createdBy', '')::uuid;
  v_deal public.deals;
  v_version integer;
  v_end jsonb;
  v_count integer;
begin
  if v_key is not null then
    select v.version into v_version from public.deal_versions v where v.org_id = p_org_id and v.idempotency_key = v_key and v.deal_id = p_deal_id;
    if v_version is not null then
      return jsonb_build_object('version', v_version, 'created', false);
    end if;
  end if;

  select * into v_deal from public.deals d where d.org_id = p_org_id and d.id = p_deal_id for update;
  if not found then
    raise exception 'deal_not_found';
  end if;
  -- The same change may have committed while this one waited for the lock.
  if v_key is not null then
    select v.version into v_version from public.deal_versions v where v.org_id = p_org_id and v.idempotency_key = v_key and v.deal_id = p_deal_id;
    if v_version is not null then
      return jsonb_build_object('version', v_version, 'created', false);
    end if;
  end if;
  if v_deal.current_version <> p_base_version then
    raise exception 'deal_changed';
  end if;
  if not ((v_kind in ('revised', 'cancelled') and v_deal.status = 'active') or (v_kind = 'reopened' and v_deal.status = 'cancelled')) then
    raise exception 'deal_status';
  end if;

  v_version := v_deal.current_version + 1;
  insert into public.deal_versions (org_id, deal_id, version, kind, total_minor, reason, changes, idempotency_key, created_by)
  values (p_org_id, p_deal_id, v_version, v_kind, (p_revision->>'totalMinor')::bigint, nullif(btrim(coalesce(p_revision->>'reason', '')), ''),
          coalesce(p_revision->'changes', '[]'::jsonb), v_key, v_by);

  for v_end in select value from jsonb_array_elements(coalesce(p_revision->'end', '[]'::jsonb)) loop
    update public.deal_lines l
       set status = v_end->>'status', ended_in = v_version
     where l.org_id = p_org_id and l.deal_id = p_deal_id and l.id = (v_end->>'id')::uuid and l.status = 'planned';
    get diagnostics v_count = row_count;
    if v_count = 0 then
      raise exception 'deal_line_not_planned';
    end if;
  end loop;

  insert into public.deal_lines (org_id, deal_id, added_in, position, kind, label, invoice_on, due_on, amount_minor, rounding_minor, replaces)
  select p_org_id, p_deal_id, v_version, (l->>'position')::integer, l->>'kind', btrim(l->>'label'), (l->>'invoiceOn')::date, (l->>'dueOn')::date,
         (l->>'amountMinor')::bigint, 0, nullif(l->>'replaces', '')::uuid
    from jsonb_array_elements(coalesce(p_revision->'add', '[]'::jsonb)) as l;

  update public.deals d
     set current_version = v_version,
         total_minor = (p_revision->>'totalMinor')::bigint,
         status = case v_kind when 'cancelled' then 'cancelled' when 'reopened' then 'active' else d.status end,
         updated_at = now()
   where d.org_id = p_org_id and d.id = p_deal_id;

  return jsonb_build_object('version', v_version, 'created', true);
end;
$$;

revoke execute on function public.revise_deal(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.revise_deal(uuid, uuid, integer, jsonb) to service_role;
grant execute on function public.revise_deal(uuid, uuid, integer, jsonb) to vestiarion_tenant;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.revise_deal(uuid, uuid, integer, jsonb);
-- drop function if exists public.create_deal(uuid, jsonb, jsonb);
-- drop trigger if exists invoices_deal_line_released on public.invoices;
-- drop function if exists public.invoices_deal_line_released();
-- drop trigger if exists invoices_deal_link_fixed on public.invoices;
-- drop function if exists public.invoices_deal_link_fixed();
-- drop index if exists public.invoices_deal_line_key;
-- alter table public.invoices drop constraint if exists invoices_deal_receivable, drop constraint if exists invoices_deal_pair,
--   drop constraint if exists invoices_deal_line_fkey;
-- alter table public.invoices drop column if exists deal_line_id, drop column if exists deal_id;
-- drop table if exists public.deal_lines;
-- drop table if exists public.deal_versions;
-- drop table if exists public.deals;
-- drop function if exists public.deal_sums_hold();
-- drop function if exists public.deal_lines_guard();
