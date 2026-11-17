-- Database hygiene: what Supabase's advisors flagged, and the two reads that cost the most per call (pg_stat_statements:
-- open_outcomes, about 1.1 s, and recent_team_decisions, about 1.0 s, mean). open_numbers, second by total time at about
-- 0.5 s a call, is not changed here.
--
-- 1. advance_sim_day and append_ledger_entry run with a fixed search_path, as every other function here does.
--    advance_sim_day names its table with its schema, so it takes the empty path. append_ledger_entry names
--    ledger_entries and pgcrypto's digest without one, so it takes the schemas they are found in today: public, then
--    extensions (where Supabase keeps pgcrypto), and pg_temp last, so a temporary table never stands in for the ledger.
--    CREATE OR REPLACE drops a function's SET clause: 0016 and 0017 re-run before this file and redefine both without
--    one, and this file sets it again. A later redefinition of either must keep it.
-- 2. orgs_network_locked and payment_intents_network (0075, 0078), and Supabase's rls_auto_enable event trigger
--    function, are SECURITY DEFINER and anon and authenticated could execute them through PUBLIC. Nothing calls them: a
--    trigger fires whatever its function's EXECUTE privilege. EXECUTE is revoked from public, anon and authenticated;
--    for rls_auto_enable only where it exists, as Supabase creates it and these migrations do not.
-- 3. Seven foreign keys on org_id alone had no index a workspace's delete can use, so it read each of those tables in
--    full: four had none (accounting_tokens, growth_revenue, jira_sites, webhook_deliveries), and three only partial
--    ones whose predicate the delete does not meet (counterparty_bank_accounts, policy_proposals, report_shares). Each
--    gets a plain one.
-- 4. open_outcomes(p_since, p_network): its resolutions found a person's approvals of each payable by reading all of
--    the payable's workspace's ledger entries, once per payable (337,675 buffer reads a call on production on Nov 17).
--    It now also says the approval names an invoice, which matching the payable's id already requires, so they are
--    found through 0007's ledger_entries_invoice_target_idx (15,354 reads, the same figures). 0075's body otherwise.
-- 5. recent_team_decisions(p_limit): team_decisions is read once and kept (materialized) instead of once for the newest
--    decisions and once for each network's week. 0100 expected the planner to read it backwards along the primary key;
--    it read each team workspace's entries, three times over (23,120 reads, 13,467 read once). ledger_entries_agent_choice_idx
--    holds only the agent's choices on bills and milestones, under the same filter as team_decisions and
--    latest_team_decision, so that read touches those entries alone. 0100's body otherwise.
--
-- Lock order: the file runs in one transaction and holds each index's SHARE lock until it commits, on every re-run too.
-- A ledger append locks ledger_entries and then, through 0028's webhook trigger, webhook_deliveries, so the ledger's
-- index is made before any other: in the other order the file and an append could each wait on the other.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

-- 1.
alter function public.advance_sim_day(uuid) set search_path = '';
alter function public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text)
  set search_path = public, extensions, pg_temp;

-- 2.
revoke execute on function public.orgs_network_locked() from public, anon, authenticated;
revoke execute on function public.payment_intents_network() from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- 5's index first (lock order, above).
create index if not exists ledger_entries_agent_choice_idx on public.ledger_entries (org_id, seq)
  where actor = 'agent'
    and action in ('ap_pay', 'ap_schedule', 'ap_hold', 'ap_request_info', 'ap_flag_fraud', 'milestone_release', 'milestone_hold');

-- 3.
create index if not exists accounting_tokens_org_idx on public.accounting_tokens (org_id);
create index if not exists growth_revenue_org_idx on public.growth_revenue (org_id);
create index if not exists jira_sites_org_idx on public.jira_sites (org_id);
create index if not exists webhook_deliveries_org_idx on public.webhook_deliveries (org_id);
create index if not exists counterparty_bank_accounts_org_idx on public.counterparty_bank_accounts (org_id);
create index if not exists policy_proposals_org_idx on public.policy_proposals (org_id);
create index if not exists report_shares_org_idx on public.report_shares (org_id);

