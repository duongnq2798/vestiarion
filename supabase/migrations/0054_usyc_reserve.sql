-- A real USYC reserve (docs/superpowers/specs/2026-10-02-usyc-live-design.md R1).
--
-- orgs.usyc_live_at: when an owner or admin turned the workspace's USYC reserve on, after the app
-- checked on chain that Circle allowlisted its wallets. Null means the reserve is simulated, as every
-- workspace's was before. usyc_live_by: who did.
--
-- enable_usyc_reserve: told who is acting (the 0021/0025 pattern), it checks that person's role
-- itself, and turns the reserve on once. The on-chain check and the simulated reserve's being empty
-- are the app's, before it calls this. Idempotent throughout.

alter table public.orgs
  add column if not exists usyc_live_at timestamptz,
  add column if not exists usyc_live_by uuid references auth.users(id) on delete set null;

create or replace function public.enable_usyc_reserve(p_org_id uuid, p_actor uuid) returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public.member_role(p_org_id, p_actor);
  v_at   timestamptz;
begin
  if v_role is null then
    raise exception 'not_a_member: the acting person is not a member of this organization';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'usyc_not_permitted: a % cannot turn on the USYC reserve', v_role;
  end if;
  update public.orgs
     set usyc_live_at = now(), usyc_live_by = p_actor
   where id = p_org_id and mode = 'live' and usyc_live_at is null
  returning usyc_live_at into v_at;
  if v_at is not null then
    return v_at;
  end if;
  select usyc_live_at into v_at from public.orgs where id = p_org_id;
  if v_at is not null then
    raise exception 'already_live: the USYC reserve has been on since %', v_at;
  end if;
  raise exception 'not_live: only a live workspace can hold USYC';
end;
$$;

revoke execute on function public.enable_usyc_reserve(uuid, uuid) from public, anon, authenticated;
grant execute on function public.enable_usyc_reserve(uuid, uuid) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.enable_usyc_reserve(uuid, uuid);
-- alter table public.orgs drop column if exists usyc_live_by, drop column if exists usyc_live_at;
