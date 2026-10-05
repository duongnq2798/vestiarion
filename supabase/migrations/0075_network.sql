-- A network for every workspace (docs/superpowers/specs/2026-10-05-network-foundation-design.md N1, N2, N4, N7).
--
-- orgs.network is 'arc-testnet' or 'arc-mainnet', Arc testnet by default: every workspace so far is on it. Once a
-- workspace has gone live or holds a Circle wallet its network never changes (N2): mainnet is a workspace of its own,
-- so no wallet, balance or ledger entry crosses networks. payment_intents.network is taken from the workspace when an
-- intent is inserted (N4), so no caller can mislabel one.
--
-- The open numbers gain a network argument (N7): open_numbers, open_first_payments and open_outcomes(p_since,
-- p_network) count one network's workspaces and payments, so /open never adds Arc mainnet to Arc testnet. They copy
-- the latest bodies (0040, 0042, 0049) with that filter. The one-argument versions are left as they are: no default on
-- p_network, so a call naming only p_since still reaches them, whichever of the code and this migration lands first.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.orgs add column if not exists network text not null default 'arc-testnet';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.orgs'::regclass and conname = 'orgs_network_check') then
    alter table public.orgs add constraint orgs_network_check check (network in ('arc-testnet', 'arc-mainnet'));
  end if;
end $$;

comment on column public.orgs.network is
  'The network the workspace pays on: arc-testnet or arc-mainnet. Locked once it went live or holds a Circle wallet (0075).';

-- N2: a workspace keeps the network it went live on, or holds a wallet on.
create or replace function public.orgs_network_locked() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.network is distinct from old.network
     and (old.mode = 'live'
          or exists (select 1 from public.accounts a where a.org_id = old.id and a.circle_wallet_id is not null)) then
    raise exception 'network_locked: a workspace keeps the network it went live on, or holds a wallet on';
  end if;
  return new;
end;
$$;

drop trigger if exists orgs_network_locked on public.orgs;
create trigger orgs_network_locked
  before update of network on public.orgs
  for each row execute function public.orgs_network_locked();

alter table public.payment_intents add column if not exists network text not null default 'arc-testnet';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.payment_intents'::regclass and conname = 'payment_intents_network_check') then
    alter table public.payment_intents add constraint payment_intents_network_check check (network in ('arc-testnet', 'arc-mainnet'));
  end if;
end $$;

comment on column public.payment_intents.network is
  'The network of the workspace that made the payment, taken from orgs.network when the intent is inserted (0075).';

-- N4: an intent's network is its workspace's, whatever the insert says.
create or replace function public.payment_intents_network() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.network := coalesce((select o.network from public.orgs o where o.id = new.org_id), new.network);
  return new;
end;
$$;

drop trigger if exists payment_intents_network on public.payment_intents;
create trigger payment_intents_network
  before insert on public.payment_intents
  for each row execute function public.payment_intents_network();

-- N7: open_numbers for one network (0040's body, filtered).
create or replace function public.open_numbers(p_since timestamptz, p_network text) returns jsonb
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
     where o.network = p_network
  ),
  sides (side) as (values ('customers'), ('ours'), ('total')),
  pay as (
    select s.side, s.listable, p.amount, p.token, lower(p.destination) as payee, p.tx_hash, p.chain,
           coalesce(p.executed_at, p.confirmed_at, p.updated_at) as at
      from public.payment_intents p
      join org_side s on s.id = p.org_id
     where p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed' and p.network = p_network
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
       and p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed' and p.network = p_network
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
       and a.chain = case p_network when 'arc-mainnet' then 'ARC' else 'ARC-TESTNET' end
       and a.balance_synced_at is not null
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'sides', (
      select jsonb_object_agg(sd.side, jsonb_build_object(
        'workspacesOpened',   (select count(*) from org_side o where sd.side in ('total', o.side)
                                  and o.created_at >= coalesce(p_since, '-infinity'::timestamptz)),
        'liveWorkspaces',     (select count(*) from org_side o where sd.side in ('total', o.side) and o.mode = 'live'),
        'people',             case when sd.side = 'total'
                                   then (select count(distinct m.user_id) from public.memberships m join org_side o on o.id = m.org_id)
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

revoke execute on function public.open_numbers(timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_numbers(timestamptz, text) to service_role;

-- N7: open_first_payments for one network (0042's body, filtered).
create or replace function public.open_first_payments(p_since timestamptz, p_network text) returns jsonb
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
     where o.network = p_network
  ),
  sides (side) as (values ('customers'), ('ours'), ('total')),
  first_pay as (
    select p.org_id, min(coalesce(p.executed_at, p.confirmed_at, p.updated_at)) as at
      from public.payment_intents p
     where p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed' and p.network = p_network
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

revoke execute on function public.open_first_payments(timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_first_payments(timestamptz, text) to service_role;

-- N7: open_outcomes for one network (0049's body, filtered).
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

notify pgrst, 'reload schema';

-- Rollback:
-- drop function if exists public.open_outcomes(timestamptz, text);
-- drop function if exists public.open_first_payments(timestamptz, text);
-- drop function if exists public.open_numbers(timestamptz, text);
-- drop trigger if exists payment_intents_network on public.payment_intents;
-- drop function if exists public.payment_intents_network();
-- alter table public.payment_intents drop column if exists network;
-- drop trigger if exists orgs_network_locked on public.orgs;
-- drop function if exists public.orgs_network_locked();
-- alter table public.orgs drop column if exists network;
