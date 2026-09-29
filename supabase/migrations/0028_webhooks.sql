-- Webhooks: each new ledger entry of a workspace, delivered signed to the
-- HTTPS endpoints it registers
-- (docs/superpowers/specs/2026-09-29-webhooks-design.md, §3, W2, W5, W7).
--
-- webhook_endpoints and webhook_deliveries are platform tables, like api_keys
-- (0027): RLS is on, no policy exists for any browser or tenant role, and only
-- the service role reads or writes them. The endpoint's signing secret is an
-- envelope under the platform master key, bound to the organization and the
-- endpoint id, like orgs.*_enc.
--
-- An endpoint belongs to its workspace: it goes with the organization, and
-- outlives its creator's account (created_by becomes null). A delivery goes
-- with its endpoint, its organization and its ledger entry, so
-- delete_sandbox_org (0022) keeps working unchanged.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.webhook_endpoints (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  url                  text not null constraint webhook_endpoints_url_check
                                     check (url ~ '^https://' and char_length(url) <= 500),
  secret_enc           jsonb not null,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  disabled_at          timestamptz,
  removed_at           timestamptz,
  consecutive_failures int not null default 0,
  last_success_at      timestamptz,
  last_failure_at      timestamptz
);

create index if not exists webhook_endpoints_org_idx on public.webhook_endpoints (org_id);

-- id is the event id (W4): the same on every retry of the delivery.
create table if not exists public.webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  endpoint_id     uuid not null references public.webhook_endpoints(id) on delete cascade,
  ledger_entry_id uuid references public.ledger_entries(id) on delete cascade,
  event_type      text not null constraint webhook_deliveries_event_type_check
                                check (event_type in ('ledger.appended', 'webhook.test')),
  status          text not null default 'pending' constraint webhook_deliveries_status_check
                                check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  last_status     int,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);

create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (status, next_attempt_at);
create index if not exists webhook_deliveries_endpoint_idx on public.webhook_deliveries (endpoint_id);
-- The ledger entry cascade looks deliveries up by entry.
create index if not exists webhook_deliveries_ledger_entry_idx on public.webhook_deliveries (ledger_entry_id);

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;
revoke all privileges on table public.webhook_endpoints, public.webhook_deliveries from anon, authenticated;
grant all privileges on table public.webhook_endpoints, public.webhook_deliveries to service_role;

-- W2: every ledger entry enqueues one delivery per active endpoint of its
-- organization, in the append's own transaction. Security definer, because
-- the tenant role appends and holds no privilege on webhook_deliveries. The
-- exception block rolls back only its own subtransaction and raises a
-- warning, so enqueueing can never fail a ledger append.
create or replace function public.enqueue_webhook_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.webhook_deliveries (org_id, endpoint_id, ledger_entry_id, event_type)
    select new.org_id, e.id, new.id, 'ledger.appended'
      from public.webhook_endpoints e
     where e.org_id = new.org_id and e.removed_at is null and e.disabled_at is null;
  exception when others then
    raise warning 'webhook enqueue failed: %', sqlerrm;
  end;
  return new;
end;
$$;

-- Trigger functions fire regardless of EXECUTE privilege; this only keeps
-- every other role from calling it directly.
revoke execute on function public.enqueue_webhook_deliveries() from public, anon, authenticated;

drop trigger if exists ledger_entries_enqueue_webhooks on public.ledger_entries;
create trigger ledger_entries_enqueue_webhooks
  after insert on public.ledger_entries
  for each row execute function public.enqueue_webhook_deliveries();

