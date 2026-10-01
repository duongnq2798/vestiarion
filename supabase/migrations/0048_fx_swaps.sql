-- Paying a EURC invoice from USDC by a swap (docs/superpowers/specs/2026-10-01-eurc-swap-design.md S8).
--
-- fx_swaps holds each swap of USDC for EURC the agent made to pay a EURC
-- invoice through Circle's Stablecoin Service: the figures it was decided on,
-- the Adapter call it sends, and how it ended. The row is written before
-- anything is sent, with the call and the swap's id the Circle keys come
-- from, so a swap whose answer was lost is resumed with the same keys rather
-- than made again. One swap is in flight per invoice at a time.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.fx_swaps (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  invoice_id      uuid not null references public.invoices(id) on delete cascade,
  state           text not null
                       constraint fx_swaps_state_check check (state in ('submitted', 'confirmed', 'failed')),
  usdc_in         numeric(20, 6) not null,
  eurc_minimum    numeric(20, 6) not null,
  eurc_estimated  numeric(20, 6) not null,
  eurc_received   numeric(20, 6),
  usdc_per_eurc   numeric(20, 6) not null,
  cost_percent    numeric(9, 4) not null,
  provider        text,
  adapter         text not null,
  call_data       text not null,
  deadline        timestamptz not null,
  approve_tx_id   text,
  approve_tx_hash text,
  swap_tx_id      text,
  swap_tx_hash    text,
  failure         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists fx_swaps_one_submitted on public.fx_swaps (invoice_id) where state = 'submitted';
create index if not exists fx_swaps_org_invoice on public.fx_swaps (org_id, invoice_id);

alter table public.fx_swaps enable row level security;
revoke all privileges on table public.fx_swaps from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.fx_swaps to vestiarion_tenant;
grant all privileges on table public.fx_swaps to service_role;

drop policy if exists tenant_isolation on public.fx_swaps;
create policy tenant_isolation on public.fx_swaps for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.fx_swaps;
create policy tenant_isolation_guard on public.fx_swaps as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop table if exists public.fx_swaps;
