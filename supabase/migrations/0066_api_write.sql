-- The write API (docs/superpowers/specs/2026-10-03-write-api-design.md §4): a workspace API key may also write, and a
-- write's outcome is kept for its Idempotency-Key. Re-runnable, as every migration here: db:migrate applies them all in
-- order.

-- 1. A key reads, or reads and writes; never writes alone (R1). Replaces 0027's read-only check.
alter table public.api_keys drop constraint if exists api_keys_scopes_check;
alter table public.api_keys add constraint api_keys_scopes_check
  check (scopes <@ array['read', 'write']::text[] and 'read' = any(scopes));

-- 2. One outcome per Idempotency-Key in a workspace (R5): claimed with no status while the request runs, then the
-- status and the body a repeat is answered with. A platform table, like api_keys: RLS on, no policy, service role only.
create table if not exists public.api_idempotency (
  org_id           uuid not null references public.orgs(id) on delete cascade,
  idempotency_key  text not null constraint api_idempotency_key_check check (char_length(idempotency_key) between 1 and 255),
  request_hash     text not null constraint api_idempotency_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  status           integer,
  response         jsonb,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  constraint api_idempotency_pkey primary key (org_id, idempotency_key)
);

alter table public.api_idempotency enable row level security;
revoke all privileges on table public.api_idempotency from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.api_idempotency to service_role;

-- Rollback:
-- drop table if exists public.api_idempotency;
-- alter table public.api_keys drop constraint if exists api_keys_scopes_check;
-- alter table public.api_keys add constraint api_keys_scopes_check check (scopes <@ array['read']::text[] and cardinality(scopes) > 0);
