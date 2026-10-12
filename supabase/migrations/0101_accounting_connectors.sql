-- Accounting connectors (docs/superpowers/specs/2026-10-12-xero-connector-design.md X2, X5, X7): a workspace's
-- connection to an accounting provider (Xero now, QuickBooks Online next), its tokens, the links from the provider's
-- objects to the workspace's own rows, the bills waiting for a person, and where each sync stopped.
--
-- accounting_connections: one per workspace, provider and external organisation; at most one not revoked per
-- workspace and provider. Its status, the consent the person agreed to, the last sync and the last error in business
-- words, the backoff (failures in a row, the next time a sync may start), a sync lease so two runs never read the same
-- connection at once, and the account payments will be booked to. Disconnecting marks it revoked and keeps it.
--
-- accounting_tokens: a platform table, as slack_installs (0067): the access and refresh tokens, only as envelopes
-- under the platform master key bound to the workspace, the column and the row; their expiry and scopes; a version and
-- a refresh lease, so two refreshes never race (the provider rotates its refresh token on every use, and a lost update
-- would lock the connection out); and, while a person picks among several organisations, the ones offered and a
-- deadline. Row-level security on and no policy: the tenant role and the browser roles reach none of it.
--
-- external_links: an external object (provider, organisation, type, id), once, and the local row it became (a
-- counterparty for a contact, an invoice for a bill), once per organisation and type, with the provider's version.
-- local_id has no foreign key: it points at one of two tables by its type.
--
-- accounting_bills: the bills read from a provider, once each, with their facts as the provider has them now, what the
-- provider says of them (source_status), and what a person did (review_state).
--
-- accounting_sync_cursors: per connection and object type, the phase, the time read from, and the checkpoint of a run
-- under way (the next page and the latest change read), so a run stopped by a rate limit or an outage resumes there.
--
-- The tenant role reads, inserts and updates the four tenant tables of its own workspace, and deletes none. Composite
-- foreign keys keep every row in its connection's workspace, and everything goes with the workspace.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.accounting_connections (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs(id) on delete cascade,
  provider            text not null constraint accounting_connections_provider_check check (provider in ('xero', 'quickbooks')),
  external_org_id     text not null constraint accounting_connections_external_org_id_check check (char_length(external_org_id) between 1 and 100),
  external_org_name   text constraint accounting_connections_external_org_name_check check (external_org_name is null or char_length(external_org_name) between 1 and 200),
  status              text not null default 'connected'
                        constraint accounting_connections_status_check check (status in ('connected', 'needs_reconnect', 'revoked')),
  scopes              text[] not null default '{}',
  connected_by        uuid references auth.users(id) on delete set null,
  connected_at        timestamptz not null default now(),
  consent_version     text not null constraint accounting_connections_consent_version_check check (char_length(consent_version) between 1 and 40),
  consented_at        timestamptz not null,
  revoked_at          timestamptz,
  revoked_by          uuid references auth.users(id) on delete set null,
  -- Bills due or dated before this day are not brought in (X9).
  window_from         date not null,
  last_synced_at      timestamptz,
  last_error          text constraint accounting_connections_last_error_check check (last_error is null or char_length(last_error) between 1 and 300),
  last_error_at       timestamptz,
  failures            integer not null default 0 constraint accounting_connections_failures_check check (failures >= 0),
  next_sync_after     timestamptz,
  sync_lease_until    timestamptz,
  -- Where payments made on Arc will be booked: the provider's account id, code, name and currency (I14).
  payment_account     jsonb constraint accounting_connections_payment_account_check
                        check (payment_account is null or (jsonb_typeof(payment_account) = 'object' and octet_length(payment_account::text) <= 2000)),
  payment_account_by  uuid references auth.users(id) on delete set null,
  payment_account_at  timestamptz,
  created_at          timestamptz not null default now(),
  constraint accounting_connections_org_id_key unique (org_id, id),
  constraint accounting_connections_external_key unique (org_id, provider, external_org_id),
  constraint accounting_connections_revoked_check check ((status = 'revoked') = (revoked_at is not null))
);

create unique index if not exists accounting_connections_one_active
  on public.accounting_connections (org_id, provider) where status <> 'revoked';

create table if not exists public.accounting_tokens (
  -- Made by the application, so each envelope can be bound to its row before the row exists.
  id                 uuid primary key,
  org_id             uuid not null references public.orgs(id) on delete cascade,
  provider           text not null constraint accounting_tokens_provider_check check (provider in ('xero', 'quickbooks')),
  connection_id      uuid,
  authorized_by      uuid references auth.users(id) on delete cascade,
  access_token_enc   jsonb not null,
  refresh_token_enc  jsonb not null,
  access_expires_at  timestamptz not null,
  scopes             text[] not null default '{}',
  version            bigint not null default 1,
  refreshed_at       timestamptz not null default now(),
  lease_holder       uuid,
  lease_until        timestamptz,
  -- While a person picks one of several organisations: the ones offered, and until when.
  choices            jsonb,
  choose_until       timestamptz,
  created_at         timestamptz not null default now(),
  constraint accounting_tokens_connection_key unique (connection_id),
  constraint accounting_tokens_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade,
  constraint accounting_tokens_pending_check check ((connection_id is null) = (choose_until is not null))
);

