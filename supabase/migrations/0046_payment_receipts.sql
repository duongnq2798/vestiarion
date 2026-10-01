-- Payment receipts (docs/superpowers/specs/2026-10-01-payment-receipts-design.md §4).
--
-- payment_receipts holds a paid invoice's shared receipt: the signed
-- `receipt_shared` ledger entry that states its public facts, the public
-- halves of the keys that verify it and the entry that recorded the payment,
-- and the receipt's one link, stored only as the SHA-256 of its secret (R3).
-- One receipt per invoice; a new link replaces the old one, and revoking it
-- leaves the row with `revoked_at` set.
--
-- The public page reads a receipt by its link through the service-role
-- client; members read and write their own workspace's through RLS.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.
-- It redefines no earlier migration's function.

-- A receipt refers to an invoice of its own workspace: (org_id, invoice_id)
-- → invoices (org_id, id), as 0019 does for every tenant reference.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_org_id_id_key' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices add constraint invoices_org_id_id_key unique (org_id, id);
  end if;
end $$;

create table if not exists public.payment_receipts (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  invoice_id       uuid not null,
  entry_seq        bigint not null,
  public_keys      jsonb not null default '{}'::jsonb,
  token_hash       text not null
                        constraint payment_receipts_token_hash_key unique
                        constraint payment_receipts_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  link_created_at  timestamptz not null default now(),
  revoked_at       timestamptz,
  constraint payment_receipts_invoice_key unique (org_id, invoice_id),
  constraint payment_receipts_invoice_id_org_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade
);

alter table public.payment_receipts enable row level security;
revoke all privileges on table public.payment_receipts from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.payment_receipts to vestiarion_tenant;
grant all privileges on table public.payment_receipts to service_role;

-- The tenant boundary, as 0018 writes it for every tenant table.
drop policy if exists tenant_isolation on public.payment_receipts;
create policy tenant_isolation on public.payment_receipts for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.payment_receipts;
create policy tenant_isolation_guard on public.payment_receipts as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.payment_receipts;
-- alter table public.invoices drop constraint if exists invoices_org_id_id_key;
