-- The agent offers customers a discount to pay early (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
-- C1-C8): while bills are held for want of cash, the agent offers a customer a small discount to pay an open receivable
-- within days, through a one-time link; the customer accepts or declines with no account, and an accepted offer puts the
-- discount on the receivable, ending on its pay-by day, so a payment of the discounted amount through its pay link settles it.
--
-- orgs.customer_offers_on_at / customer_offers_on_by / customer_offers_max_pct: on (when, by whom) and the ceiling, set
-- by set_customer_offers(p_org_id, p_on, p_max_pct, p_by), run by the server's service role for an owner or admin.
-- customer_discount_offers: one open per receivable. Only the link's SHA-256 is kept. The workspace reads its own under
-- RLS; every write goes through the functions below, run by the server's service role, each checking the workspace or
-- the token itself.
-- customer_discount_reviews: the agent's one review of a receivable, claimed before an offer is made (C7). Tenant-scoped.
--
-- customer_discount_eligible(p_org_id, p_invoice_id): an open USDC receivable with no discount, nothing applied to it or
-- matched to it, falling due at least 7 days after today (C2).
-- create_customer_discount_offer(p_org_id, p_invoice_id, p_pct, p_token_hash, p_pay_by): checks the receivable is
-- eligible, withdraws its open offer, and makes the new one with the receivable's amount as it stands, open to the end
-- of the pay-by day (UTC), which must come before the due date.
-- customer_discount_preview(p_token_hash): what the customer's page shows, for an open, unexpired offer only.
-- decide_customer_discount(p_token_hash, p_accept): one step (C5): the offer still open, the receivable still eligible
-- and unchanged; on accept, the receivable's discount set to the offer's, ending on the pay-by day.
-- withdraw_customer_discount_offer(p_org_id, p_offer_id): an open offer withdrawn.
-- settle_customer_discount(p_org_id, p_invoice_id): an accepted offer marked paid, once its receivable is settled (C6).
-- customer_discounts_ready(p_org_id): true once this migration has run; reads nothing.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.orgs
  add column if not exists customer_offers_on_at timestamptz,
  add column if not exists customer_offers_on_by uuid references auth.users(id) on delete set null,
  add column if not exists customer_offers_max_pct numeric(5,2)
    constraint orgs_customer_offers_max_pct_check check (customer_offers_max_pct is null or (customer_offers_max_pct >= 0.5 and customer_offers_max_pct <= 5));

create table if not exists public.customer_discount_offers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  invoice_id       uuid not null,
  counterparty_id  uuid not null,
  discount_pct     numeric(5,2) not null constraint customer_discount_offers_pct_check check (discount_pct >= 0.25 and discount_pct <= 5),
  -- The receivable's amount when the offer was made, and what the customer would pay: an offer is void once the
  -- receivable's amount changes.
  amount           numeric(20,6) not null constraint customer_discount_offers_amount_check check (amount > 0),
  offered_amount   numeric(20,6) not null constraint customer_discount_offers_offered_check check (offered_amount > 0 and offered_amount < amount),
  currency         text not null default 'USDC' constraint customer_discount_offers_currency_check check (currency = 'USDC'),
  token_hash       text not null
                        constraint customer_discount_offers_token_hash_key unique
                        constraint customer_discount_offers_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  status           text not null default 'open'
                        constraint customer_discount_offers_status_check check (status in ('open', 'accepted', 'declined', 'withdrawn', 'paid')),
  pay_by           date not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  decided_at       timestamptz,
  paid_at          timestamptz,
  constraint customer_discount_offers_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint customer_discount_offers_counterparty_fkey foreign key (org_id, counterparty_id) references public.counterparties (org_id, id) on delete cascade,
  constraint customer_discount_offers_decided_check check ((status = 'open') = (decided_at is null)),
  constraint customer_discount_offers_paid_check check ((status = 'paid') = (paid_at is not null))
);

create unique index if not exists customer_discount_offers_one_open on public.customer_discount_offers (org_id, invoice_id) where status = 'open';
create index if not exists customer_discount_offers_org_idx on public.customer_discount_offers (org_id, created_at desc);

alter table public.customer_discount_offers enable row level security;
revoke all privileges on table public.customer_discount_offers from anon, authenticated, vestiarion_tenant;
grant select on table public.customer_discount_offers to vestiarion_tenant;
grant all privileges on table public.customer_discount_offers to service_role;

