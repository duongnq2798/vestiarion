-- How the agent's payment decisions turned out
-- (docs/superpowers/specs/2026-10-01-open-outcomes-design.md).
--
-- open_outcomes(p_since) returns, per side (customers' workspaces, ours, the
-- total, by the same rule as open_numbers, 0037):
--   * decisionsCarriedOut / decisionsEscalated — the agent's decisions on
--     payables and contractor milestones, by what happened (R2-R4): the ledger
--     action names the proposal, detail.execution.resultingStatus the outcome;
--   * escalationsResolved — a person's approve, reject or return;
--   * flagsResolved / flagsUpheld — of those, the ones about a flag that a
--     person paid or rejected, and the rejections (R5);
--   * invoicesPaidOnArc / invoicesPaidOnTime / invoicesPaidOnTimeUntouched —
--     payables paid by a confirmed live Circle payment in the period, on or
--     before their due day (UTC), and of those, the ones no person decided (R6, R7);
--   * duplicatesCaught — payables the agent stopped as a confirmed duplicate,
--     by the rule of isConfirmedDuplicate (src/lib/agent/counterparty-history.ts)
--     with DUPLICATE_BLOCK_CONFIDENCE 0.9, and never paid since (R8).
-- Every figure joins to an invoice or milestone that still exists and is not
-- sample data (R9).
--
-- A function of its own, not a change to open_numbers, so no re-run of an
-- older migration can put a previous open_numbers back over it. Only
-- aggregates leave it, and only the service role may call it.

create or replace function public.open_outcomes(p_since timestamptz) returns jsonb
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
           and pi.provider = 'circle' and pi.provider_mode = 'live' and pi.status = 'confirmed'
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

revoke execute on function public.open_outcomes(timestamptz) from public, anon, authenticated;
grant execute on function public.open_outcomes(timestamptz) to service_role;

-- Rollback:
-- drop function if exists public.open_outcomes(timestamptz);
