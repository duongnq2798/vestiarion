-- Phase 7 records measured execution and per-cycle history. Existing payment
-- rows stay null rather than being backfilled with estimates presented as
-- measurements.

alter table public.payment_intents
  add column if not exists chain text,
  add column if not exists provider_mode text
    check (provider_mode is null or provider_mode in ('live', 'simulate')),
  add column if not exists fee_usd numeric(20, 6)
    check (fee_usd is null or fee_usd >= 0),
  add column if not exists fee_source text
    check (fee_source is null or fee_source in ('chain_reported', 'provider_estimate', 'simulated_profile')),
  add column if not exists settled_in_ms bigint
    check (settled_in_ms is null or settled_in_ms >= 0),
  add column if not exists executed_at timestamptz;

create table if not exists public.cycle_runs (
  id                       uuid primary key default gen_random_uuid(),
  started_at               timestamptz not null,
  finished_at              timestamptz not null,
  duration_ms              bigint not null check (duration_ms >= 0),
  clock_mode               text not null check (clock_mode in ('real', 'simulate')),
  sim_day                  integer,
  decision_count           integer not null check (decision_count >= 0),
  paid_count               integer not null default 0 check (paid_count >= 0),
  held_count               integer not null default 0 check (held_count >= 0),
  flagged_count            integer not null default 0 check (flagged_count >= 0),
  awaiting_info_count      integer not null default 0 check (awaiting_info_count >= 0),
  released_count           integer not null default 0 check (released_count >= 0),
  model_decision_count     integer not null default 0 check (model_decision_count >= 0),
  heuristic_decision_count integer not null default 0 check (heuristic_decision_count >= 0),
  guardrail_override_count integer not null default 0 check (guardrail_override_count >= 0),
  chain_mode               text not null check (chain_mode in ('live', 'simulate')),
  screening_mode           text not null check (screening_mode in ('live', 'simulate')),
  created_at               timestamptz not null default now()
);

create table if not exists public.cycle_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  cycle_run_id        uuid not null unique references public.cycle_runs(id) on delete restrict,
  captured_at         timestamptz not null,
  sim_day             integer,
  account_balances    jsonb not null,
  total_liquid        numeric(20, 6) not null,
  open_payables       numeric(20, 6) not null,
  open_receivables    numeric(20, 6) not null,
  obligations_due_7d  numeric(20, 6) not null,
  obligations_due_14d numeric(20, 6) not null,
  reserve_position    numeric(20, 6) not null,
  chain_mode          text not null check (chain_mode in ('live', 'simulate')),
  created_at          timestamptz not null default now()
);

create index if not exists cycle_runs_finished_idx on public.cycle_runs (finished_at desc);
create index if not exists cycle_snapshots_captured_idx on public.cycle_snapshots (captured_at desc);

create or replace function public.reject_cycle_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'cycle_snapshots are append-only';
end;
$$;

drop trigger if exists cycle_snapshots_append_only on public.cycle_snapshots;
create trigger cycle_snapshots_append_only
before update or delete on public.cycle_snapshots
for each row execute function public.reject_cycle_snapshot_mutation();

alter table public.cycle_runs enable row level security;
alter table public.cycle_snapshots enable row level security;
revoke all privileges on table public.cycle_runs, public.cycle_snapshots from anon, authenticated;
grant all privileges on table public.cycle_runs, public.cycle_snapshots to service_role;
revoke execute on function public.reject_cycle_snapshot_mutation() from public, anon, authenticated;
grant execute on function public.reject_cycle_snapshot_mutation() to service_role;
