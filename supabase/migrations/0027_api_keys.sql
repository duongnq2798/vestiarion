-- API keys: each workspace reads its own data over /api/v1
-- (docs/superpowers/specs/2026-09-29-api-keys-design.md, §4, K1, K2, K4, K7).
--
-- api_keys is a platform table, like orgs and memberships (0015): RLS is on,
-- no policy exists for any browser or tenant role, and only the service role
-- reads or writes it. The key itself is never stored — only its public prefix
-- and the SHA-256 of its secret, as hex.
--
-- A key belongs to its workspace (K4): it goes with the organization, and
-- outlives its creator's account (created_by becomes null).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  name         text not null constraint api_keys_name_check check (char_length(btrim(name)) between 1 and 60),
  prefix       text not null constraint api_keys_prefix_key unique
                            constraint api_keys_prefix_check check (prefix ~ '^[a-z2-7]{8}$'),
  secret_hash  text not null constraint api_keys_secret_hash_check check (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes       text[] not null default '{read}'
                      constraint api_keys_scopes_check check (scopes <@ array['read']::text[] and cardinality(scopes) > 0),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists api_keys_org_idx on public.api_keys (org_id);

alter table public.api_keys enable row level security;
revoke all privileges on table public.api_keys from anon, authenticated;
grant all privileges on table public.api_keys to service_role;

-- Creates a key, holding each organization to 20 active (unrevoked) keys (K7).
-- The advisory lock serialises creation per organization, so two requests
-- cannot both pass the count (the create_org and invite_member reasoning).
create or replace function public.create_api_key(
  p_org_id      uuid,
  p_name        text,
  p_prefix      text,
  p_secret_hash text,
  p_scopes      text[],
  p_by          uuid
) returns public.api_keys
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active int;
  v_row    public.api_keys;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_api_keys:' || p_org_id::text));

  select count(*) into v_active from public.api_keys
   where org_id = p_org_id and revoked_at is null;
  if v_active >= 20 then
    raise exception 'api_key_limit_reached: at most 20 active API keys per organization';
  end if;

  insert into public.api_keys (org_id, name, prefix, secret_hash, scopes, created_by)
  values (p_org_id, btrim(p_name), p_prefix, p_secret_hash, p_scopes, p_by)
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.create_api_key(uuid, text, text, text, text[], uuid) from public, anon, authenticated;
grant execute on function public.create_api_key(uuid, text, text, text, text[], uuid) to service_role;

-- Rollback:
-- drop function if exists public.create_api_key(uuid, text, text, text, text[], uuid);
-- drop table if exists public.api_keys;
