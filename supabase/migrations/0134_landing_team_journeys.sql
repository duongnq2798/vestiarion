-- Public bill evidence from the team's live mainnet workspaces, never customers' rows.
-- Read-only projection; the sole private output, orgId, is kept server-side for public-key lookup.
-- Ledger times are recording times. A Base payout needs its mint; an Arc burn alone is not payment on Base.
-- Idempotent: the migration runner replays every migration.
create or replace function public.landing_team_journeys() returns jsonb
language sql stable security definer set search_path = ''
as $$
  with eligible as (
    select p.id, p.org_id, p.source_id, p.amount, p.token, p.tx_hash, p.mint_tx_hash,
           p.confirmed_at, p.bridge_fee,
           case when p.destination_chain = 'BASE' then 'base' else 'direct' end as slot,
           row_number() over (
             partition by case when p.destination_chain = 'BASE' then 'base' else 'direct' end
             order by p.confirmed_at desc nulls last, p.id desc
           ) as position
      from public.payment_intents p
      join public.orgs o on o.id = p.org_id
      join public.invoices i on i.org_id = p.org_id and i.id = p.source_id and p.source_type = 'invoice'
      join public.counterparties c on c.org_id = i.org_id and c.id = i.counterparty_id
     where o.mode = 'live' and o.network = 'arc-mainnet' and p.network = 'arc-mainnet'
       and (o.id = '00000000-0000-4000-8000-000000000001'::uuid
            or exists (select 1 from public.platform_team t where t.user_id = o.created_by))
       and not c.sample and i.direction = 'payable' and i.status = 'paid'
       and p.provider = 'circle' and p.provider_mode = 'live' and p.status = 'confirmed'
       and p.token in ('USDC', 'EURC') and p.amount > 0 and p.chain = 'ARC'
       and p.payout_route is distinct from 'gateway'
       and p.tx_hash ~ '^0x[0-9a-fA-F]{64}$'
       and (p.destination_chain is null or p.destination_chain = 'ARC'
            or (p.destination_chain = 'BASE' and p.token = 'USDC' and p.mint_tx_hash ~ '^0x[0-9a-fA-F]{64}$'))
  ), selected as (
    select * from eligible where position = 1
  ), targeted as (
    select s.id as payment_id, l.*
      from selected s join public.ledger_entries l
        on l.org_id = s.org_id and l.detail->>'invoiceId' = s.source_id::text
     where l.action in ('create_invoice','ap_pay','ap_schedule','ap_hold','ap_request_info','ap_flag_fraud','approval_given','approval_paid','ap_reconcile')
  ), transaction_records as (
    select t.payment_id, t.seq,
           s.mint_tx_hash is not null and lower(s.mint_tx_hash) = any(array[
             lower(t.detail->>'txRef'), lower(t.detail->'execution'->>'txRef'), lower(t.detail->'execution'->>'mintTxHash')
           ]) as records_mint
      from targeted t join selected s on s.id = t.payment_id
     where t.action in ('ap_pay','approval_paid','ap_reconcile')
       and (lower(s.tx_hash) = any(array[lower(t.detail->>'txRef'),lower(t.detail->'execution'->>'txRef'),lower(t.detail->'execution'->>'mintTxHash')])
            or (s.mint_tx_hash is not null and lower(s.mint_tx_hash) = any(array[lower(t.detail->>'txRef'),lower(t.detail->'execution'->>'txRef'),lower(t.detail->'execution'->>'mintTxHash')])))
  ), record_bounds as (
    select payment_id, min(seq) as first_record from transaction_records group by payment_id
  ), candidates as (
    select t.*, kind.name as kind, coalesce(r.records_mint, false) as records_mint
      from targeted t join selected s on s.id = t.payment_id
      left join transaction_records r on r.payment_id = t.payment_id and r.seq = t.seq
      left join record_bounds b on b.payment_id = t.payment_id
      cross join lateral (values
        ('received', t.action = 'create_invoice'),
        ('check', t.actor = 'agent' and t.action in ('ap_pay','ap_schedule','ap_hold','ap_request_info','ap_flag_fraud')),
        ('hold', t.actor = 'agent' and t.action in ('ap_pay','ap_schedule','ap_hold','ap_request_info','ap_flag_fraud')
                 and (t.action = 'ap_hold' or t.detail->'guardrailBlocked' = 'true'::jsonb
                 or nullif(coalesce(t.detail->'execution'->>'heldBecause', t.detail->>'heldBecause'), '') is not null)),
        ('approval', t.actor = 'human' and t.action in ('approval_given','approval_paid')),
        ('record', r.seq is not null)
      ) as kind(name, matches)
     where kind.matches
       and (kind.name = 'record' or kind.name = 'received'
            or (b.first_record is not null and t.seq <= b.first_record)
            or (b.first_record is null and t.ts <= s.confirmed_at))
  ), chosen as (
    select distinct on (payment_id, kind) * from candidates
     order by payment_id, kind, (kind = 'record' and records_mint) desc, seq desc
  ), event_objects as (
    select payment_id, jsonb_object_agg(kind, jsonb_build_object(
      'seq', seq, 'recordedAt', ts, 'action', action,
      'link', jsonb_build_object('body_hash',body_hash,'signature',signature,'prev_hash',prev_hash,'hash',hash,'signing_key_id',signing_key_id)
    )) as events from chosen group by payment_id
  ), projected as (
    select s.slot, jsonb_build_object(
      'orgId', s.org_id, 'amount', s.amount, 'currency', s.token, 'network', 'arc-mainnet', 'status', 'paid',
      'received', e.events->'received', 'check', e.events->'check', 'hold', e.events->'hold',
      'approval', e.events->'approval', 'record', e.events->'record',
      'observed', jsonb_build_object(
        'hasPurchaseOrder', case when jsonb_typeof(c.detail->'observed'->'poReference') = 'string'
                                then length(trim(c.detail->'observed'->>'poReference')) > 0 end,
        'goodsReceived', case when jsonb_typeof(c.detail->'observed'->'goodsReceived') = 'boolean' then c.detail->'observed'->'goodsReceived' end,
        'purchaseOrderRequired', case when jsonb_typeof(c.detail->'observed'->'purchaseOrderRequired') = 'boolean' then c.detail->'observed'->'purchaseOrderRequired' end,
        'riskLevel', case when c.detail->'observed'->>'riskLevel' in ('unscreened','clear','medium','high') then c.detail->'observed'->>'riskLevel' end
      ),
      'rule', case when h.detail->>'guardrailRule' ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then h.detail->>'guardrailRule' end,
      'payment', jsonb_build_object(
        'route', case when s.slot = 'base' then 'cctp' else 'direct' end,
        'confirmationRecordedAt', s.confirmed_at, 'txHash', s.tx_hash,
        'mintTxHash', case when s.slot = 'base' then s.mint_tx_hash end,
        'destinationChain', case when s.slot = 'base' then 'BASE' else 'ARC' end,
        'feeUsdc', case when s.slot = 'base' and s.bridge_fee >= 0 then s.bridge_fee end
      )
    ) as value
      from selected s
      left join event_objects e on e.payment_id = s.id
      left join chosen c on c.payment_id = s.id and c.kind = 'check'
      left join chosen h on h.payment_id = s.id and h.kind = 'hold'
  )
  select jsonb_build_object('direct', (select value from projected where slot = 'direct'),
                            'base', (select value from projected where slot = 'base'))
$$;

revoke all on function public.landing_team_journeys() from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.landing_team_journeys() to service_role;
notify pgrst, 'reload schema';

-- Rollback: drop function if exists public.landing_team_journeys();
