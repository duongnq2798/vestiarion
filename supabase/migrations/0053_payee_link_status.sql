-- What a payee's link shows (docs/superpowers/specs/2026-10-02-freelancer-journey-design.md R1, R2).
--
-- A usable link, or one used within the last 30 days, answers with one JSON object: the business's
-- and the payee's names, the payee's chain, the link's state, the address on file and whether a
-- person has confirmed it, and the payee's payments. Any other link (revoked, expired before use,
-- used more than 30 days ago, unknown) answers null. It reads; it changes nothing.
--
-- The payments are the payee's milestones and payables that are open (not rejected, not paid), and
-- those paid since the link was made (less a day), newest ten. A hold's reason is never returned.
--
-- Definer, service role only, like the other payee-link functions (0039). Idempotent.

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
           'chain', coalesce(c.chain, 'ARC-TESTNET'),
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

-- Rollback:
-- drop function if exists public.payee_link_status(text);
