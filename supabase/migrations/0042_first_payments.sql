-- How quickly workspaces reach their first payment on Arc testnet
-- (docs/superpowers/specs/2026-10-01-first-payment-design.md §3).
--
-- open_first_payments(p_since) counts the workspaces whose first payment falls
-- in the period, and the median minutes from each one's creation to that
-- payment (R3), split into customers' workspaces, ours and the total by the
-- same rule as open_numbers (0037). A workspace's first payment is its
-- earliest confirmed live Circle transfer; a later payment inside the period
-- never makes it a first. A workspace whose first payment is older than the
-- workspace itself (the founding workspace: its rows were moved into it when
-- workspaces were introduced, 0015) made a first payment, but has no time to
-- it, so it is counted and left out of the median. With no time to measure in
-- the period, the median is null.
--
-- A function of its own, not a change to open_numbers, which the EURC branch's
-- 0040 redefines: the two can land in either order. Like open_numbers, only
-- aggregates leave it, and only the service role may call it.

create or replace function public.open_first_payments(p_since timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with
  org_side as (
    select o.id, o.created_at,
           case when o.created_by is not null
                 and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
                then 'customers' else 'ours' end as side
      from public.orgs o
  ),
  sides (side) as (values ('customers'), ('ours'), ('total')),
  first_pay as (
    select p.org_id, min(coalesce(p.executed_at, p.confirmed_at, p.updated_at)) as at
      from public.payment_intents p
     where p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed'
     group by p.org_id
  ),
  firsts as (
    select s.side,
           case when f.at >= s.created_at then extract(epoch from (f.at - s.created_at)) / 60 end as minutes
      from first_pay f
      join org_side s on s.id = f.org_id
     where f.at >= coalesce(p_since, '-infinity'::timestamptz)
  )
  select jsonb_build_object(
    'sides', (
      select jsonb_object_agg(sd.side, jsonb_build_object(
        'firstPayments', (select count(*) from firsts x where sd.side in ('total', x.side)),
        'medianMinutesToFirstPayment',
          (select percentile_cont(0.5) within group (order by x.minutes)
             from firsts x where sd.side in ('total', x.side) and x.minutes is not null)
      ))
      from sides sd
    )
  )
$$;

revoke execute on function public.open_first_payments(timestamptz) from public, anon, authenticated;
grant execute on function public.open_first_payments(timestamptz) to service_role;

-- Rollback:
-- drop function if exists public.open_first_payments(timestamptz);
