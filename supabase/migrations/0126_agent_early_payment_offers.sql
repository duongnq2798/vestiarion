-- The agent makes early-payment offers (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md AO1-AO5):
-- once an owner or admin turns it on, with the most the business asks, the agent decides which bills it scheduled for
-- later to offer the supplier earlier payment for a discount, and emails the supplier the offer's one-time link.
--
-- orgs.early_offers_on_at / early_offers_on_by / early_offers_max_pct: on (when, by whom) and the ceiling, set by
-- set_agent_early_offers(p_org_id, p_on, p_max_pct, p_by), run by the server's service role for an owner or admin.
-- early_payment_offer_reviews: the agent's one review of a bill, claimed before an offer is made (AO4): offer or skip,
-- the discount, the offer made and when its email went. Tenant-scoped; it goes with its bill.
-- early_payment_offer_reviews_ready(p_org_id): true once this migration has run; reads nothing.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.orgs
  add column if not exists early_offers_on_at timestamptz,
  add column if not exists early_offers_on_by uuid references auth.users(id) on delete set null,
  add column if not exists early_offers_max_pct numeric(5,2)
    constraint orgs_early_offers_max_pct_check check (early_offers_max_pct is null or (early_offers_max_pct >= 0.5 and early_offers_max_pct <= 10));

create table if not exists public.early_payment_offer_reviews (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  invoice_id   uuid not null,
  action       text not null constraint early_payment_offer_reviews_action_check check (action in ('offer', 'skip')),
  discount_pct numeric(5,2) constraint early_payment_offer_reviews_pct_check check (discount_pct is null or (discount_pct >= 0.1 and discount_pct <= 10)),
  offer_id     uuid references public.early_payment_offers(id) on delete set null,
  decided_at   timestamptz not null default now(),
  emailed_at   timestamptz,
  constraint early_payment_offer_reviews_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint early_payment_offer_reviews_one unique (org_id, invoice_id)
);

create index if not exists early_payment_offer_reviews_offer_idx on public.early_payment_offer_reviews (offer_id) where offer_id is not null;

alter table public.early_payment_offer_reviews enable row level security;
revoke all privileges on table public.early_payment_offer_reviews from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.early_payment_offer_reviews to vestiarion_tenant;
grant all privileges on table public.early_payment_offer_reviews to service_role;

drop policy if exists tenant_isolation on public.early_payment_offer_reviews;
create policy tenant_isolation on public.early_payment_offer_reviews for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.early_payment_offer_reviews;
create policy tenant_isolation_guard on public.early_payment_offer_reviews as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create or replace function public.set_agent_early_offers(p_org_id uuid, p_on boolean, p_max_pct numeric, p_by uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  if p_on and (p_max_pct is null or p_max_pct < 0.5 or p_max_pct > 10) then
    raise exception 'early_offers_max_pct: the most to ask is from 0.5%% to 10%%';
  end if;
  update public.orgs
     set early_offers_on_at = case when p_on then coalesce(early_offers_on_at, now()) else null end,
         early_offers_on_by = case when p_on then p_by else null end,
         early_offers_max_pct = case when p_on then round(p_max_pct, 2) else early_offers_max_pct end
   where id = p_org_id;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.early_payment_offer_reviews_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.set_agent_early_offers(uuid, boolean, numeric, uuid) from public, anon, authenticated;
grant execute on function public.set_agent_early_offers(uuid, boolean, numeric, uuid) to service_role;
revoke execute on function public.early_payment_offer_reviews_ready(uuid) from public, anon, authenticated;
grant execute on function public.early_payment_offer_reviews_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.early_payment_offer_reviews_ready(uuid);
-- drop function if exists public.set_agent_early_offers(uuid, boolean, numeric, uuid);
-- drop table if exists public.early_payment_offer_reviews;
-- alter table public.orgs drop column if exists early_offers_max_pct, drop column if exists early_offers_on_by,
--   drop column if exists early_offers_on_at;
