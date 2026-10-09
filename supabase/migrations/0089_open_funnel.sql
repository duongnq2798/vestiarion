-- How far the workspaces opened since a day got (docs/superpowers/specs/2026-10-09-activation-funnel-design.md).
-- open_funnel(p_since, p_network) counts, per side as open_numbers splits them (0037, 0075), the workspaces of that
-- network opened since the period's start, and of those how many have reached each step: a real bill (a payable whose
-- counterparty is not sample data), the agent's decision on one, a confirmed live payment (a bill's or a milestone's,
-- never sample data's, never a simulated one), payments on two UTC days or more, a person's verdict in shadow mode, and
-- two people in the workspace. Read by `npm run numbers` (src/lib/platform/funnel.ts); nothing shows it on /open yet.
-- Only counts of workspaces leave it, and only the service role may call it.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time. It redefines no earlier function.

create or replace function public.open_funnel(p_since timestamptz, p_network text) returns jsonb
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
       and o.created_at >= coalesce(p_since, '-infinity'::timestamptz)
  ),
  sides (side) as (values ('customers'), ('ours'), ('total')),
  real_bills as (
    select i.id, i.org_id
      from public.invoices i
      join public.counterparties c on c.id = i.counterparty_id
     where i.direction = 'payable' and not c.sample
  ),
  with_bill as (select distinct org_id from real_bills),
  with_decision as (
    select distinct e.org_id
      from public.ledger_entries e
     where e.actor = 'agent'
       and e.action in ('ap_pay', 'ap_schedule', 'ap_hold', 'ap_flag_fraud', 'ap_request_info')
       and exists (select 1 from real_bills b where b.id::text = e.detail ->> 'invoiceId' and b.org_id = e.org_id)
  ),
  paid_days as (
    select pi.org_id,
           count(distinct (coalesce(pi.executed_at, pi.confirmed_at, pi.updated_at) at time zone 'UTC')::date) as days
      from public.payment_intents pi
     where pi.provider = 'circle'
       and pi.provider_mode = 'live'
       and pi.status = 'confirmed'
       and (
         (pi.source_type = 'invoice' and exists (select 1 from real_bills b where b.id = pi.source_id and b.org_id = pi.org_id))
         or (
           pi.source_type = 'milestone'
           and exists (
             select 1
               from public.milestones m
               join public.counterparties c on c.id = m.contractor_id
              where m.id = pi.source_id and m.org_id = pi.org_id and not c.sample
           )
         )
       )
     group by pi.org_id
  ),
  with_verdict as (select distinct v.org_id from public.decision_verdicts v),
  with_two_people as (select m.org_id from public.memberships m group by m.org_id having count(*) >= 2),
  reached as (
    select s.side,
           exists (select 1 from with_bill x where x.org_id = s.id) as bill,
           exists (select 1 from with_decision x where x.org_id = s.id) as decided,
           coalesce((select p.days from paid_days p where p.org_id = s.id), 0) as days,
           exists (select 1 from with_verdict x where x.org_id = s.id) as verdict,
           exists (select 1 from with_two_people x where x.org_id = s.id) as two_people
      from org_side s
  )
  select jsonb_build_object(
    'sides', (
      select jsonb_object_agg(sd.side, jsonb_build_object(
        'opened',        (select count(*) from reached r where sd.side in ('total', r.side)),
        'withRealBill',  (select count(*) from reached r where sd.side in ('total', r.side) and r.bill),
        'withDecision',  (select count(*) from reached r where sd.side in ('total', r.side) and r.decided),
        'withPayment',   (select count(*) from reached r where sd.side in ('total', r.side) and r.days >= 1),
        'paidOnTwoDays', (select count(*) from reached r where sd.side in ('total', r.side) and r.days >= 2),
        'withVerdict',   (select count(*) from reached r where sd.side in ('total', r.side) and r.verdict),
        'withTwoPeople', (select count(*) from reached r where sd.side in ('total', r.side) and r.two_people)
      ))
        from sides sd
    )
  );
$$;

revoke execute on function public.open_funnel(timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_funnel(timestamptz, text) to service_role;

-- Down (by hand): drop function if exists public.open_funnel(timestamptz, text);
