-- Row-level security that actually applies (spec §5.6, Line 2 as built).
--
-- Every tenant request runs as vestiarion_tenant, with a server-minted token
-- whose org_id claim PostgREST puts in request.jwt.claims. The browser roles
-- keep no privileges, as since 0003; only this role gets any, and every policy
-- is written for it. The service role bypasses RLS and is untouched, so code
-- that still uses it works exactly as before.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vestiarion_tenant') then
    create role vestiarion_tenant nologin noinherit;
  end if;
end $$;

-- PostgREST connects as authenticator and switches to the role a valid token names.
grant vestiarion_tenant to authenticator;
grant usage on schema public to vestiarion_tenant;

-- append_ledger_entry() calls digest(), which on Supabase lives in the
-- extensions schema; only anon/authenticated/service_role have USAGE there by
-- default, so without this the tenant role could not append to the ledger.
-- PGlite has no such schema out of the box, hence the existence check.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    grant usage on schema extensions to vestiarion_tenant;
  end if;
end $$;

-- Matches the statement_timeout already set for `authenticated` on the project.
alter role vestiarion_tenant set statement_timeout = '8s';

-- The organization the request's token names; null when it names none. A
-- custom role cannot use the auth schema on Supabase, so this reads the same
-- setting auth.jwt() does.
create or replace function public.request_org_id() returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id', '')::uuid;
$$;

revoke execute on function public.request_org_id() from public, anon, authenticated;
grant execute on function public.request_org_id() to vestiarion_tenant;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'counterparties', 'invoices', 'milestones', 'treasury_actions', 'compliance_checks',
    'forecasts', 'ledger_entries', 'payment_intents', 'cycle_runs', 'cycle_snapshots', 'sim_clock'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from vestiarion_tenant', t);
    -- History is append-only for tenants: the ledger and the cycle snapshots
    -- can be read and added to, never rewritten.
    if t in ('ledger_entries', 'cycle_snapshots') then
      execute format('grant select, insert on table public.%I to vestiarion_tenant', t);
    else
      execute format('grant select, insert, update, delete on table public.%I to vestiarion_tenant', t);
    end if;
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I for all to vestiarion_tenant '
      'using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))',
      t
    );
    -- Belt and suspenders: a permissive policy is OR-combined with every other
    -- permissive policy on the table, so a stray permissive policy added later
    -- (by mistake, or by a migration that forgets `to vestiarion_tenant`) could
    -- silently widen what a tenant sees. A RESTRICTIVE policy is AND-combined
    -- instead, so it holds the boundary regardless of what else gets added.
    execute format('drop policy if exists tenant_isolation_guard on public.%I', t);
    execute format(
      'create policy tenant_isolation_guard on public.%I as restrictive for all to vestiarion_tenant '
      'using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))',
      t
    );
  end loop;
end $$;

grant execute on function public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text) to vestiarion_tenant;
grant execute on function public.advance_sim_day(uuid) to vestiarion_tenant;
grant execute on function public.claim_payment_intent(uuid, text) to vestiarion_tenant;
grant execute on function public.ledger_entries_for_targets(uuid, text[], text[]) to vestiarion_tenant;

-- Rollback (the app must be using the service role again first):
-- do $$ declare t text; begin foreach t in array array['accounts','counterparties','invoices','milestones',
--   'treasury_actions','compliance_checks','forecasts','ledger_entries','payment_intents','cycle_runs',
--   'cycle_snapshots','sim_clock'] loop
--   execute format('drop policy if exists tenant_isolation_guard on public.%I', t);
--   execute format('drop policy if exists tenant_isolation on public.%I', t);
--   execute format('revoke all privileges on table public.%I from vestiarion_tenant', t); end loop; end $$;
-- revoke execute on all functions in schema public from vestiarion_tenant;
-- do $$ begin if exists (select 1 from pg_namespace where nspname = 'extensions') then
--   revoke usage on schema extensions from vestiarion_tenant; end if; end $$;
-- revoke usage on schema public from vestiarion_tenant;
-- alter role vestiarion_tenant reset statement_timeout;
-- revoke vestiarion_tenant from authenticator;
-- drop role vestiarion_tenant;
