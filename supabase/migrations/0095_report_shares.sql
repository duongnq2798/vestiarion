-- A report the business can share (docs/superpowers/specs/2026-10-10-shared-report-design.md S2, S5, S9, S12).
--
-- report_shares: one public link to the workspace report, kept only as the SHA-256 of its secret (as payment_receipts,
-- 0046), with what the shared page shows: supplier names or labels, amounts or not, the workspace's name or a neutral
-- title. Stopping a share sets revoked_at, once; the row is kept, never deleted. The tenant role reads and adds shares
-- and may set revoked_at and revoked_by alone: it can never change a link's hash or what it shows, nor clear a
-- revocation.
--
-- report_baselines: an owner's answers about how one bill was handled before Vestiarion (minutes, and people who
-- touched it). Append-only for the tenant role; the newest answer is read.
--
-- report_share_by_token: the public page's lookup of a live link, the service role's alone. It returns the share, its
-- workspace's id, mode and network, and the workspace's name only when the share shows it.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. It redefines no earlier
-- migration's object.

create table if not exists public.report_shares (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs(id) on delete cascade,
  token_hash          text not null
                           constraint report_shares_token_hash_key unique
                           constraint report_shares_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  show_names          boolean not null default false,
  show_amounts        boolean not null default true,
  show_workspace_name boolean not null default true,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  revoked_at          timestamptz,
  revoked_by          uuid references auth.users(id) on delete set null
);

create index if not exists report_shares_org_live on public.report_shares (org_id) where revoked_at is null;

-- A revocation stands: once revoked_at is set, neither it nor who revoked changes.
create or replace function public.report_shares_revoke_once()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by) then
    raise exception 'report_share_revoked: this shared report was stopped already';
  end if;
  return new;
end;
$$;

drop trigger if exists report_shares_revoke_once on public.report_shares;
create trigger report_shares_revoke_once before update on public.report_shares
  for each row execute function public.report_shares_revoke_once();

alter table public.report_shares enable row level security;
revoke all privileges on table public.report_shares from anon, authenticated, vestiarion_tenant;
grant select, insert on table public.report_shares to vestiarion_tenant;
grant update (revoked_at, revoked_by) on table public.report_shares to vestiarion_tenant;
grant all privileges on table public.report_shares to service_role;

drop policy if exists tenant_isolation on public.report_shares;
create policy tenant_isolation on public.report_shares for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.report_shares;
create policy tenant_isolation_guard on public.report_shares as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create table if not exists public.report_baselines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  minutes_per_bill integer not null constraint report_baselines_minutes_check check (minutes_per_bill between 1 and 6000),
  people_per_bill  integer not null constraint report_baselines_people_check check (people_per_bill between 1 and 100),
  answered_by      uuid references auth.users(id) on delete set null,
  answered_at      timestamptz not null default now()
);

create index if not exists report_baselines_org_answered on public.report_baselines (org_id, answered_at desc);

alter table public.report_baselines enable row level security;
revoke all privileges on table public.report_baselines from anon, authenticated, vestiarion_tenant;
grant select, insert on table public.report_baselines to vestiarion_tenant;
grant all privileges on table public.report_baselines to service_role;

drop policy if exists tenant_isolation on public.report_baselines;
create policy tenant_isolation on public.report_baselines for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.report_baselines;
create policy tenant_isolation_guard on public.report_baselines as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- The public page's lookup (S5): a live link's share and the workspace it reads, nothing else of the workspace. A
-- revoked or unknown link answers null, and so does one whose workspace was deleted (the share went with it).
create or replace function public.report_share_by_token(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'shareId', s.id,
           'orgId', s.org_id,
           'createdAt', s.created_at,
           'showNames', s.show_names,
           'showAmounts', s.show_amounts,
           'showWorkspaceName', s.show_workspace_name,
           'name', case when s.show_workspace_name then o.name end,
           'mode', o.mode,
           'network', o.network)
    from public.report_shares s
    join public.orgs o on o.id = s.org_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
$$;

revoke all on function public.report_share_by_token(text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.report_share_by_token(text) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.report_share_by_token(text);
-- drop table if exists public.report_baselines;
-- drop table if exists public.report_shares;
-- drop function if exists public.report_shares_revoke_once();
