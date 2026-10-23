-- An accountant's client invite links (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md AC1-AC5): an
-- accountant sends a client one link, and the client opens their own workspace with the accountant already in it as
-- accountant. Re-runnable, as every migration here: db:migrate applies them all in order.
--
-- accountant_client_links: a platform table, like invitations (0021) and discord_webhooks (0140). RLS is on, no policy
-- exists for any browser or tenant role, and only the service role reads or writes it. A link belongs to no workspace
-- until it is used, so it is the accountant's: it goes with their account. Only the link's SHA-256 is kept. Making and
-- revoking a link is signed nowhere, since no workspace exists yet: the row keeps who made it and when it was made, used
-- or revoked.
--
-- create_client_link(p_actor, p_email, p_token_hash): only someone who is an accountant in at least one workspace, at
-- most 10 open and 20 made a day per accountant (revoked ones counted), under a lock per accountant. One-time, for 7
-- days, bound to an address when one is given.
-- revoke_client_link(p_actor, p_link_id): the accountant's own open link only.
-- client_link_preview(p_token_hash): what the client's page shows. The accountant and the bound address for an open link
-- only; an expired, used or revoked one names nothing.
-- claim_client_link(p_token_hash, p_user_id, p_org_id): run once the client's workspace exists (createWorkspace, through
-- create_org, unchanged). Checks the link is open, unexpired and, if bound, bound to the client's address, that the
-- client created and owns p_org_id, and that the accountant is not the client; then, in one transaction, adds the
-- accountant with the role accountant (never a parameter), marks the link used and records the workspace's first touch
-- as utm_campaign accountant_client, which growth_workspaces (0099) already reads.
-- add_live_slice_accountant(p_from_org_id, p_org_id, p_actor, p_user_id): going live keeps the accountant (AC4). An
-- owner of both workspaces adds an accountant of the shadow workspace to the live slice's, as accountant. p_org_id must
-- be that slice: on Arc mainnet, made by the actor within the hour, from a workspace on Arc testnet, and holding no one
-- but the actor and accountants already brought along, so no other workspace of theirs takes an accountant this way.
--
-- No view and no function of an earlier migration is redefined.

