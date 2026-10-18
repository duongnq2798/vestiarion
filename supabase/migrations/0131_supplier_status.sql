-- A supplier's own page of when it is paid, by a link (docs/superpowers/specs/2026-10-18-supplier-status-design.md).
--
-- supplier_status_links: one link a member made for one supplier (a vendor counterparty) to see its own
-- bills and where each stands, kept only as the SHA-256 of its secret, with when it expires (at most about 90 days after
-- it was made). One link per supplier is live at a time: making a new one stops the old one first. Stopping sets
-- revoked_at, once; the row is kept, never deleted. The tenant role reads links, adds one with what a new link needs
-- (never created_at, which bounds its expiry), and may set revoked_at and revoked_by alone.
--
-- supplier_status_by_token: the public page's lookup, the service role's alone. A stopped or unknown link is null; an
-- expired one answers only that it expired, and when. The page is read only: nothing here takes a write from the link.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. It redefines no earlier
-- migration's object.

create table if not exists public.supplier_status_links (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  counterparty_id  uuid not null,
  token_hash       text not null
                        constraint supplier_status_links_token_hash_key unique
                        constraint supplier_status_links_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users(id) on delete set null,
  constraint supplier_status_links_org_id_key unique (org_id, id),
  constraint supplier_status_links_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '91 days'),
  constraint supplier_status_links_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

-- One live link per supplier: an expired link still counts until it is stopped, which making a new one does.
create unique index if not exists supplier_status_links_one_live on public.supplier_status_links (org_id, counterparty_id) where revoked_at is null;

-- A link is for a supplier: a vendor counterparty of the same workspace. Never a client, which has a statement link, and
-- never a contractor, paid by milestones, which follows its payments through its payee link.
create or replace function public.supplier_status_links_supplier()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.counterparties c
     where c.org_id = new.org_id and c.id = new.counterparty_id and c.role = 'vendor'
  ) then
    raise exception 'supplier_status_not_supplier: a payment status link is made for a vendor';
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_status_links_supplier on public.supplier_status_links;
create trigger supplier_status_links_supplier before insert on public.supplier_status_links
  for each row execute function public.supplier_status_links_supplier();

-- A stopped link stays stopped: once revoked_at is set, neither it nor who stopped it changes.
create or replace function public.supplier_status_links_revoke_once()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by) then
    raise exception 'supplier_status_link_revoked: this payment status link was stopped already';
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_status_links_revoke_once on public.supplier_status_links;
create trigger supplier_status_links_revoke_once before update on public.supplier_status_links
  for each row execute function public.supplier_status_links_revoke_once();

alter table public.supplier_status_links enable row level security;

revoke all privileges on table public.supplier_status_links from anon, authenticated, vestiarion_tenant;

grant select on table public.supplier_status_links to vestiarion_tenant;
-- What a new link needs, and no more: created_at keeps its default, so the expiry check bounds the link from now.
grant insert (org_id, counterparty_id, token_hash, created_by, expires_at) on table public.supplier_status_links to vestiarion_tenant;
grant update (revoked_at, revoked_by) on table public.supplier_status_links to vestiarion_tenant;

-- The trigger functions run as triggers only: no browser role may call them.
revoke all on function public.supplier_status_links_supplier() from public, anon, authenticated;
revoke all on function public.supplier_status_links_revoke_once() from public, anon, authenticated;

grant all privileges on table public.supplier_status_links to service_role;

drop policy if exists tenant_isolation on public.supplier_status_links;
create policy tenant_isolation on public.supplier_status_links for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.supplier_status_links;
create policy tenant_isolation_guard on public.supplier_status_links as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- The public page's lookup: a live link's supplier and workspace, nothing else of the workspace. A stopped or unknown
-- link answers null, and so does one whose workspace or supplier was deleted (the link went with it). An expired link
-- answers only that it expired, and when: no name.
create or replace function public.supplier_status_by_token(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when l.expires_at <= now() then jsonb_build_object('expired', true, 'expiresAt', l.expires_at)
           else jsonb_build_object(
                  'expired', false,
                  'linkId', l.id,
                  'orgId', l.org_id,
                  'counterpartyId', l.counterparty_id,
                  'expiresAt', l.expires_at,
                  'orgName', o.name,
                  'supplierName', c.name,
                  'mode', o.mode,
                  'network', o.network)
         end
    from public.supplier_status_links l
    join public.orgs o on o.id = l.org_id
    join public.counterparties c on c.org_id = l.org_id and c.id = l.counterparty_id
   where l.token_hash = p_token_hash
     and l.revoked_at is null
$$;

revoke all on function public.supplier_status_by_token(text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.supplier_status_by_token(text) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.supplier_status_by_token(text);
-- drop table if exists public.supplier_status_links;
-- drop function if exists public.supplier_status_links_supplier();
-- drop function if exists public.supplier_status_links_revoke_once();
