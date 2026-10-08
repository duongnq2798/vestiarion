-- The newest decision the agent made in one of the team's own workspaces, for the landing page
-- (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R1, R2, R4).
--
-- latest_team_decision() reads across workspaces, as open_numbers does (0037), so it is a security definer function
-- the service role alone may run. It looks only at workspaces /open lists payments from (0037 R2): the founding
-- workspace, and one a team member created; never a customer's, and never one whose creator deleted their account, which
-- may be a former customer's. Only live workspaces, and never a decision about a sample payee.
--
-- It returns the fields the page may show and nothing else: never the entry's summary, the model's reasoning, a
-- person's reason, a name, or an id of a bill or payee. The workspace's id is for the server alone; the page never gets
-- it. The signed chain fields let the reader's browser check the entry's signature and its link to the entry before it.
-- Null when there is no such decision. Until this migration runs, the landing shows no band and is otherwise unchanged.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create or replace function public.latest_team_decision() returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'orgId', l.org_id,
           'seq', l.seq,
           'ts', l.ts,
           'action', l.action,
           'network', o.network,
           'amount', l.detail->'observed'->'amount',
           'currency', coalesce(l.detail->>'currency', 'USDC'),
           'decisionMode', l.detail->>'decisionMode',
           'agreedWithReference', l.detail->'agreedWithReference',
           'guardrailBlocked', l.detail->'guardrailBlocked',
           'guardrailRule', l.detail->>'guardrailRule',
           'heldBecause', coalesce(l.detail->'execution'->>'heldBecause', l.detail->>'heldBecause'),
           'resultingStatus', l.detail->'execution'->>'resultingStatus',
           'txRef', l.detail->'execution'->>'txRef',
           'payOn', l.detail->'decision'->>'payOn',
           'verdict', (select v.verdict from public.decision_verdicts v where v.org_id = l.org_id and v.entry_seq = l.seq),
           'bodyHash', l.body_hash,
           'signature', l.signature,
           'prevHash', l.prev_hash,
           'hash', l.hash,
           'signingKeyId', l.signing_key_id
         )
    from public.ledger_entries l
    join public.orgs o on o.id = l.org_id
   where l.actor = 'agent'
     and l.action in ('ap_pay', 'ap_schedule', 'ap_hold', 'ap_request_info', 'ap_flag_fraud', 'milestone_release', 'milestone_hold')
     and o.mode = 'live'
     and (o.id = '00000000-0000-4000-8000-000000000001'::uuid
          or exists (select 1 from public.platform_team t where t.user_id = o.created_by))
     and not exists (
           select 1 from public.counterparties c
            where c.org_id = l.org_id and c.id::text = l.detail->>'counterpartyId' and c.sample
         )
   order by l.seq desc
   limit 1
$$;

revoke all on function public.latest_team_decision() from public, anon, authenticated;
grant execute on function public.latest_team_decision() to service_role;
