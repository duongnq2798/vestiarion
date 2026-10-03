-- A workspace API key works only while the person who created it is a member of the workspace
-- (docs/superpowers/specs/2026-10-03-member-api-keys-design.md). Before this, a key outlived its creator's membership
-- (API keys design K4). Re-runnable, as every migration here: db:migrate applies them all in order. It redefines no
-- existing function, so a run from a checkout without this file neither fails nor undoes it.
--
-- The functions that read or lock platform rows are security definer with an empty search_path, as 0020's
-- keep_an_owner is: memberships and api_keys are platform tables that only the service role may touch.

-- 1. Whatever ends a membership revokes the keys its person created in that workspace, in the same transaction (R1):
--    leaving or being removed (remove_member, and remove_member_revoking_keys below), the cascade from deleting an
--    account, an operator's delete, or code deployed before this file that still calls remove_member.
create or replace function public.revoke_departed_member_api_keys() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The organization row is gone: this membership goes with it, and so do its keys (0027's cascade).
  perform 1 from public.orgs where id = old.org_id;
  if not found then
    return old;
  end if;

  update public.api_keys set revoked_at = now()
   where org_id = old.org_id and created_by = old.user_id and revoked_at is null;
  return old;
end;
$$;

revoke execute on function public.revoke_departed_member_api_keys() from public, anon, authenticated;

drop trigger if exists memberships_revoke_api_keys on public.memberships;
create trigger memberships_revoke_api_keys
  after delete on public.memberships
  for each row execute function public.revoke_departed_member_api_keys();

-- 2. Deleting an account clears created_by on its keys (0027's on delete set null). Such a key acts for nobody, so the
--    same update revokes it (R2): deleting an account revokes its keys whichever of its cascades runs first.
create or replace function public.revoke_api_key_without_creator() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.created_by is not null and new.created_by is null and new.revoked_at is null then
    new.revoked_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.revoke_api_key_without_creator() from public, anon, authenticated;

drop trigger if exists api_keys_revoke_without_creator on public.api_keys;
create trigger api_keys_revoke_without_creator
  before update of created_by on public.api_keys
  for each row execute function public.revoke_api_key_without_creator();

-- 3. Only a member creates a key (R3). The key-share lock holds the creator's membership row until the key is
--    committed: a removal waits for it and then revokes the new key with the others, and a removal that committed
--    first leaves no row to find. A key with no creator, which only the operator can insert, is no one's to end.
create or replace function public.api_key_creator_is_member() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    perform 1 from public.memberships m
     where m.org_id = new.org_id and m.user_id = new.created_by
       for key share;
    if not found then
      raise exception 'api_key_creator_not_a_member: the person creating this key is not a member of this organization';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.api_key_creator_is_member() from public, anon, authenticated;

drop trigger if exists api_keys_creator_is_member on public.api_keys;
create trigger api_keys_creator_is_member
  before insert on public.api_keys
  for each row execute function public.api_key_creator_is_member();

-- 4. What the app calls to end a membership (R4): remove_member (0021), unchanged, and the ids of the keys it revoked,
--    oldest first, so each gets its own signed ledger entry.
create or replace function public.remove_member_revoking_keys(p_org_id uuid, p_actor uuid, p_user_id uuid)
returns table (removed_role text, revoked_key_ids uuid[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys uuid[];
  v_role text;
begin
  -- Lock the membership first. A key being created for this person holds a key-share lock on this row (3), so it is
  -- committed before the keys are read below, and none can be created after.
  perform 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_user_id for update;

  -- Revoked before remove_member checks the actor: a refusal raises, and the whole call rolls back, these updates
  -- included. remove_member's delete then fires (1), which finds nothing left to revoke.
  with revoked as (
    update public.api_keys k set revoked_at = now()
     where k.org_id = p_org_id and k.created_by = p_user_id and k.revoked_at is null
    returning k.id, k.created_at
  )
  select coalesce(array_agg(r.id order by r.created_at, r.id), '{}') into v_keys from revoked r;

  v_role := public.remove_member(p_org_id, p_actor, p_user_id);
  return query select v_role, v_keys;
end;
$$;

revoke execute on function public.remove_member_revoking_keys(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_member_revoking_keys(uuid, uuid, uuid) to service_role;

-- Rollback:
-- drop function if exists public.remove_member_revoking_keys(uuid, uuid, uuid);
-- drop trigger if exists api_keys_creator_is_member on public.api_keys;
-- drop trigger if exists api_keys_revoke_without_creator on public.api_keys;
-- drop trigger if exists memberships_revoke_api_keys on public.memberships;
-- drop function if exists public.api_key_creator_is_member(), public.revoke_api_key_without_creator(),
--   public.revoke_departed_member_api_keys();