create table if not exists public.external_links (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  connection_id        uuid not null,
  provider             text not null constraint external_links_provider_check check (provider in ('xero', 'quickbooks')),
  external_org_id      text not null constraint external_links_external_org_id_check check (char_length(external_org_id) between 1 and 100),
  object_type          text not null constraint external_links_object_type_check check (object_type in ('contact', 'bill')),
  external_id          text not null constraint external_links_external_id_check check (char_length(external_id) between 1 and 100),
  local_id             uuid,
  external_version     text constraint external_links_external_version_check check (external_version is null or char_length(external_version) between 1 and 64),
  external_updated_at  timestamptz,
  label                text constraint external_links_label_check check (label is null or char_length(label) between 1 and 200),
  linked_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint external_links_external_key unique (org_id, provider, external_org_id, object_type, external_id),
  constraint external_links_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade,
  constraint external_links_linked_check check ((local_id is null) = (linked_at is null))
);

create unique index if not exists external_links_local_key
  on public.external_links (org_id, provider, external_org_id, object_type, local_id) where local_id is not null;

create table if not exists public.accounting_bills (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  connection_id        uuid not null,
  external_id          text not null constraint accounting_bills_external_id_check check (char_length(external_id) between 1 and 100),
  contact_external_id  text constraint accounting_bills_contact_external_id_check check (contact_external_id is null or char_length(contact_external_id) between 1 and 100),
  contact_name         text not null constraint accounting_bills_contact_name_check check (char_length(contact_name) between 1 and 200),
  number               text constraint accounting_bills_number_check check (number is null or char_length(number) between 1 and 255),
  reference            text constraint accounting_bills_reference_check check (reference is null or char_length(reference) between 1 and 255),
  currency             text not null constraint accounting_bills_currency_check check (currency ~ '^[A-Z]{3}$'),
  total                numeric(24, 6) not null,
  amount_due           numeric(24, 6) not null,
  issued_on            date,
  due_on               date,
  -- What the provider says of the bill now: open (approved, with an amount due), paid, voided, deleted, or back in draft.
  source_status        text not null constraint accounting_bills_source_status_check check (source_status in ('open', 'paid', 'voided', 'deleted', 'draft')),
  -- What a person did with it: still to review, added as a payable, or dismissed.
  review_state         text not null default 'review' constraint accounting_bills_review_state_check check (review_state in ('review', 'added', 'dismissed')),
  external_version     text constraint accounting_bills_external_version_check check (external_version is null or char_length(external_version) between 1 and 64),
  external_updated_at  timestamptz,
  first_seen_at        timestamptz not null default now(),
  changed_at           timestamptz not null default now(),
  decided_by           uuid references auth.users(id) on delete set null,
  decided_at           timestamptz,
  constraint accounting_bills_org_id_key unique (org_id, id),
  constraint accounting_bills_external_key unique (org_id, connection_id, external_id),
  constraint accounting_bills_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade
);

create index if not exists accounting_bills_review_idx on public.accounting_bills (org_id, review_state, source_status);

create table if not exists public.accounting_sync_cursors (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  connection_id        uuid not null,
  object_type          text not null constraint accounting_sync_cursors_object_type_check check (object_type in ('contact', 'bill')),
  phase                text not null default 'backfill' constraint accounting_sync_cursors_phase_check check (phase in ('backfill', 'incremental')),
  -- Incremental: changes since this time (If-Modified-Since).
  since                timestamptz,
  -- The run under way: the next page to read, and the latest change read so far. Null when none is under way.
  page                 integer constraint accounting_sync_cursors_page_check check (page is null or page >= 1),
  high_water           timestamptz,
  run_started_at       timestamptz,
  -- Whether the run under way read a change made during it: then a run of several pages reads again from page 1,
  -- since a row may have moved up into a page already read.
  changed_in_run       boolean not null default false,
  backfill_started_at  timestamptz,
  completed_at         timestamptz,
  updated_at           timestamptz not null default now(),
  constraint accounting_sync_cursors_key unique (org_id, connection_id, object_type),
  constraint accounting_sync_cursors_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade
);

-- The four tenant tables: their own workspace's rows, read, inserted and updated by the tenant role, never deleted.
do $$
declare
  t text;
