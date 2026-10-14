-- pipedrive_connector_ready(p_org_id): the readiness probe as the tenant data layer calls it.
--
-- The data layer (src/lib/dal) passes the workspace as p_org_id to every tenant function. 0116's
-- pipedrive_connector_ready() takes no argument, so PostgREST found no function to call (PGRST202) and the Pipedrive
-- card said "Pipedrive is not set up on this deployment yet." on a deployment where it was. This version takes the
-- workspace and, like 0116's, reads nothing. 0116's version stays: its own re-run creates it again anyway.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create or replace function public.pipedrive_connector_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.pipedrive_connector_ready(uuid) from public, anon, authenticated;
grant execute on function public.pipedrive_connector_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts): drop function if exists public.pipedrive_connector_ready(uuid);
