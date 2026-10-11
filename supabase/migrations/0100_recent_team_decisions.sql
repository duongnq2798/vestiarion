-- The agent's earlier decisions, for the landing's proof
-- (docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md D1, D2).
--
-- latest_team_decision() (0087, 0088) gives the landing one decision, so a visitor could not tell whether the agent
-- had made one or hundreds, or whether it ever holds or refuses. recent_team_decisions() gives the few before it, from
-- the same workspaces and on the same terms: the founding workspace and those a team member created, live only, never a
-- customer's, never one whose creator left, never a decision about a sample payee. And never one made where payments
-- are simulated (`execution.chainMode` 'simulate'): its "paid" moved nothing.
--
-- One decision per bill or milestone, its newest: the agent decides a held bill again each cycle, and ten "Held" rows
-- for one bill would say nothing new. It takes the newest 500 of those decisions by seq, which the planner can read
-- backwards along the primary key (team_decisions is not materialized, so each use plans on its own), and returns at
-- most p_limit (1 to 12) bills from them, newest first.
--
-- Each gives the fields the page may show and nothing else, as 0088 does, without the signed chain fields (only the
-- latest decision is checked in the browser) and without the workspace's id, which no caller needs: never the entry's
-- summary, the model's reasoning, a person's reason, a name, or an id of a bill or payee. For a pay or release decision,
-- paidTxHash is the bill's confirmed payment, whoever sent it (0088), and paymentFailed says a payment of it failed and
-- none confirmed, so a transfer that was still confirming when the agent recorded it is never shown as confirming after
-- it failed.
--
-- pastWeek counts the agent's decisions in those workspaces in the last 7 days, each network on its own: a count of
-- decisions, never of money, and never the two networks added together. It reads the week's entries of the team's
-- workspaces.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create or replace function public.recent_team_decisions(p_limit integer default 6) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with team_decisions as not materialized (
    select l.seq, l.ts, l.action, l.detail, l.org_id, o.network
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
       and coalesce(l.detail->'execution'->>'chainMode', 'live') <> 'simulate'
  ),
  newest as (
    select * from team_decisions order by seq desc limit 500
  ),
  one_per_subject as (
    select distinct on (n.org_id, coalesce(n.detail->>'invoiceId', n.detail->>'milestoneId', n.seq::text)) n.*
      from newest n
     order by n.org_id, coalesce(n.detail->>'invoiceId', n.detail->>'milestoneId', n.seq::text), n.seq desc
  ),
  shown as (
    select * from one_per_subject order by seq desc limit greatest(1, least(coalesce(p_limit, 6), 12))
  )
  select jsonb_build_object(
           'decisions', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'seq', s.seq,
                      'ts', s.ts,
                      'action', s.action,
                      'network', s.network,
                      'amount', s.detail->'observed'->'amount',
                      'currency', coalesce(s.detail->>'currency', 'USDC'),
                      'decisionMode', s.detail->>'decisionMode',
                      'agreedWithReference', s.detail->'agreedWithReference',
                      'guardrailBlocked', s.detail->'guardrailBlocked',
                      'guardrailRule', s.detail->>'guardrailRule',
                      'heldBecause', coalesce(s.detail->'execution'->>'heldBecause', s.detail->>'heldBecause'),
                      'resultingStatus', s.detail->'execution'->>'resultingStatus',
                      'txRef', s.detail->'execution'->>'txRef',
                      'payOn', s.detail->'decision'->>'payOn',
                      'verdict', (select v.verdict from public.decision_verdicts v where v.org_id = s.org_id and v.entry_seq = s.seq),
                      'paidTxHash', case when s.action in ('ap_pay', 'milestone_release') then (
                        select p.tx_hash from public.payment_intents p
                         where p.org_id = s.org_id
                           and p.source_type = case when s.action = 'milestone_release' then 'milestone' else 'invoice' end
                           and p.source_id::text = coalesce(s.detail->>'invoiceId', s.detail->>'milestoneId')
                           and p.status = 'confirmed'
                         limit 1
                      ) end,
                      'paymentFailed', case when s.action in ('ap_pay', 'milestone_release') then (
                        exists (
                          select 1 from public.payment_intents p
                           where p.org_id = s.org_id
                             and p.source_type = case when s.action = 'milestone_release' then 'milestone' else 'invoice' end
                             and p.source_id::text = coalesce(s.detail->>'invoiceId', s.detail->>'milestoneId')
                             and p.status = 'failed'
                        ) and not exists (
                          select 1 from public.payment_intents p
                           where p.org_id = s.org_id
                             and p.source_type = case when s.action = 'milestone_release' then 'milestone' else 'invoice' end
                             and p.source_id::text = coalesce(s.detail->>'invoiceId', s.detail->>'milestoneId')
                             and p.status = 'confirmed'
                        )
                      ) else false end
                    ) order by s.seq desc)
               from shown s
           ), '[]'::jsonb),
           'pastWeek', jsonb_build_object(
             'arc-mainnet', (select count(*) from team_decisions d where d.network = 'arc-mainnet' and d.ts > now() - interval '7 days'),
             'arc-testnet', (select count(*) from team_decisions d where d.network = 'arc-testnet' and d.ts > now() - interval '7 days')
           )
         )
$$;

revoke all on function public.recent_team_decisions(integer) from public, anon, authenticated;
grant execute on function public.recent_team_decisions(integer) to service_role;
