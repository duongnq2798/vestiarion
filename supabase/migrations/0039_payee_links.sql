-- Payee links (docs/superpowers/specs/2026-09-30-payee-links-design.md).
--
-- A one-time link an owner or admin sends a payee, so the payee enters their
-- own Arc address without an account. The address then waits for a member's
-- confirmation like any other change (R1): nothing here moves money.
--
-- payee_links is a platform table like api_keys (0027): RLS on, no policy for
-- any browser or tenant role, and only the service role reads or writes it,
-- through the definer functions below and the service-role client. The token
-- is never stored, only the SHA-256 of its secret, as hex.
--
-- A link works once (claim is a compare-and-set on used_at), expires, and a
-- new link for a payee revokes the payee's unused one (R2).
--
-- 0038 is taken by an open branch; this file does not depend on it.
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.payee_links (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  counterparty_id uuid not null,
  token_hash      text not null
                       constraint payee_links_token_hash_key unique
                       constraint payee_links_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  revoked_at      timestamptz,
  constraint payee_links_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

create index if not exists payee_links_counterparty_idx on public.payee_links (org_id, counterparty_id);

alter table public.payee_links enable row level security;
revoke all privileges on table public.payee_links from anon, authenticated;
grant all privileges on table public.payee_links to service_role;

-- Creates a link for a counterparty of the workspace, revoking the payee's
-- unused ones first. The advisory lock serialises creation per payee, so two
-- requests cannot leave two usable links.
create or replace function public.create_payee_link(
  p_org_id          uuid,
  p_counterparty_id uuid,
  p_token_hash      text,
  p_by              uuid,
  p_expires_at      timestamptz
) returns public.payee_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.payee_links;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_payee_links:' || p_counterparty_id::text));
  if not exists (select 1 from public.counterparties where org_id = p_org_id and id = p_counterparty_id) then
    raise exception 'counterparty_not_found: no such counterparty in this workspace';
  end if;
  update public.payee_links set revoked_at = now()
   where org_id = p_org_id and counterparty_id = p_counterparty_id and used_at is null and revoked_at is null;
  insert into public.payee_links (org_id, counterparty_id, token_hash, created_by, expires_at)
  values (p_org_id, p_counterparty_id, p_token_hash, p_by, p_expires_at)
  returning * into v_row;
  return v_row;
end;
$$;

-- What the payee's page may show for a usable link; no row for any other.
create or replace function public.payee_link_preview(p_token_hash text)
returns table (org_name text, counterparty_name text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name, c.name, l.expires_at
    from public.payee_links l
    join public.orgs o on o.id = l.org_id
    join public.counterparties c on c.org_id = l.org_id and c.id = l.counterparty_id
   where l.token_hash = p_token_hash
     and l.used_at is null and l.revoked_at is null and l.expires_at > now()
$$;

-- Uses a usable link, once: no row for a link that is used, revoked, expired
-- or unknown, so two submissions of one token cannot both change an address.
create or replace function public.claim_payee_link(p_token_hash text)
returns table (link_id uuid, org_id uuid, counterparty_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.payee_links l
     set used_at = now()
   where l.token_hash = p_token_hash
     and l.used_at is null and l.revoked_at is null and l.expires_at > now()
  returning l.id, l.org_id, l.counterparty_id
$$;

-- Puts a claimed link back after its submission failed, so the payee can retry.
create or replace function public.release_payee_link(p_link_id uuid) returns void
language sql
security definer
set search_path = ''
as $$
  update public.payee_links set used_at = null where id = p_link_id and used_at is not null and revoked_at is null
$$;

-- Revokes an unused link of the workspace; whether it did.
create or replace function public.revoke_payee_link(p_org_id uuid, p_link_id uuid, p_by uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  update public.payee_links set revoked_at = now()
   where id = p_link_id and org_id = p_org_id and used_at is null and revoked_at is null;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

revoke execute on function public.create_payee_link(uuid, uuid, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.create_payee_link(uuid, uuid, text, uuid, timestamptz) to service_role;
revoke execute on function public.payee_link_preview(text) from public, anon, authenticated;
grant execute on function public.payee_link_preview(text) to service_role;
revoke execute on function public.claim_payee_link(text) from public, anon, authenticated;
grant execute on function public.claim_payee_link(text) to service_role;
revoke execute on function public.release_payee_link(uuid) from public, anon, authenticated;
grant execute on function public.release_payee_link(uuid) to service_role;
revoke execute on function public.revoke_payee_link(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_payee_link(uuid, uuid, uuid) to service_role;

-- Rollback:
-- drop function if exists public.revoke_payee_link(uuid, uuid, uuid);
-- drop function if exists public.release_payee_link(uuid);
-- drop function if exists public.claim_payee_link(text);
-- drop function if exists public.payee_link_preview(text);
-- drop function if exists public.create_payee_link(uuid, uuid, text, uuid, timestamptz);
-- drop table if exists public.payee_links;