-- Creates an endpoint, holding each organization to 5 active (neither removed
-- nor disabled) endpoints (W7). The caller supplies the id, because the
-- secret's envelope is bound to it before the insert (create_org's p_org_id
-- reasoning). The advisory lock serialises creation per organization, so two
-- requests cannot both pass the count.
create or replace function public.create_webhook_endpoint(
  p_id         uuid,
  p_org_id     uuid,
  p_url        text,
  p_secret_enc jsonb,
  p_by         uuid
) returns public.webhook_endpoints
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active int;
  v_row    public.webhook_endpoints;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_webhook_endpoints:' || p_org_id::text));

  select count(*) into v_active from public.webhook_endpoints
   where org_id = p_org_id and removed_at is null and disabled_at is null;
  if v_active >= 5 then
    raise exception 'webhook_limit_reached: at most 5 active webhook endpoints per organization';
  end if;

  insert into public.webhook_endpoints (id, org_id, url, secret_enc, created_by)
  values (p_id, p_org_id, p_url, p_secret_enc, p_by)
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.create_webhook_endpoint(uuid, uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_webhook_endpoint(uuid, uuid, text, jsonb, uuid) to service_role;

-- Moves up to p_limit due deliveries into `sending` and returns them, oldest
-- due first. Due means pending with next_attempt_at reached, or sending with a
-- claim more than 5 minutes old or no claim at all (a dispatch run that
-- crashed, or a row written as sending by hand). SKIP LOCKED lets two
-- overlapping runs claim disjoint rows.
--
-- Taking over a `sending` row counts one attempt: the run that held it may
-- have sent it before it died, and a run that dies on the same row every time
-- must still reach the attempt limit instead of looping forever. A pending
-- row keeps its count; the dispatcher counts the attempt it makes.
--
-- p_only, when given, restricts the claim to that one delivery, still only
-- while it is due: a test event is inserted pending and claimed by id, so it
-- is never written as `sending` without a claim.
--
-- The one-argument form is dropped first, so a database that ran an earlier
-- draft of this file is left with one function, not an ambiguous overload.
drop function if exists public.claim_webhook_deliveries(int);

create or replace function public.claim_webhook_deliveries(p_limit int, p_only uuid default null)
returns setof public.webhook_deliveries
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select d.id
      from public.webhook_deliveries d
     where (p_only is null or d.id = p_only)
       and ((d.status = 'pending' and d.next_attempt_at <= now())
         or (d.status = 'sending' and (d.claimed_at is null or d.claimed_at < now() - interval '5 minutes')))
     order by d.next_attempt_at, d.created_at, d.id
     limit greatest(coalesce(p_limit, 0), 0)
     for update skip locked
  ), claimed as (
    update public.webhook_deliveries d
       set status = 'sending',
           claimed_at = now(),
           attempts = d.attempts + case when d.status = 'sending' then 1 else 0 end
      from due
     where d.id = due.id
    returning d.*
  )
  select * from claimed
   order by claimed.next_attempt_at, claimed.created_at, claimed.id;
end;
$$;

revoke execute on function public.claim_webhook_deliveries(int, uuid) from public, anon, authenticated;
grant execute on function public.claim_webhook_deliveries(int, uuid) to service_role;

-- Counts one failed attempt against an endpoint and returns its new
-- consecutive failure count, or null for an unknown endpoint. At
-- p_disable_after the endpoint is disabled (the first disabled_at is kept)
-- and its pending deliveries are failed (W5). Plain UPDATEs, never SELECT …
-- FOR UPDATE: an update of these non-key columns does not conflict with the
-- key-share lock a ledger append's enqueue takes on the endpoint through the
-- foreign key, so recording a failure never blocks an append. A success is
-- recorded by the dispatcher with an ordinary update (consecutive_failures = 0).
create or replace function public.record_webhook_failure(p_endpoint_id uuid, p_disable_after int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.webhook_endpoints
     set consecutive_failures = consecutive_failures + 1,
         last_failure_at = now()
   where id = p_endpoint_id
  returning consecutive_failures into v_count;

  if v_count is not null and v_count >= p_disable_after then
    update public.webhook_endpoints
       set disabled_at = coalesce(disabled_at, now())
     where id = p_endpoint_id;
    update public.webhook_deliveries
       set status = 'failed', last_error = 'endpoint disabled'
     where endpoint_id = p_endpoint_id and status = 'pending';
  end if;

  return v_count;
end;
$$;

revoke execute on function public.record_webhook_failure(uuid, int) from public, anon, authenticated;
grant execute on function public.record_webhook_failure(uuid, int) to service_role;

-- Rollback:
-- drop trigger if exists ledger_entries_enqueue_webhooks on public.ledger_entries;
-- drop function if exists public.enqueue_webhook_deliveries();
-- drop function if exists public.record_webhook_failure(uuid, int);
-- drop function if exists public.claim_webhook_deliveries(int, uuid);
-- drop function if exists public.create_webhook_endpoint(uuid, uuid, text, jsonb, uuid);
-- drop table if exists public.webhook_deliveries;
-- drop table if exists public.webhook_endpoints;
