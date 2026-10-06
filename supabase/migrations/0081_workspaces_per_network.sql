-- At most 3 workspaces per person on each network, where 0020 allowed 3 in all. The cap bounds what one person can
-- spend of the platform's model calls, since every workspace has its own agent. Counted across networks, it kept a
-- person with three workspaces on Arc testnet from opening any on Arc mainnet.
--
-- create_org gains p_network, with no default, so PostgREST never has to choose between two overloads: a call is
-- matched by its keys alone. The workspace's network is written on insert, before its first account exists; 0075's
-- trigger keeps it fixed after that. createWorkspace no longer sets it right after create_org, as 0078 describes.
--
-- 0020's five-argument create_org is left as it was, counting every network. The code from before this migration still
-- calls it, until the deploy and from any tab Vercel keeps on an older deployment, and that code moves the new row to
-- Arc mainnet after creating it: counted on Arc testnet alone, its count would never grow (final review I1).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.
--
-- Rollback (by hand, never by migrate.ts): deploy the code from before this migration, then
--   drop function public.create_org(uuid, uuid, text, text, jsonb, text);

create or replace function public.create_org(
  p_org_id          uuid,
  p_user_id         uuid,
  p_name            text,
  p_slug            text,
  p_ledger_key_enc  jsonb,
  p_network         text
) returns public.orgs
language plpgsql
set search_path = ''
as $$
declare
  v_existing int;
  v_org      public.orgs;
begin
  -- As in 0020: one person's creations are serialised, so two concurrent requests cannot both pass the limit, and the
  -- count runs under a fresh snapshot that sees whatever the first one committed.
  perform pg_advisory_xact_lock(hashtext('vestiarion_create_org:' || p_user_id::text));
  select count(*) into v_existing from public.orgs where created_by = p_user_id and network = p_network;
  if v_existing >= 3 then
    raise exception 'org_limit_reached: at most 3 workspaces per person on %', p_network;
  end if;

  insert into public.orgs (id, slug, name, mode, created_by, ledger_signing_key_enc, network)
  values (p_org_id, p_slug, btrim(p_name), 'sandbox', p_user_id, p_ledger_key_enc, p_network)
  returning * into v_org;

  insert into public.memberships (org_id, user_id, role) values (p_org_id, p_user_id, 'owner');
  return v_org;
end;
$$;

revoke execute on function public.create_org(uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_org(uuid, uuid, text, text, jsonb, text) to service_role;

notify pgrst, 'reload schema';