create table if not exists public.accountant_client_links (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null references auth.users (id) on delete cascade,
  -- The client's address the link is bound to, lowercased; null for a link anyone signed in may use.
  email       text constraint accountant_client_links_email_check
                   check (email is null or (email = lower(email) and char_length(email) <= 254
                                            and email ~ '^[^@\s<>"'']+@[^@\s<>"'']+\.[^@\s<>"'']+$')),
  token_hash  text not null
                   constraint accountant_client_links_token_hash_key unique
                   constraint accountant_client_links_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  -- The workspace it opened; null once that workspace is deleted, the link still used.
  org_id      uuid references public.orgs (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint accountant_client_links_expiry_check check (expires_at > created_at),
  constraint accountant_client_links_state_check check (used_at is null or revoked_at is null),
  constraint accountant_client_links_org_check check (org_id is null or used_at is not null)
);

create index if not exists accountant_client_links_created_by_idx on public.accountant_client_links (created_by, created_at desc);
create index if not exists accountant_client_links_org_idx on public.accountant_client_links (org_id) where org_id is not null;

alter table public.accountant_client_links enable row level security;
revoke all privileges on table public.accountant_client_links from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.accountant_client_links to service_role;

create or replace function public.create_client_link(p_actor uuid, p_email text, p_token_hash text)
returns public.accountant_client_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_today int;
  v_open  int;
  v_row   public.accountant_client_links;
begin
  if not exists (select 1 from public.memberships m where m.user_id = p_actor and m.role = 'accountant') then
    raise exception 'not_an_accountant: only an accountant in a workspace makes client links';
  end if;
  if v_email is not null and (v_email !~ '^[^@\s<>"'']+@[^@\s<>"'']+\.[^@\s<>"'']+$' or length(v_email) > 254) then
    raise exception 'invalid_email: not an email address';
  end if;

  -- One accountant's links are made one at a time, so two requests cannot both pass a limit (as invite_member, 0021).
  perform pg_advisory_xact_lock(hashtext('vestiarion_client_links:' || p_actor::text));
  select count(*) into v_today from public.accountant_client_links l
   where l.created_by = p_actor and l.created_at > now() - interval '1 day';
  if v_today >= 20 then
    raise exception 'client_link_rate_limited: at most 20 client links per accountant per day';
  end if;
  select count(*) into v_open from public.accountant_client_links l
   where l.created_by = p_actor and l.used_at is null and l.revoked_at is null and l.expires_at > now();
  if v_open >= 10 then
    raise exception 'client_link_limit_reached: at most 10 open client links per accountant';
  end if;

  insert into public.accountant_client_links (created_by, email, token_hash, expires_at)
  values (p_actor, v_email, p_token_hash, now() + interval '7 days')
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.revoke_client_link(p_actor uuid, p_link_id uuid)
returns public.accountant_client_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.accountant_client_links;
begin
  update public.accountant_client_links l set revoked_at = now()
   where l.id = p_link_id and l.created_by = p_actor and l.used_at is null and l.revoked_at is null and l.expires_at > now()
  returning * into v_row;
  if not found then
    raise exception 'client_link_not_found: no open client link of yours matches';
  end if;
  return v_row;
end;
$$;

create or replace function public.client_link_preview(p_token_hash text)
returns table (link_id uuid, state text, accountant_id uuid, accountant_email text, bound_email text, token_hash text)
language sql
stable
security definer
set search_path = ''
as $$
  with link as (
    select l.id, l.created_by, l.email, l.token_hash,
           case when l.revoked_at is not null then 'revoked'
                when l.used_at is not null then 'used'
                when l.expires_at <= now() then 'expired'
                else 'open' end as state
      from public.accountant_client_links l
     where l.token_hash = p_token_hash
  )
  select case when k.state = 'open' then k.id end,
         k.state,
         case when k.state = 'open' then k.created_by end,
         case when k.state = 'open' then lower(u.email) end,
         case when k.state = 'open' then k.email end,
         k.token_hash
    from link k
    left join auth.users u on u.id = k.created_by
$$;

create or replace function public.claim_client_link(p_token_hash text, p_user_id uuid, p_org_id uuid)
returns table (link_id uuid, accountant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link  public.accountant_client_links;
  v_email text;
begin
  select * into v_link from public.accountant_client_links l where l.token_hash = p_token_hash for update;
  -- A revoked link reads as an unknown one, as a withdrawn invitation does.
  if not found or v_link.revoked_at is not null then
    raise exception 'client_link_not_found: no client link matches';
  end if;
  if v_link.used_at is not null then
    raise exception 'client_link_used: this client link has been used';
  end if;
  if v_link.expires_at <= now() then
    raise exception 'client_link_expired: this client link has expired';
  end if;
  if v_link.created_by = p_user_id then
    raise exception 'own_client_link: an accountant cannot use their own client link';
  end if;
  if v_link.email is not null then
    select lower(u.email) into v_email from auth.users u where u.id = p_user_id;
    if v_email is distinct from v_link.email then
      raise exception 'client_link_email_mismatch: this client link was made for a different address';
    end if;
  end if;
  -- Only a workspace the client made and owns: never one where they are only a member.
  if not exists (select 1 from public.orgs o where o.id = p_org_id and o.created_by = p_user_id)
     or public.member_role(p_org_id, p_user_id) is distinct from 'owner' then
    raise exception 'not_owner: only the owner who created the workspace can add their accountant this way';
  end if;
  if public.member_role(p_org_id, v_link.created_by) is not null then
    raise exception 'already_a_member: the accountant is already a member of this workspace';
  end if;

  insert into public.memberships (org_id, user_id, role, invited_by) values (p_org_id, v_link.created_by, 'accountant', p_user_id);
  update public.accountant_client_links l set used_at = now(), org_id = p_org_id where l.id = v_link.id;
  -- The workspace's first touch, written once (as record_org_attribution): the accountant's link brought it.
  insert into public.org_attribution (org_id, utm_source, utm_medium, utm_campaign)
  values (p_org_id, 'accountant', 'client_link', 'accountant_client')
  on conflict on constraint org_attribution_pkey do nothing;
  return query select v_link.id, v_link.created_by;
end;
$$;

create or replace function public.add_live_slice_accountant(p_from_org_id uuid, p_org_id uuid, p_actor uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.member_role(p_from_org_id, p_actor) is distinct from 'owner' or public.member_role(p_org_id, p_actor) is distinct from 'owner' then
    raise exception 'not_owner: only an owner of both workspaces brings an accountant along';
  end if;
  -- Only into the live slice just opened from the shadow workspace: one on Arc mainnet the actor made (create_org) within
  -- the hour, from one on Arc testnet, with no one in it yet but them and accountants brought along from the shadow
  -- workspace. Never an older workspace of theirs, one someone else made, or one anyone else has joined.
  if not exists (select 1 from public.orgs o where o.id = p_from_org_id and o.network = 'arc-testnet')
     or not exists (select 1 from public.orgs o
                     where o.id = p_org_id and o.created_by = p_actor and o.network = 'arc-mainnet'
                       and o.created_at > now() - interval '1 hour')
     or exists (select 1 from public.memberships m
                 where m.org_id = p_org_id and m.user_id <> p_actor
                   and (m.role <> 'accountant' or public.member_role(p_from_org_id, m.user_id) is distinct from 'accountant')) then
    raise exception 'not_live_slice: that workspace is not the live slice just opened from the shadow workspace';
  end if;
  if public.member_role(p_from_org_id, p_user_id) is distinct from 'accountant' then
    raise exception 'not_an_accountant: that person is not an accountant of the shadow workspace';
  end if;
  if public.member_role(p_org_id, p_user_id) is not null then
    raise exception 'already_a_member: that person is already a member of the new workspace';
  end if;
  insert into public.memberships (org_id, user_id, role, invited_by) values (p_org_id, p_user_id, 'accountant', p_actor);
  return true;
end;
$$;

revoke execute on function public.create_client_link(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_client_link(uuid, text, text) to service_role;
revoke execute on function public.revoke_client_link(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_client_link(uuid, uuid) to service_role;
revoke execute on function public.client_link_preview(text) from public, anon, authenticated;
grant execute on function public.client_link_preview(text) to service_role;
revoke execute on function public.claim_client_link(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_client_link(text, uuid, uuid) to service_role;
revoke execute on function public.add_live_slice_accountant(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_live_slice_accountant(uuid, uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.add_live_slice_accountant(uuid, uuid, uuid, uuid);
-- drop function if exists public.claim_client_link(text, uuid, uuid);
-- drop function if exists public.client_link_preview(text);
-- drop function if exists public.revoke_client_link(uuid, uuid);
-- drop function if exists public.create_client_link(uuid, text, text);
-- drop table if exists public.accountant_client_links;
