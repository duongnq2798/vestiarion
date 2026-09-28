-- Self-serve workspaces (spec §6, §10 step 5a).
--
-- create_org is the only way an organization is born outside the operator's
-- scripts. The server generates p_org_id first because the ledger key's
-- ciphertext is bound to it (§5.4); the function checks the per-person limit,
-- inserts the organization in sandbox mode and makes the caller its owner, in
-- one transaction.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create or replace function public.create_org(
  p_org_id          uuid,
  p_user_id         uuid,
  p_name            text,
  p_slug            text,
  p_ledger_key_enc  jsonb
) returns public.orgs
language plpgsql
set search_path = ''
as $$
declare
  v_existing int;
  v_org      public.orgs;
begin
  -- Serialise one person's creations so two concurrent requests cannot both
  -- pass the limit.
  perform pg_advisory_xact_lock(hashtext('vestiarion_create_org:' || p_user_id::text));
  select count(*) into v_existing from public.orgs where created_by = p_user_id;
  if v_existing >= 3 then
    raise exception 'org_limit_reached: at most 3 workspaces per person';
  end if;

  insert into public.orgs (id, slug, name, mode, created_by, ledger_signing_key_enc)
  values (p_org_id, p_slug, btrim(p_name), 'sandbox', p_user_id, p_ledger_key_enc)
  returning * into v_org;

  insert into public.memberships (org_id, user_id, role) values (p_org_id, p_user_id, 'owner');
  return v_org;
end;
$$;

revoke execute on function public.create_org(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_org(uuid, uuid, text, text, jsonb) to service_role;

-- Every organization keeps at least one owner. Deleting the organization itself
-- still cascades: by the time its memberships go, the organization row is gone.
create or replace function public.keep_an_owner() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.orgs where id = old.org_id)
     and not exists (
       select 1 from public.memberships
        where org_id = old.org_id and role = 'owner' and user_id <> old.user_id
     )
  then
    raise exception 'the last owner of an organization cannot be removed or demoted';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists memberships_keep_an_owner on public.memberships;
create trigger memberships_keep_an_owner
  before update or delete on public.memberships
  for each row execute function public.keep_an_owner();

-- Rollback:
-- drop trigger if exists memberships_keep_an_owner on public.memberships;
-- drop function if exists public.keep_an_owner();
-- drop function if exists public.create_org(uuid, uuid, text, text, jsonb);
