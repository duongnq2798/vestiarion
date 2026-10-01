-- EURC invoices (docs/superpowers/specs/2026-10-01-eurc-invoices-design.md, E1, E6).
--
-- An invoice is in USDC or EURC, and a payment intent records the token it
-- sent: USDC for every intent before this, and by default. The open numbers
-- (0037) keep EURC out of every USDC figure — "USDC paid" and a day's USDC —
-- while an EURC payment still counts as a payment settled on Arc testnet, and
-- a listed payment says its token. The wallet total already counts USDC only.
--
-- 0038 is the payment-timing branch's and touches neither column; 0039 is
-- payee links. Idempotent throughout: scripts/migrate.ts re-runs every
-- migration each time.

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.invoices'::regclass and conname = 'invoices_currency_check') then
    alter table public.invoices add constraint invoices_currency_check check (currency in ('USDC', 'EURC'));
  end if;
end $$;

alter table public.payment_intents add column if not exists token text not null default 'USDC';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.payment_intents'::regclass and conname = 'payment_intents_token_check') then
    alter table public.payment_intents add constraint payment_intents_token_check check (token in ('USDC', 'EURC'));
  end if;
end $$;

-- open_numbers, redefined from 0037: the pay CTE carries each payment's token.
create or replace function public.open_numbers(p_since timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with
  org_side as (
    select o.id, o.mode, o.created_at,
           case when o.created_by is not null
                 and not exists (select 1 from public.platform_team t where t.user_id = o.created_by)
                then 'customers' else 'ours' end as side,
           o.id = '00000000-0000-4000-8000-000000000001'::uuid
             or exists (select 1 from public.platform_team t where t.user_id = o.created_by) as listable
      from public.orgs o
  ),
  sides (side) as (values ('customers'), ('ours'), ('total')),
  pay as (
    select s.side, s.listable, p.amount, p.token, lower(p.destination) as payee, p.tx_hash, p.chain,
           coalesce(p.executed_at, p.confirmed_at, p.updated_at) as at
      from public.payment_intents p
      join org_side s on s.id = p.org_id
     where p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed'
       and coalesce(p.executed_at, p.confirmed_at, p.updated_at) >= coalesce(p_since, '-infinity'::timestamptz)
  ),
  person as (
    select distinct m.user_id, s.side
      from public.memberships m
      join org_side s on s.id = m.org_id
     where s.side = 'ours'
        or not exists (select 1 from public.platform_team t where t.user_id = m.user_id)
  ),
  inv as (
    select s.side
      from public.invoices i
      join org_side s on s.id = i.org_id
      join public.counterparties c on c.id = i.counterparty_id
     where i.decided_at is not null
       and i.decided_at >= coalesce(p_since, '-infinity'::timestamptz)
       and not c.sample
  ),
  mil as (
    select s.side
      from public.milestones m
      join org_side s on s.id = m.org_id
      join public.counterparties c on c.id = m.contractor_id
      join public.payment_intents p
        on p.org_id = m.org_id and p.source_type = 'milestone' and p.source_id = m.id
     where m.status = 'paid' and not c.sample
       and p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed'
       and coalesce(p.executed_at, p.confirmed_at, p.updated_at) >= coalesce(p_since, '-infinity'::timestamptz)
  ),
  run as (
    select s.side, r.model_decision_count, r.reference_disagreement_count, r.guardrail_override_count
      from public.cycle_runs r
      join org_side s on s.id = r.org_id
     where r.started_at >= coalesce(p_since, '-infinity'::timestamptz)
  ),
  wallet as (
    select s.side, a.balance
      from public.accounts a
      join org_side s on s.id = a.org_id
     where s.mode = 'live' and a.circle_wallet_id is not null and a.token = 'USDC'
       and a.chain = 'ARC-TESTNET' and a.balance_synced_at is not null
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'sides', (
      select jsonb_object_agg(sd.side, jsonb_build_object(
        'workspacesOpened',   (select count(*) from org_side o where sd.side in ('total', o.side)
                                  and o.created_at >= coalesce(p_since, '-infinity'::timestamptz)),
        'liveWorkspaces',     (select count(*) from org_side o where sd.side in ('total', o.side) and o.mode = 'live'),
        'people',             case when sd.side = 'total'
                                   then (select count(distinct m.user_id) from public.memberships m)
                                   else (select count(distinct x.user_id) from person x where x.side = sd.side) end,
        'payments',           (select count(*) from pay x where sd.side in ('total', x.side)),
        'usdcPaid',           (select coalesce(sum(x.amount), 0) from pay x where sd.side in ('total', x.side) and x.token = 'USDC'),
        'payees',             (select count(distinct x.payee) from pay x where sd.side in ('total', x.side)),
        'invoicesDecided',    (select count(*) from inv x where sd.side in ('total', x.side)),
        'milestonesReleased', (select count(*) from mil x where sd.side in ('total', x.side)),
        'cycles',             (select count(*) from run x where sd.side in ('total', x.side)),
        'modelDecisions',     (select coalesce(sum(x.model_decision_count), 0) from run x where sd.side in ('total', x.side)),
        'policyDepartures',   (select coalesce(sum(x.reference_disagreement_count), 0) from run x where sd.side in ('total', x.side)),
        'refusedByCode',      (select coalesce(sum(x.guardrail_override_count), 0) from run x where sd.side in ('total', x.side)),
        'usdcInWallets',      (select coalesce(sum(x.balance), 0) from wallet x where sd.side in ('total', x.side))
      ))
        from sides sd
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', d.day, 'customers', d.customers, 'ours', d.ours, 'oursUsdc', d.ours_usdc) order by d.day), '[]'::jsonb)
        from (select to_char(x.at at time zone 'UTC', 'YYYY-MM-DD') as day,
                     count(*) filter (where x.side = 'customers') as customers,
                     count(*) filter (where x.side = 'ours') as ours,
                     coalesce(sum(x.amount) filter (where x.side = 'ours' and x.token = 'USDC'), 0) as ours_usdc
                from pay x
               group by 1) d
    ),
    'ourPayments', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'at', y.at, 'amount', y.amount, 'token', y.token, 'txHash', y.tx_hash, 'chain', y.chain) order by y.at desc), '[]'::jsonb)
        from (select x.at, x.amount, x.token, x.tx_hash, x.chain
                from pay x
               where x.listable and x.tx_hash is not null
               order by x.at desc
               limit 20) y
    )
  )
$$;

revoke execute on function public.open_numbers(timestamptz) from public, anon, authenticated;
grant execute on function public.open_numbers(timestamptz) to service_role;

-- Rollback:
-- re-run 0037's open_numbers();
-- alter table public.payment_intents drop constraint if exists payment_intents_token_check;
-- alter table public.payment_intents drop column if exists token;
-- alter table public.invoices drop constraint if exists invoices_currency_check;
