-- Receivables paid on Arc (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md §4).
--
-- receivable_links: one public pay link per receivable, its token stored only
-- as a SHA-256, revocable; seen and written only by its own workspace.
--
-- incoming_transfers: each completed inbound transfer Circle reports for a
-- workspace's operating wallet, recorded once (R3), and the receivable it
-- settled, if any. A transfer outlives the invoice it settled: deleting the
-- invoice leaves the transfer, unmatched.
--
-- pay_link_preview(p_token_hash): what the public pay page shows, for the
-- service role only. Only an open or received receivable with a live link is
-- found; the page gets the workspace's and client's names, the amount,
-- currency, due date and memo, and the operating wallet's Arc testnet address
-- (R2). The workspace and invoice ids are for the server, never shown.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_org_id_id_key' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices add constraint invoices_org_id_id_key unique (org_id, id);
  end if;
end $$;

create table if not exists public.receivable_links (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  invoice_id  uuid not null,
  token_hash  text not null
                   constraint receivable_links_token_hash_key unique
                   constraint receivable_links_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  constraint receivable_links_invoice_key unique (org_id, invoice_id),
  constraint receivable_links_invoice_id_org_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade
);

create table if not exists public.incoming_transfers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  circle_tx_id  text not null,
  tx_hash       text,
  from_address  text,
  amount        numeric(20, 6) not null check (amount > 0),
  token         text not null check (token in ('USDC', 'EURC')),
  chain         text not null,
  received_at   timestamptz not null,
  recorded_at   timestamptz not null default now(),
  invoice_id    uuid,
  matched_by    text check (matched_by in ('sender', 'amount', 'person')),
  constraint incoming_transfers_circle_tx_key unique (org_id, circle_tx_id),
  constraint incoming_transfers_invoice_id_org_fkey foreign key (org_id, invoice_id)
    references public.invoices (org_id, id) on delete set null (invoice_id)
);

create index if not exists incoming_transfers_unmatched_idx on public.incoming_transfers (org_id, received_at) where invoice_id is null;

do $$
declare
  t text;
begin
  foreach t in array array['receivable_links', 'incoming_transfers'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from anon, authenticated, vestiarion_tenant', t);
    execute format('grant select, insert, update, delete on table public.%I to vestiarion_tenant', t);
    execute format('grant all privileges on table public.%I to service_role', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I for all to vestiarion_tenant
         using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))', t);
    execute format('drop policy if exists tenant_isolation_guard on public.%I', t);
    execute format(
      'create policy tenant_isolation_guard on public.%I as restrictive for all to vestiarion_tenant
         using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()))', t);
  end loop;
end $$;

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
                      where a.org_id = o.id and a.kind = 'operating' and a.chain = 'ARC-TESTNET' and a.address is not null
                      order by a.created_at
                      limit 1),
           'chain', 'ARC-TESTNET')
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

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.pay_link_preview(text);
-- drop table if exists public.incoming_transfers;
-- drop table if exists public.receivable_links;
