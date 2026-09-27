-- Organizations, memberships, invitations — and a tenant on every row.
--
-- Everything that exists today becomes the founding organization. Its ledger
-- chain is not touched: org_id is a new column outside both hashes, so every
-- entry verifies byte for byte as before.
--
-- The backfill uses ADD COLUMN ... NOT NULL DEFAULT, never UPDATE. Postgres
-- fills existing rows from the default without running an UPDATE, which
-- matters because cycle_snapshots rejects every UPDATE by trigger.
--
-- TRANSITIONAL: each org_id keeps defaulting to the founding organization so
-- that code which does not yet know about organizations keeps writing correct
-- rows. Plan 2 of the identity-and-tenancy work drops these defaults once
-- every write names its organization explicitly.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.orgs (
  id                        uuid primary key default gen_random_uuid(),
  slug                      text not null unique
                              check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  name                      text not null,
  mode                      text not null default 'sandbox' check (mode in ('sandbox', 'live')),
  created_by                uuid references auth.users(id),
  created_at                timestamptz not null default now(),
  last_active_at            timestamptz not null default now(),
  ledger_signing_key_enc    jsonb,
  circle_api_key_enc        jsonb,
  circle_entity_secret_enc  jsonb,
  settings                  jsonb not null default '{}'::jsonb
);

create table if not exists public.memberships (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'approver', 'viewer')),
  invited_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships (user_id);

create table if not exists public.invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  email        text not null,
  role         text not null check (role in ('owner', 'admin', 'approver', 'viewer')),
  token_hash   text not null unique,
  invited_by   uuid not null references auth.users(id),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

insert into public.orgs (id, slug, name, mode)
values ('00000000-0000-4000-8000-000000000001', 'founding', 'Vestiarion workspace', 'live')
on conflict (id) do nothing;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'counterparties', 'invoices', 'milestones', 'treasury_actions', 'compliance_checks',
    'forecasts', 'ledger_entries', 'payment_intents', 'cycle_runs', 'cycle_snapshots'
  ]
  loop
    execute format(
      'alter table public.%I add column if not exists org_id uuid not null '
      'default ''00000000-0000-4000-8000-000000000001'' references public.orgs(id) on delete restrict',
      t
    );
    execute format('create index if not exists %I on public.%I (org_id)', t || '_org_idx', t);
  end loop;
end $$;

alter table public.invoices   add column if not exists created_by uuid references auth.users(id);
alter table public.milestones add column if not exists created_by uuid references auth.users(id);

-- Same posture as 0003: the browser roles get nothing; the server's service
-- role does. Plan 2 adds policies that let `authenticated` see its own
-- organization and nothing else.
do $$
declare
  t text;
begin
  foreach t in array array['orgs', 'memberships', 'invitations']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from anon, authenticated', t);
    execute format('grant all privileges on table public.%I to service_role', t);
  end loop;
end $$;

-- Rollback (loses every organization, membership and invitation):
-- do $$ declare t text; begin
--   foreach t in array array['accounts','counterparties','invoices','milestones','treasury_actions',
--     'compliance_checks','forecasts','ledger_entries','payment_intents','cycle_runs','cycle_snapshots']
--   loop execute format('alter table public.%I drop column if exists org_id', t); end loop; end $$;
-- alter table public.invoices drop column if exists created_by;
-- alter table public.milestones drop column if exists created_by;
-- drop table if exists public.invitations, public.memberships, public.orgs;