-- 4.
create or replace function public.open_outcomes(p_since timestamptz, p_network text) returns jsonb
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
  period as (select coalesce(p_since, '-infinity'::timestamptz) as since),
  payables as (
    select i.id, i.org_id, i.status, i.due_date, i.reviewed_by
      from public.invoices i
      join public.counterparties c on c.id = i.counterparty_id
     where i.direction = 'payable' and not c.sample
  ),
  milestones as (
    select m.id, m.org_id
      from public.milestones m
      join public.counterparties c on c.id = m.contractor_id
     where not c.sample
  ),
  decisions as (
    select e.seq, e.org_id, e.ts, e.domain, e.action, e.detail,
           e.detail ->> 'invoiceId' as invoice_id,
           e.detail -> 'execution' ->> 'resultingStatus' as outcome
      from public.ledger_entries e
     where e.actor = 'agent'
       and e.domain in ('ap', 'contractor')
       and e.detail ? 'decision'
       and (
         (e.domain = 'ap' and exists (select 1 from payables p where p.id::text = e.detail ->> 'invoiceId' and p.org_id = e.org_id))
         or (e.domain = 'contractor' and exists (select 1 from milestones m where m.id::text = e.detail ->> 'milestoneId' and m.org_id = e.org_id))
       )
  ),
  decided as (
    select s.side,
           case when d.outcome in ('paid', 'matched', 'scheduled') then 'carried'
                when d.outcome in ('held', 'flagged', 'awaiting_info') then 'escalated' end as kind
      from decisions d
      join org_side s on s.id = d.org_id
     where d.ts >= (select since from period)
  ),
  resolutions as (
    select s.side, r.action,
           coalesce(
             r.detail ->> 'overrode',
             (select d.outcome
                from decisions d
               where d.domain = 'ap' and d.invoice_id = r.detail ->> 'invoiceId' and d.org_id = r.org_id and d.seq < r.seq
               order by d.seq desc
               limit 1)
           ) as resolved
      from public.ledger_entries r
      join org_side s on s.id = r.org_id
     where r.actor = 'human'
       and r.action in ('approval_paid', 'approval_rejected', 'approval_returned')
       and r.detail ? 'invoiceId'
       and r.ts >= (select since from period)
       and exists (select 1 from payables p where p.id::text = r.detail ->> 'invoiceId' and p.org_id = r.org_id)
  ),
  paid as (
    select s.side,
           (x.at at time zone 'UTC')::date <= (p.due_date at time zone 'UTC')::date as on_time,
           p.reviewed_by is null
             and not exists (
               select 1
                 from public.ledger_entries h
                where h.org_id = p.org_id
                  and h.actor = 'human'
                  and h.action in ('approval_paid', 'approval_rejected', 'approval_returned')
                  and h.detail ->> 'invoiceId' = p.id::text
             ) as untouched
      from payables p
      join org_side s on s.id = p.org_id
      join lateral (
        select min(coalesce(pi.executed_at, pi.confirmed_at, pi.updated_at)) as at
          from public.payment_intents pi
         where pi.org_id = p.org_id
           and pi.source_type = 'invoice'
           and pi.source_id = p.id
           and pi.provider = 'circle' and pi.provider_mode = 'live' and pi.status = 'confirmed' and pi.network = p_network
      ) x on x.at is not null
     where x.at >= (select since from period)
  ),
  duplicates as (
    select s.side
      from payables p
      join org_side s on s.id = p.org_id
     where p.status in ('flagged', 'rejected')
       and (
         select min(d.ts)
           from decisions d
          where d.domain = 'ap'
            and d.invoice_id = p.id::text
            and d.org_id = p.org_id
            and (
              d.detail ->> 'guardrailRule' = 'invoice.duplicate_of_settled'
              or (
                d.action = 'ap_flag_fraud'
                and exists (
                  select 1
                    from jsonb_array_elements(
                           case when jsonb_typeof(d.detail -> 'observed' -> 'duplicateCheck' -> 'matches') = 'array'
                                then d.detail -> 'observed' -> 'duplicateCheck' -> 'matches'
                                else '[]'::jsonb end
                         ) m
                   where m ->> 'otherInvoiceStatus' in ('paid', 'received')
                     and case when jsonb_typeof(m -> 'confidence') = 'number' then (m ->> 'confidence')::numeric else 0 end >= 0.9
                )
              )
            )
       ) >= (select since from period)
  )
  select jsonb_build_object(
    'sides', (
      select jsonb_object_agg(sd.side, jsonb_build_object(
        'decisionsCarriedOut', (select count(*) from decided x where sd.side in ('total', x.side) and x.kind = 'carried'),
        'decisionsEscalated', (select count(*) from decided x where sd.side in ('total', x.side) and x.kind = 'escalated'),
        'escalationsResolved', (select count(*) from resolutions x where sd.side in ('total', x.side)),
        'flagsResolved',
          (select count(*) from resolutions x
            where sd.side in ('total', x.side) and x.resolved = 'flagged' and x.action in ('approval_paid', 'approval_rejected')),
        'flagsUpheld',
          (select count(*) from resolutions x
            where sd.side in ('total', x.side) and x.resolved = 'flagged' and x.action = 'approval_rejected'),
        'invoicesPaidOnArc', (select count(*) from paid x where sd.side in ('total', x.side)),
        'invoicesPaidOnTime', (select count(*) from paid x where sd.side in ('total', x.side) and x.on_time),
        'invoicesPaidOnTimeUntouched', (select count(*) from paid x where sd.side in ('total', x.side) and x.on_time and x.untouched),
        'duplicatesCaught', (select count(*) from duplicates x where sd.side in ('total', x.side))
      ))
      from sides sd
    )
  )
$$;

revoke execute on function public.open_outcomes(timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_outcomes(timestamptz, text) to service_role;

-- 5. (its index is made above)
create or replace function public.recent_team_decisions(p_limit integer default 6) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with team_decisions as materialized (
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

-- Rollback:
-- 0075's open_outcomes and 0100's recent_team_decisions bodies, re-run;
-- drop index if exists public.ledger_entries_agent_choice_idx;
-- drop index if exists public.accounting_tokens_org_idx, public.growth_revenue_org_idx, public.jira_sites_org_idx, public.webhook_deliveries_org_idx;
-- drop index if exists public.counterparty_bank_accounts_org_idx, public.policy_proposals_org_idx, public.report_shares_org_idx;
-- alter function public.advance_sim_day(uuid) reset search_path;
-- alter function public.append_ledger_entry(uuid, text, text, text, text, jsonb, text, text, text) reset search_path;
