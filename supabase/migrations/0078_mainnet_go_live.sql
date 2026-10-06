-- Arc mainnet behind a switch (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M3, M11).
--
-- 1. A payee may be on ARC, Arc mainnet's chain, whatever its role; the Sepolia chains stay vendor-only (0044). 0044's
--    rewrite of unknown chains keeps ARC, so db:migrate's re-run of it leaves an ARC payee as it is.
-- 2. A workspace's network is fixed once it has any account (0075's lock, widened). createWorkspace sets it right after
--    create_org, before the first account, so a sandbox whose account rows name ARC-TESTNET can no longer be moved to
--    Arc mainnet by hand.
-- 3. The payment links name the workspace's own chain: ARC on Arc mainnet, ARC-TESTNET on Arc testnet (0050, 0053).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.counterparties drop constraint if exists counterparties_chain_check;
alter table public.counterparties
  add constraint counterparties_chain_check
  check (chain in ('ARC-TESTNET', 'ARC', 'BASE-SEPOLIA', 'ARB-SEPOLIA', 'ETH-SEPOLIA') and (chain in ('ARC-TESTNET', 'ARC') or role = 'vendor'));

create or replace function public.orgs_network_locked() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.network is distinct from old.network
     and (old.mode = 'live'
          or exists (select 1 from public.accounts a where a.org_id = old.id)) then
    raise exception 'network_locked: a workspace keeps the network it was created on once it has an account';
  end if;
  return new;
end;
$$;

-- 0050's pay_link_preview, paying into the operating account on the workspace's own chain, and naming it.
create or replace function public.pay_link_preview(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'orgId', o.id,
           'invoiceId', i.id,
           'createdBy', l.created_by,
           'orgName', o.name,
           'clientName', c.name,
           'amount', i.amount,
           'currency', i.currency,
           -- Due dates are UTC days (intake writes noon UTC); the day, whatever the session's time zone.
           'dueDate', to_char(i.due_date at time zone 'UTC', 'YYYY-MM-DD'),
           'memo', i.memo,
           'status', case when i.status in ('received', 'paid') then 'received' else 'open' end,
           'payTo', (select a.address
                       from public.accounts a
                      where a.org_id = o.id and a.kind = 'operating' and a.chain = case o.network when 'arc-mainnet' then 'ARC' else 'ARC-TESTNET' end and a.address is not null
                      order by a.created_at
                      limit 1),
           'chain', case o.network when 'arc-mainnet' then 'ARC' else 'ARC-TESTNET' end)
    from public.receivable_links l
    join public.invoices i on i.org_id = l.org_id and i.id = l.invoice_id
    join public.orgs o on o.id = l.org_id
    join public.counterparties c on c.id = i.counterparty_id
   where l.token_hash = p_token_hash
     and l.revoked_at is null
     and i.direction = 'receivable'
     and i.status <> 'rejected'
$$;

revoke all on function public.pay_link_preview(text) from public, anon, authenticated;
grant execute on function public.pay_link_preview(text) to service_role;

-- 0053's payee_link_status, naming the workspace's own chain for a payee that has none.
create or replace function public.payee_link_status(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'orgName', o.name,
           'payeeName', c.name,
           'chain', coalesce(c.chain, case o.network when 'arc-mainnet' then 'ARC' else 'ARC-TESTNET' end),
           'linkState', case when l.used_at is null then 'open' else 'used' end,
           'expiresAt', l.expires_at,
           'usedAt', l.used_at,
           'statusUntil', case when l.used_at is null then l.expires_at else l.used_at + interval '30 days' end,
           'address', c.address,
           'addressConfirmed',
             c.address is not null
             and (c.address_changed_at is null
                  or (c.address_confirmed_at is not null and c.address_confirmed_at >= c.address_changed_at)),
           'payments', coalesce((
             select jsonb_agg(p.item order by p.created_at)
               from (
                 select q.item, q.created_at
                   from (
                     select jsonb_build_object(
                              'kind', 'milestone', 'title', m.title, 'amount', m.amount, 'currency', 'USDC',
                              'status', m.status, 'txRef', m.tx_ref, 'settledAt', m.settled_at, 'scheduledFor', null
                            ) as item,
                            m.created_at, m.status, m.settled_at
                       from public.milestones m
                      where m.org_id = l.org_id and m.contractor_id = c.id
                     union all
                     select jsonb_build_object(
                              'kind', 'invoice', 'title', coalesce(i.memo, 'Invoice'), 'amount', i.amount,
                              'currency', coalesce(i.currency, 'USDC'), 'status', i.status, 'txRef', i.tx_ref,
                              'settledAt', i.settled_at, 'scheduledFor', i.scheduled_for
                            ),
                            i.created_at, i.status, i.settled_at
                       from public.invoices i
                      where i.org_id = l.org_id and i.counterparty_id = c.id and i.direction = 'payable'
                   ) q
                  where q.status not in ('rejected', 'received')
                    and (q.status <> 'paid' or q.settled_at >= l.created_at - interval '1 day')
                  order by q.created_at desc
                  limit 10
               ) p
           ), '[]'::jsonb)
         )
    from public.payee_links l
    join public.orgs o on o.id = l.org_id
    join public.counterparties c on c.org_id = l.org_id and c.id = l.counterparty_id
   where l.token_hash = p_token_hash
     and l.revoked_at is null
     and ((l.used_at is null and l.expires_at > now())
          or (l.used_at is not null and l.used_at > now() - interval '30 days'))
$$;

revoke execute on function public.payee_link_status(text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.payee_link_status(text) to service_role;

notify pgrst, 'reload schema';

-- Rollback (by hand, never by migrate.ts): restore 0044's counterparties_chain_check, 0075's orgs_network_locked, and
-- 0050's and 0053's function bodies; then remove ARC from 0044's rewrite list.
