-- Vestiarion schema.
--
-- Two things differ deliberately from a naive port of the prototype's SQLite
-- schema:
--
--  1. Money is `numeric(20,6)`, never a float. USDC has 6 decimals; binary
--     floating point cannot represent 0.1 exactly and a treasury that
--     accumulates rounding error is worse than useless.
--
--  2. The ledger's hash chain is built inside `append_ledger_entry` under a
--     transaction-scoped advisory lock, so two concurrent agent cycles
--     cannot both read the same `prev_hash` and fork the chain. The caller
--     signs the entry *body* (which it can do without knowing its position
--     in the chain); the database then links that signed body into the
--     chain. Tamper-evidence and authorship are therefore independent.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- accounts
create table if not exists accounts (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  kind             text not null check (kind in ('operating', 'reserve', 'chain')),
  chain            text not null,
  token            text not null default 'USDC',
  address          text,
  circle_wallet_id text,
  balance          numeric(20, 6) not null default 0,
  apy              numeric(6, 4) not null default 0,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------- counterparties
create table if not exists counterparties (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  role              text not null check (role in ('vendor', 'client', 'contractor')),
  address           text,
  chain             text,
  risk_level        text not null default 'unscreened'
                      check (risk_level in ('unscreened', 'clear', 'medium', 'high')),
  risk_notes        text,
  payment_limit     numeric(20, 6),
  last_screened_at  timestamptz,
  performance_score numeric(4, 3) not null default 0.850,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------- invoices
create table if not exists invoices (
  id               uuid primary key default gen_random_uuid(),
  direction        text not null check (direction in ('payable', 'receivable')),
  counterparty_id  uuid not null references counterparties(id) on delete cascade,
  amount           numeric(20, 6) not null check (amount > 0),
  currency         text not null default 'USDC',
  memo             text,
  po_reference     text,
  goods_received   boolean not null default false,
  due_date         timestamptz not null,
  status           text not null default 'pending'
                     check (status in ('pending', 'matched', 'paid', 'held',
                                       'flagged', 'awaiting_info', 'received', 'rejected')),
  match_confidence numeric(4, 3),
  agent_reasoning  text,
  decided_at       timestamptz,
  settled_at       timestamptz,
  tx_ref           text,
  created_at       timestamptz not null default now()
);

create index if not exists invoices_open_idx
  on invoices (direction, status) where status in ('pending', 'matched');

-- -------------------------------------------------------------- milestones
create table if not exists milestones (
  id                  uuid primary key default gen_random_uuid(),
  contractor_id       uuid not null references counterparties(id) on delete cascade,
  title               text not null,
  amount              numeric(20, 6) not null check (amount > 0),
  verification_source text,
  verified            boolean not null default false,
  status              text not null default 'pending'
                        check (status in ('pending', 'verified', 'paid', 'held')),
  agent_reasoning     text,
  decided_at          timestamptz,
  settled_at          timestamptz,
  tx_ref              text,
  created_at          timestamptz not null default now()
);

-- -------------------------------------------------------- treasury actions
create table if not exists treasury_actions (
  id           uuid primary key default gen_random_uuid(),
  action       text not null check (action in ('sweep_to_usyc', 'redeem_from_usyc', 'rebalance')),
  amount       numeric(20, 6) not null,
  from_account uuid references accounts(id) on delete set null,
  to_account   uuid references accounts(id) on delete set null,
  reasoning    text,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------- compliance checks
create table if not exists compliance_checks (
  id              uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references counterparties(id) on delete cascade,
  risk_level      text not null,
  source          text not null,
  notes           text,
  created_at      timestamptz not null default now()
);

-- --------------------------------------------------------------- forecasts
create table if not exists forecasts (
  id                uuid primary key default gen_random_uuid(),
  as_of             timestamptz not null,
  horizon_days      integer not null,
  projected_inflow  numeric(20, 6) not null,
  projected_outflow numeric(20, 6) not null,
  liquid_balance    numeric(20, 6) not null,
  recommendation    text,
  created_at        timestamptz not null default now()
);

-- ------------------------------------------------------------------ ledger
create table if not exists ledger_entries (
  seq          bigint generated always as identity primary key,
  id           uuid not null unique default gen_random_uuid(),
  ts           timestamptz not null default now(),
  actor        text not null check (actor in ('agent', 'human', 'system')),
  domain       text not null,
  action       text not null,
  summary      text not null,
  detail       jsonb not null default '{}'::jsonb,
  body_hash    text not null,   -- sha256 of the canonical entry body
  signature    text not null,   -- Ed25519 over body_hash, produced by the agent
  prev_hash    text not null,
  hash         text not null    -- sha256(prev_hash || body_hash || signature)
);

-- --------------------------------------------------------------- sim clock
create table if not exists sim_clock (
  id          integer primary key default 1 check (id = 1),
  current_day integer not null default 0
);
insert into sim_clock (id, current_day) values (1, 0) on conflict (id) do nothing;

-- ------------------------------------------------------------------- rpc's
-- Appends one entry and links it into the hash chain atomically. The
-- advisory lock is transaction-scoped, so concurrent callers serialise here
-- instead of racing on `prev_hash`.
create or replace function append_ledger_entry(
  p_actor     text,
  p_domain    text,
  p_action    text,
  p_summary   text,
  p_detail    jsonb,
  p_body_hash text,
  p_signature text
) returns ledger_entries
language plpgsql
as $$
declare
  v_prev_hash text;
  v_hash      text;
  v_row       ledger_entries;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_ledger'));

  select hash into v_prev_hash from ledger_entries order by seq desc limit 1;
  v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));

  v_hash := encode(digest(v_prev_hash || p_body_hash || p_signature, 'sha256'), 'hex');

  insert into ledger_entries (actor, domain, action, summary, detail,
                              body_hash, signature, prev_hash, hash)
  values (p_actor, p_domain, p_action, p_summary, coalesce(p_detail, '{}'::jsonb),
          p_body_hash, p_signature, v_prev_hash, v_hash)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function advance_sim_day() returns integer
language sql
as $$
  update sim_clock set current_day = current_day + 1 where id = 1
  returning current_day;
$$;

-- --------------------------------------------------------------------- rls
-- This is a single-tenant demo operated by its owner through the server-side
-- service role. Read access is public so judges can inspect state; all
-- writes go through the service role, which bypasses RLS.
alter table accounts          enable row level security;
alter table counterparties    enable row level security;
alter table invoices          enable row level security;
alter table milestones        enable row level security;
alter table treasury_actions  enable row level security;
alter table compliance_checks enable row level security;
alter table forecasts         enable row level security;
alter table ledger_entries    enable row level security;
alter table sim_clock         enable row level security;

do $$
declare
  t text;
  policy_name text;
begin
  foreach t in array array['accounts', 'counterparties', 'invoices', 'milestones',
                           'treasury_actions', 'compliance_checks', 'forecasts',
                           'ledger_entries', 'sim_clock']
  loop
    policy_name := t || '_public_read';
    execute format('drop policy if exists %I on %I', policy_name, t);
    execute format('create policy %I on %I for select using (true)', policy_name, t);
  end loop;
end $$;
