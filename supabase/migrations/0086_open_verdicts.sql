-- How often people agreed with the agent in shadow mode, for /open (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
-- S8). open_verdicts(p_since, p_network) counts, per side as open_numbers splits them (0075), the verdicts given since the
-- period's start on payables in that network's workspaces, never on a sample payee's bill, and how many of them agreed.
-- A function of its own beside open_outcomes, read the same way (src/lib/platform/open-numbers.ts): until this migration
-- runs, /open shows no rate and every other figure as before.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create or replace function public.open_verdicts(p_since timestamptz, p_network text) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with
  org_side as (
    select o.id,
           case when o.created_by is not null
                 and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
                then 'customers' else 'ours' end as side
      from public.orgs o
     where o.network = p_network
  ),
  sides (side) as (values ('customers'), ('ours'), ('total')),
  given as (
    select s.side, v.verdict
      from public.decision_verdicts v
      join org_side s on s.id = v.org_id
      join public.invoices i on i.id = v.subject_id and i.org_id = v.org_id
      join public.counterparties c on c.id = i.counterparty_id
     where v.subject = 'invoice'
       and not c.sample
       and v.decided_at >= coalesce(p_since, '-infinity'::timestamptz)
  )
  select jsonb_build_object(
    'sides', (
      select jsonb_object_agg(sd.side, jsonb_build_object(
        'verdictsGiven',  (select count(*) from given g where sd.side in ('total', g.side)),
        'verdictsAgreed', (select count(*) from given g where sd.side in ('total', g.side) and g.verdict = 'agree')
      ))
        from sides sd
    )
  );
$$;

revoke execute on function public.open_verdicts(timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_verdicts(timestamptz, text) to service_role;

-- Down (by hand): drop function if exists public.open_verdicts(timestamptz, text);
