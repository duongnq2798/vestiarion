-- Screening health (docs/superpowers/specs/2026-10-22-screening-health-design.md SH3, SH4).
--
-- 1. compliance_checks_live_newest: a workspace's live checks, newest first. Every workspace page's header reads its
--    newest live check (SH4) and the Compliance page its last complete one (SH3), each as one `limit 1` query on it.
-- 2. compliance_checks_live_recent: every workspace's live checks by time, for the read below.
-- 3. screening_health(): live screening across workspaces, for the team's /admin/screening behind its own gate
--    (src/lib/growth/gate.ts): the last complete live check, the last failed one with its note's first 120
--    characters, and how many of each in the last 24 hours and 7 days. Workspace slugs only; no counterparty, no
--    person. The service role only.
--
-- Additive and idempotent: scripts/migrate.ts re-runs every file each time. Until it runs, the header and the
-- Compliance page read the same rows without the index, and /admin/screening says the platform read is not there yet.

create index if not exists compliance_checks_live_newest
  on public.compliance_checks (org_id, created_at desc)
  where screening_mode = 'live';

create index if not exists compliance_checks_live_recent
  on public.compliance_checks (created_at desc)
  where screening_mode = 'live';

-- One object: lastComplete and lastFailed (each null when there is none) with when, the workspace's slug and the
-- source; lastFailed also with its note's first 120 characters; and day and week, the complete and failed live checks
-- in the last 24 hours and 7 days. Simulated checks, a sandbox's bundled list, are never counted.
create or replace function public.screening_health() returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'lastComplete', (
      select jsonb_build_object('at', c.created_at, 'slug', o.slug, 'source', c.source)
        from public.compliance_checks c
        join public.orgs o on o.id = c.org_id
       where c.screening_mode = 'live' and c.status = 'complete'
       order by c.created_at desc
       limit 1
    ),
    'lastFailed', (
      select jsonb_build_object('at', c.created_at, 'slug', o.slug, 'source', c.source, 'note', left(c.notes, 120))
        from public.compliance_checks c
        join public.orgs o on o.id = c.org_id
       where c.screening_mode = 'live' and c.status = 'failed'
       order by c.created_at desc
       limit 1
    ),
    'day', (
      select jsonb_build_object('complete', count(*) filter (where c.status = 'complete'), 'failed', count(*) filter (where c.status = 'failed'))
        from public.compliance_checks c
       where c.screening_mode = 'live' and c.created_at >= now() - interval '24 hours'
    ),
    'week', (
      select jsonb_build_object('complete', count(*) filter (where c.status = 'complete'), 'failed', count(*) filter (where c.status = 'failed'))
        from public.compliance_checks c
       where c.screening_mode = 'live' and c.created_at >= now() - interval '7 days'
    )
  )
$$;

revoke execute on function public.screening_health() from public, anon, authenticated;
grant execute on function public.screening_health() to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.screening_health();
-- drop index if exists public.compliance_checks_live_recent;
-- drop index if exists public.compliance_checks_live_newest;
