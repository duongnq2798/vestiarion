-- Pending invitations reachable from /onboarding (part of the fix for an
-- invited person returning to their invitation after signing in).
--
-- The vx_after_sign_in cookie (src/lib/auth/after-sign-in.ts) covers the same
-- browser. It cannot cover another device, another browser, a mail app's own
-- browser, or a person who simply comes back later — so /onboarding lists
-- their open invitations itself and lets them accept from there.
--
-- security definer, search_path = '': same reasoning as 0021 — reading
-- auth.users needs it, since the service role cannot read that table
-- directly on Supabase.
--
-- Every check that decides whether an invitation may be accepted (open,
-- unexpired, address match, inviter still able to grant the role, not
-- already a member) stays inside accept_invitation (0021).
-- accept_invitation_by_id only resolves an id to the token hash that
-- function already expects, so the two acceptance paths cannot drift.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each
-- time, and this one only replaces functions — no schema changes.

create or replace function public.pending_invitations_for(p_user_id uuid)
returns table (invitation_id uuid, org_name text, role text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, o.name, i.role, i.expires_at
    from public.invitations i
    join public.orgs o on o.id = i.org_id
    join auth.users u on u.id = p_user_id
   where i.accepted_at is null
     and i.revoked_at is null
     and i.expires_at > now()
     and i.email = lower(u.email)
     and not exists (
       select 1 from public.memberships m where m.org_id = i.org_id and m.user_id = p_user_id
     )
   order by i.created_at
$$;

create or replace function public.accept_invitation_by_id(p_invitation_id uuid, p_user_id uuid)
returns table (org_id uuid, slug text, role text, invitation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  select token_hash into v_hash from public.invitations where id = p_invitation_id;
  if not found then
    raise exception 'invitation_not_found: no invitation with that id';
  end if;
  return query select * from public.accept_invitation(v_hash, p_user_id);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.pending_invitations_for(uuid)',
    'public.accept_invitation_by_id(uuid, uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Rollback:
-- drop function if exists public.accept_invitation_by_id(uuid, uuid), public.pending_invitations_for(uuid);
