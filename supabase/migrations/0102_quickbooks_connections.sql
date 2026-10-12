-- QuickBooks Online on the accounting connectors (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q5,
-- Q11). Migration 0101's tables already take provider = 'quickbooks'; this adds what a QuickBooks connection needs
-- across workspaces.
--
-- accounting_connections_quickbooks_one_workspace: a QuickBooks company is connected, not revoked, to one workspace at
-- a time. Revoking the app's token, or disconnecting the app in QuickBooks, ends every grant the app holds for the
-- company, so two workspaces on one company would cut each other off. Xero organisations may still be shared (Xero
-- connector X4).
--
-- accounting_connections_by_external(provider, ids): the connections, not revoked, of these external organisations in
-- every workspace, with their workspace, id, status and next sync time; nothing else. QuickBooks' webhook names a
-- company (its realm id) and no workspace, and the connect flow checks that no other workspace holds the company. The
-- service role's alone, as accounting_connections_due (0101) is.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create unique index if not exists accounting_connections_quickbooks_one_workspace
  on public.accounting_connections (provider, external_org_id)
  where provider = 'quickbooks' and status <> 'revoked';

create or replace function public.accounting_connections_by_external(p_provider text, p_external_org_ids text[])
returns table (org_id uuid, connection_id uuid, external_org_id text, status text, next_sync_after timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.org_id, c.id, c.external_org_id, c.status, c.next_sync_after
    from public.accounting_connections c
   where c.provider = p_provider
     and c.external_org_id = any (coalesce(p_external_org_ids, '{}'::text[]))
     and c.status <> 'revoked'
   order by c.connected_at
   limit 500;
$$;

revoke execute on function public.accounting_connections_by_external(text, text[]) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.accounting_connections_by_external(text, text[]) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.accounting_connections_by_external(text, text[]);
-- drop index if exists public.accounting_connections_quickbooks_one_workspace;