drop policy if exists tenant_isolation on public.customer_discount_offers;
create policy tenant_isolation on public.customer_discount_offers for select to vestiarion_tenant
  using (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.customer_discount_offers;
create policy tenant_isolation_guard on public.customer_discount_offers as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create table if not exists public.customer_discount_reviews (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  invoice_id   uuid not null,
  action       text not null constraint customer_discount_reviews_action_check check (action in ('offer', 'skip')),
  discount_pct numeric(5,2) constraint customer_discount_reviews_pct_check check (discount_pct is null or (discount_pct >= 0.25 and discount_pct <= 5)),
  offer_id     uuid references public.customer_discount_offers(id) on delete set null,
  decided_at   timestamptz not null default now(),
  emailed_at   timestamptz,
  constraint customer_discount_reviews_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint customer_discount_reviews_one unique (org_id, invoice_id)
);

create index if not exists customer_discount_reviews_offer_idx on public.customer_discount_reviews (offer_id) where offer_id is not null;

alter table public.customer_discount_reviews enable row level security;
revoke all privileges on table public.customer_discount_reviews from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.customer_discount_reviews to vestiarion_tenant;
grant all privileges on table public.customer_discount_reviews to service_role;

drop policy if exists tenant_isolation on public.customer_discount_reviews;
create policy tenant_isolation on public.customer_discount_reviews for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.customer_discount_reviews;
create policy tenant_isolation_guard on public.customer_discount_reviews as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create or replace function public.set_customer_offers(p_org_id uuid, p_on boolean, p_max_pct numeric, p_by uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  if p_on and (p_max_pct is null or p_max_pct < 0.5 or p_max_pct > 5) then
    raise exception 'customer_offers_max_pct: the most to give is from 0.5%% to 5%%';
  end if;
  update public.orgs
     set customer_offers_on_at = case when p_on then coalesce(customer_offers_on_at, now()) else null end,
         customer_offers_on_by = case when p_on then p_by else null end,
         customer_offers_max_pct = case when p_on then round(p_max_pct, 2) else customer_offers_max_pct end
   where id = p_org_id;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

-- Whether a receivable may take an offer (C2): open, in USDC, with no discount, nothing applied to it or matched to it,
-- falling due at least 7 days after today.
create or replace function public.customer_discount_eligible(p_org_id uuid, p_invoice_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.invoices i
     where i.org_id = p_org_id and i.id = p_invoice_id
       and i.direction = 'receivable'
       and i.status in ('pending', 'matched')
       and coalesce(i.currency, 'USDC') = 'USDC'
       and i.early_pay_discount_pct is null
       and i.amount > 0
       and (i.due_date at time zone 'UTC')::date >= ((now() at time zone 'UTC')::date + 7)
       and not exists (select 1 from public.receivable_allocations a where a.org_id = i.org_id and a.invoice_id = i.id)
       and not exists (select 1 from public.incoming_transfers t where t.org_id = i.org_id and t.invoice_id = i.id)
  )
$$;

create or replace function public.create_customer_discount_offer(
  p_org_id     uuid,
  p_invoice_id uuid,
  p_pct        numeric,
  p_token_hash text,
  p_pay_by     date
) returns public.customer_discount_offers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices;
  v_row public.customer_discount_offers;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_customer_discounts:' || p_invoice_id::text));
  if not public.customer_discount_eligible(p_org_id, p_invoice_id) then
    raise exception 'discount_not_eligible: this receivable cannot take a discount offer';
  end if;
  select * into v_invoice from public.invoices where org_id = p_org_id and id = p_invoice_id;
  if p_pay_by < (now() at time zone 'UTC')::date or p_pay_by >= (v_invoice.due_date at time zone 'UTC')::date then
    raise exception 'discount_pay_by: the pay-by day must be from today to the day before the receivable falls due';
  end if;
  update public.customer_discount_offers set status = 'withdrawn', decided_at = now()
   where org_id = p_org_id and invoice_id = p_invoice_id and status = 'open';
  insert into public.customer_discount_offers (org_id, invoice_id, counterparty_id, discount_pct, amount, offered_amount, currency, token_hash, pay_by, expires_at)
  values (p_org_id, p_invoice_id, v_invoice.counterparty_id, p_pct, v_invoice.amount,
          round(v_invoice.amount * (100 - p_pct) / 100, 6), 'USDC', p_token_hash, p_pay_by,
          (p_pay_by + 1)::timestamp at time zone 'UTC' - interval '1 second')
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.customer_discount_preview(p_token_hash text)
returns table (org_name text, counterparty_name text, memo text, amount numeric, offered_amount numeric, currency text,
               discount_pct numeric, due_date timestamptz, pay_by date, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name, c.name, i.memo, f.amount, f.offered_amount, f.currency, f.discount_pct, i.due_date, f.pay_by, f.expires_at
    from public.customer_discount_offers f
    join public.orgs o on o.id = f.org_id
    join public.counterparties c on c.org_id = f.org_id and c.id = f.counterparty_id
    join public.invoices i on i.org_id = f.org_id and i.id = f.invoice_id
   where f.token_hash = p_token_hash and f.status = 'open' and f.expires_at > now()
$$;

create or replace function public.decide_customer_discount(p_token_hash text, p_accept boolean)
returns table (outcome text, offer_id uuid, org_id uuid, invoice_id uuid, discount_pct numeric, offered_amount numeric, pay_by date)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.customer_discount_offers;
begin
  select * into v_offer from public.customer_discount_offers f
   where f.token_hash = p_token_hash and f.status = 'open' and f.expires_at > now()
   for update;
  if not found then
    return query select 'not_valid'::text, null::uuid, null::uuid, null::uuid, null::numeric, null::numeric, null::date;
    return;
  end if;
  if not p_accept then
    update public.customer_discount_offers set status = 'declined', decided_at = now() where id = v_offer.id;
    return query select 'declined'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, v_offer.discount_pct, v_offer.offered_amount, v_offer.pay_by;
    return;
  end if;
  -- The receivable as it was offered: still eligible, and its amount unchanged (C5). Otherwise nothing changes. The
  -- seven days are counted from the offer, not from now: an offer accepted on its last day is still within them.
  perform 1 from public.invoices i where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id for update;
  if not exists (
       select 1 from public.invoices i
        where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id
          and i.direction = 'receivable'
          and i.status in ('pending', 'matched')
          and i.early_pay_discount_pct is null
          and i.amount = v_offer.amount
          and (i.due_date at time zone 'UTC')::date > v_offer.pay_by)
     or exists (select 1 from public.receivable_allocations a where a.org_id = v_offer.org_id and a.invoice_id = v_offer.invoice_id)
     or exists (select 1 from public.incoming_transfers t where t.org_id = v_offer.org_id and t.invoice_id = v_offer.invoice_id) then
    return query select 'changed'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, null::numeric, null::numeric, null::date;
    return;
  end if;
  update public.invoices i
     set early_pay_discount_pct = v_offer.discount_pct,
         discount_due_date = v_offer.pay_by::timestamp at time zone 'UTC' + interval '12 hours'
   where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id;
  update public.customer_discount_offers set status = 'accepted', decided_at = now() where id = v_offer.id;
  return query select 'accepted'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, v_offer.discount_pct, v_offer.offered_amount, v_offer.pay_by;
end;
$$;

create or replace function public.withdraw_customer_discount_offer(p_org_id uuid, p_offer_id uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  update public.customer_discount_offers set status = 'withdrawn', decided_at = now()
   where id = p_offer_id and org_id = p_org_id and status = 'open';
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

-- An accepted offer, paid (C6): only once its receivable is settled.
create or replace function public.settle_customer_discount(p_org_id uuid, p_invoice_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.customer_discount_offers f set status = 'paid', paid_at = now()
   where f.org_id = p_org_id and f.invoice_id = p_invoice_id and f.status = 'accepted'
     and exists (select 1 from public.invoices i where i.org_id = f.org_id and i.id = f.invoice_id and i.status = 'received')
  returning f.id into v_id;
  return v_id;
end;
$$;

create or replace function public.customer_discounts_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.set_customer_offers(uuid, boolean, numeric, uuid) from public, anon, authenticated;
grant execute on function public.set_customer_offers(uuid, boolean, numeric, uuid) to service_role;
revoke execute on function public.customer_discount_eligible(uuid, uuid) from public, anon, authenticated;
grant execute on function public.customer_discount_eligible(uuid, uuid) to service_role;
revoke execute on function public.create_customer_discount_offer(uuid, uuid, numeric, text, date) from public, anon, authenticated;
grant execute on function public.create_customer_discount_offer(uuid, uuid, numeric, text, date) to service_role;
revoke execute on function public.customer_discount_preview(text) from public, anon, authenticated;
grant execute on function public.customer_discount_preview(text) to service_role;
revoke execute on function public.decide_customer_discount(text, boolean) from public, anon, authenticated;
grant execute on function public.decide_customer_discount(text, boolean) to service_role;
revoke execute on function public.withdraw_customer_discount_offer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.withdraw_customer_discount_offer(uuid, uuid) to service_role;
revoke execute on function public.settle_customer_discount(uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_customer_discount(uuid, uuid) to service_role;
revoke execute on function public.customer_discounts_ready(uuid) from public, anon, authenticated;
grant execute on function public.customer_discounts_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.customer_discounts_ready(uuid);
-- drop function if exists public.settle_customer_discount(uuid, uuid);
-- drop function if exists public.withdraw_customer_discount_offer(uuid, uuid);
-- drop function if exists public.decide_customer_discount(text, boolean);
-- drop function if exists public.customer_discount_preview(text);
-- drop function if exists public.create_customer_discount_offer(uuid, uuid, numeric, text, date);
-- drop function if exists public.customer_discount_eligible(uuid, uuid);
-- drop function if exists public.set_customer_offers(uuid, boolean, numeric, uuid);
-- drop table if exists public.customer_discount_reviews;
-- drop table if exists public.customer_discount_offers;
-- alter table public.orgs drop column if exists customer_offers_max_pct, drop column if exists customer_offers_on_by,
--   drop column if exists customer_offers_on_at;