begin
  foreach t in array array['accounting_connections', 'external_links', 'accounting_bills', 'accounting_sync_cursors'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from anon, authenticated, vestiarion_tenant', t);
    execute format('grant select, insert, update on table public.%I to vestiarion_tenant', t);
    execute format('grant all privileges on table public.%I to service_role', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I for all to vestiarion_tenant using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))',
      t
    );
    execute format('drop policy if exists tenant_isolation_guard on public.%I', t);
    execute format(
      'create policy tenant_isolation_guard on public.%I as restrictive for all to vestiarion_tenant using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))',
      t
    );
  end loop;
end $$;

-- The tokens: the service role's alone.
alter table public.accounting_tokens enable row level security;
revoke all privileges on table public.accounting_tokens from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.accounting_tokens to service_role;

-- Takes the refresh lease of a connected token row for p_seconds, when no one holds it or the last lease ran out, and
-- returns the row as it is now: whoever holds the lease reads the tokens another holder may have just stored. No row
-- otherwise. Under the row's lock, so two callers never both take it.
create or replace function public.accounting_token_lease(p_org_id uuid, p_token_id uuid, p_holder uuid, p_seconds integer)
returns setof public.accounting_tokens
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    update public.accounting_tokens t
       set lease_holder = p_holder,
           lease_until = now() + make_interval(secs => greatest(p_seconds, 0))
     where t.id = p_token_id
       and t.org_id = p_org_id
       and t.connection_id is not null
       and (t.lease_until is null or t.lease_until <= now())
    returning t.*;
end;
$$;

-- Stores a refreshed pair, only for the lease's holder and only over the version it read: a compare-and-set that
-- bumps the version and frees the lease. Null when either changed, and then nothing is written.
create or replace function public.accounting_token_store(
  p_org_id uuid, p_token_id uuid, p_holder uuid, p_version bigint,
  p_access_enc jsonb, p_refresh_enc jsonb, p_access_expires_at timestamptz, p_scopes text[]
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
begin
  update public.accounting_tokens t
     set access_token_enc = p_access_enc,
         refresh_token_enc = p_refresh_enc,
         access_expires_at = p_access_expires_at,
         scopes = coalesce(p_scopes, t.scopes),
         version = t.version + 1,
         refreshed_at = now(),
         lease_holder = null,
         lease_until = null
   where t.id = p_token_id
     and t.org_id = p_org_id
     and t.lease_holder = p_holder
     and t.version = p_version
  returning t.version into v_version;
  return v_version;
end;
$$;

-- Lets a lease go without storing anything: the refresh failed, or another holder had refreshed already.
create or replace function public.accounting_token_release(p_org_id uuid, p_token_id uuid, p_holder uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.accounting_tokens t
     set lease_holder = null, lease_until = null
   where t.id = p_token_id and t.org_id = p_org_id and t.lease_holder = p_holder;
end;
$$;

-- The connections the sweeper syncs now, across every workspace: connected, past their next sync, and not leased by a
-- run under way; the longest unsynced first.
create or replace function public.accounting_connections_due(p_limit integer)
returns table (org_id uuid, connection_id uuid, provider text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.org_id, c.id, c.provider
    from public.accounting_connections c
   where c.status = 'connected'
     and (c.next_sync_after is null or c.next_sync_after <= now())
     and (c.sync_lease_until is null or c.sync_lease_until <= now())
   order by c.last_synced_at nulls first, c.connected_at
   limit greatest(least(p_limit, 500), 0);
$$;

revoke execute on function public.accounting_token_lease(uuid, uuid, uuid, integer) from public, anon, authenticated, vestiarion_tenant;
revoke execute on function public.accounting_token_store(uuid, uuid, uuid, bigint, jsonb, jsonb, timestamptz, text[]) from public, anon, authenticated, vestiarion_tenant;
revoke execute on function public.accounting_token_release(uuid, uuid, uuid) from public, anon, authenticated, vestiarion_tenant;
revoke execute on function public.accounting_connections_due(integer) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.accounting_token_lease(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.accounting_token_store(uuid, uuid, uuid, bigint, jsonb, jsonb, timestamptz, text[]) to service_role;
grant execute on function public.accounting_token_release(uuid, uuid, uuid) to service_role;
grant execute on function public.accounting_connections_due(integer) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.accounting_connections_due(integer);
-- drop function if exists public.accounting_token_release(uuid, uuid, uuid);
-- drop function if exists public.accounting_token_store(uuid, uuid, uuid, bigint, jsonb, jsonb, timestamptz, text[]);
-- drop function if exists public.accounting_token_lease(uuid, uuid, uuid, integer);
-- drop table if exists public.accounting_sync_cursors;
-- drop table if exists public.accounting_bills;
-- drop table if exists public.external_links;
-- drop table if exists public.accounting_tokens;
-- drop table if exists public.accounting_connections;
