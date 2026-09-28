-- Members and invitations (spec §7, §10 step 5b).
--
-- memberships and invitations are platform tables: the tenant role has no
-- privileges on them (0015), so every change goes through one of these
-- functions, which the server calls as the service role and tells who is
-- acting. Each re-reads that person's role inside its own transaction and
-- refuses what the role may not do. This is where "no one grants a role
-- above their own" is enforced:
--   owner  — may grant or change any role;
--   admin  — may grant or change approver and viewer only;
--   others — may do neither.
-- Leaving (removing yourself) is open to every member; the last-owner trigger
-- from 0020 still refuses the last owner.
--
-- security definer: org_members and the address checks read auth.users,
-- which the service role cannot read on Supabase. search_path stays ''.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create index if not exists invitations_org_idx on public.invitations (org_id);
create unique index if not exists invitations_open_address_idx
  on public.invitations (org_id, email) where accepted_at is null;

create or replace function public.role_rank(p_role text) returns int
language sql immutable
set search_path = ''
as $$
  select case p_role when 'owner' then 4 when 'admin' then 3 when 'approver' then 2 when 'viewer' then 1 end
$$;

-- Mirrors canAssignRole in src/lib/auth/roles.ts.
create or replace function public.can_assign_role(p_actor_role text, p_target_role text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_actor_role = 'owner' then true
    when p_actor_role = 'admin' then public.role_rank(p_target_role) < public.role_rank('admin')
    else false
  end
$$;

create or replace function public.member_role(p_org_id uuid, p_user_id uuid) returns text
language sql stable
security definer
set search_path = ''
as $$
  select role from public.memberships where org_id = p_org_id and user_id = p_user_id
$$;

create or replace function public.invite_member(
  p_org_id      uuid,
  p_actor       uuid,
  p_email       text,
  p_role        text,
  p_token_hash  text
) returns public.invitations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text := public.member_role(p_org_id, p_actor);
  v_email      text := lower(btrim(p_email));
  v_open       int;
  v_row        public.invitations;
begin
  if v_actor_role is null then
    raise exception 'not_a_member: the inviting person is not a member of this organization';
  end if;
  if not public.can_assign_role(v_actor_role, p_role) then
    raise exception 'role_not_assignable: a % cannot invite a %', v_actor_role, p_role;
  end if;
  if v_email !~ '^[^@\s<>"'']+@[^@\s<>"'']+\.[^@\s<>"'']+$' or length(v_email) > 254 then
    raise exception 'invalid_email: not an email address';
  end if;
  if exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
     where m.org_id = p_org_id and lower(u.email) = v_email
  ) then
    raise exception 'already_a_member: that address already belongs to a member';
  end if;

  -- Serialise invitations per organization so two requests cannot both pass
  -- the limit (the same reasoning as create_org in 0020).
  perform pg_advisory_xact_lock(hashtext('vestiarion_invite:' || p_org_id::text));
  delete from public.invitations where org_id = p_org_id and email = v_email and accepted_at is null;
  select count(*) into v_open from public.invitations
   where org_id = p_org_id and accepted_at is null and expires_at > now();
  if v_open >= 20 then
    raise exception 'invitation_limit_reached: at most 20 open invitations per organization';
  end if;

  insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
  values (p_org_id, v_email, p_role, p_token_hash, p_actor, now() + interval '7 days')
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.accept_invitation(p_token_hash text, p_user_id uuid)
returns table (org_id uuid, slug text, role text, invitation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv   public.invitations;
  v_email text;
begin
  select * into v_inv from public.invitations i where i.token_hash = p_token_hash for update;
  if not found then
    raise exception 'invitation_not_found: no invitation matches this link';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'invitation_used: this invitation has already been accepted';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invitation_expired: this invitation has expired';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user_id;
  if v_email is distinct from v_inv.email then
    raise exception 'invitation_email_mismatch: this invitation was sent to a different address';
  end if;
  if not public.can_assign_role(public.member_role(v_inv.org_id, v_inv.invited_by), v_inv.role) then
    raise exception 'invitation_no_longer_valid: the inviter can no longer grant this role';
  end if;
  if public.member_role(v_inv.org_id, p_user_id) is not null then
    raise exception 'already_a_member: you are already a member of this organization';
  end if;

  insert into public.memberships (org_id, user_id, role, invited_by)
  values (v_inv.org_id, p_user_id, v_inv.role, v_inv.invited_by);
  update public.invitations set accepted_at = now() where id = v_inv.id;

  return query
    select o.id, o.slug, v_inv.role, v_inv.id from public.orgs o where o.id = v_inv.org_id;
end;
$$;

create or replace function public.change_member_role(
  p_org_id  uuid,
  p_actor   uuid,
  p_user_id uuid,
  p_role    text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role  text := public.member_role(p_org_id, p_actor);
  v_target_role text := public.member_role(p_org_id, p_user_id);
begin
  if v_actor_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_target_role is null then
    raise exception 'member_not_found: that person is not a member of this organization';
  end if;
  -- Both ends: an admin may not raise someone to admin, nor touch an admin or owner.
  if not (public.can_assign_role(v_actor_role, v_target_role) and public.can_assign_role(v_actor_role, p_role)) then
    raise exception 'role_not_assignable: a % cannot change a % to %', v_actor_role, v_target_role, p_role;
  end if;
  update public.memberships set role = p_role where org_id = p_org_id and user_id = p_user_id;
  return v_target_role;
end;
$$;

create or replace function public.remove_member(p_org_id uuid, p_actor uuid, p_user_id uuid) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role  text := public.member_role(p_org_id, p_actor);
  v_target_role text := public.member_role(p_org_id, p_user_id);
begin
  if v_actor_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_target_role is null then
    raise exception 'member_not_found: that person is not a member of this organization';
  end if;
  if p_actor <> p_user_id and not public.can_assign_role(v_actor_role, v_target_role) then
    raise exception 'role_not_assignable: a % cannot remove a %', v_actor_role, v_target_role;
  end if;
  delete from public.memberships where org_id = p_org_id and user_id = p_user_id;
  return v_target_role;
end;
$$;

create or replace function public.revoke_invitation(p_org_id uuid, p_actor uuid, p_invitation_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text := public.member_role(p_org_id, p_actor);
  v_role       text;
begin
  if v_actor_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  select i.role into v_role from public.invitations i
   where i.id = p_invitation_id and i.org_id = p_org_id and i.accepted_at is null;
  if not found then
    raise exception 'invitation_not_found: no open invitation with that id';
  end if;
  if not public.can_assign_role(v_actor_role, v_role) then
    raise exception 'role_not_assignable: a % cannot revoke an invitation for a %', v_actor_role, v_role;
  end if;
  delete from public.invitations where id = p_invitation_id;
end;
$$;

create or replace function public.org_members(p_org_id uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql stable
security definer
set search_path = ''
as $$
  select m.user_id, u.email::text, m.role, m.created_at
    from public.memberships m join auth.users u on u.id = m.user_id
   where m.org_id = p_org_id
   order by public.role_rank(m.role) desc, u.email
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.role_rank(text)',
    'public.can_assign_role(text, text)',
    'public.member_role(uuid, uuid)',
    'public.invite_member(uuid, uuid, text, text, text)',
    'public.accept_invitation(text, uuid)',
    'public.change_member_role(uuid, uuid, uuid, text)',
    'public.remove_member(uuid, uuid, uuid)',
    'public.revoke_invitation(uuid, uuid, uuid)',
    'public.org_members(uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Rollback:
-- drop function if exists public.org_members(uuid), public.revoke_invitation(uuid, uuid, uuid),
--   public.remove_member(uuid, uuid, uuid), public.change_member_role(uuid, uuid, uuid, text),
--   public.accept_invitation(text, uuid), public.invite_member(uuid, uuid, text, text, text),
--   public.member_role(uuid, uuid), public.can_assign_role(text, text), public.role_rank(text);
-- drop index if exists public.invitations_open_address_idx, public.invitations_org_idx;
