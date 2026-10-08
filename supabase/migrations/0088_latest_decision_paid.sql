-- The landing's latest decision, with the payment that followed it
-- (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R2, R4).
--
-- 0087's latest_team_decision() gave a decision the transaction its own entry recorded. A payment held in shadow mode
-- for a person's verdict is sent later, by the person who agreed, so the agent's entry never records it: the band said
-- the bill still waited for a verdict that had been given, with no transaction. paidTxHash is the confirmed payment of
-- the bill or milestone a pay or release decision was about, from its one payment intent, whoever sent it; null until
-- one confirmed. Everything else is 0087's, unchanged.
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
           'paidTxHash', case when l.action in ('ap_pay', 'milestone_release') then (
             select p.tx_hash from public.payment_intents p
              where p.org_id = l.org_id
                and p.source_type = case when l.action = 'milestone_release' then 'milestone' else 'invoice' end
                and p.source_id::text = coalesce(l.detail->>'invoiceId', l.detail->>'milestoneId')
                and p.status = 'confirmed'
              limit 1
           ) end,
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
