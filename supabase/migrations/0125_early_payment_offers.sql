-- Early-payment offers (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E3-E7): an owner or admin
-- offers a supplier earlier payment for a discount, through a one-time link; the supplier accepts or declines with no
-- account, and an accepted offer puts the discount on the bill, ending today, for the agent to pay it.
--
-- early_payment_offers: one open per invoice. Only the link's SHA-256 is kept. The workspace reads its own under RLS;
-- every write goes through the functions below, run by the server's service role, each checking the workspace or the
-- token itself.
--
-- create_early_payment_offer(p_org_id, p_invoice_id, p_pct, p_token_hash, p_by, p_expires_at): checks the bill is
-- eligible (E1), withdraws its open offer, and makes the new one with the bill's amount as it stands.
-- early_payment_offer_preview(p_token_hash): what the supplier's page shows, for an open, unexpired offer only.
-- decide_early_payment_offer(p_token_hash, p_accept): one step (E5): the offer still open, the bill still eligible and
-- unchanged; on accept, the bill's discount set to the offer's, ending today (UTC), and a scheduled bill back to pending.
-- withdraw_early_payment_offer(p_org_id, p_offer_id, p_by): an open offer withdrawn.
-- early_payment_offers_ready(p_org_id): true once this migration has run; reads nothing.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.early_payment_offers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  invoice_id       uuid not null,
  counterparty_id  uuid not null,
  discount_pct     numeric(5,2) not null constraint early_payment_offers_pct_check check (discount_pct >= 0.1 and discount_pct <= 10),
  -- The bill's amount when the offer was made, and what the supplier would receive: an offer is void once the bill's
  -- amount changes.
  amount           numeric(20,6) not null constraint early_payment_offers_amount_check check (amount > 0),
  offered_amount   numeric(20,6) not null constraint early_payment_offers_offered_check check (offered_amount > 0 and offered_amount < amount),
  currency         text not null default 'USDC' constraint early_payment_offers_currency_check check (currency in ('USDC', 'EURC')),
  token_hash       text not null
                        constraint early_payment_offers_token_hash_key unique
                        constraint early_payment_offers_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  status           text not null default 'open'
                        constraint early_payment_offers_status_check check (status in ('open', 'accepted', 'declined', 'withdrawn')),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  decided_at       timestamptz,
  constraint early_payment_offers_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint early_payment_offers_counterparty_fkey foreign key (org_id, counterparty_id) references public.counterparties (org_id, id) on delete cascade,
  constraint early_payment_offers_decided_check check ((status = 'open') = (decided_at is null))
);

create unique index if not exists early_payment_offers_one_open on public.early_payment_offers (org_id, invoice_id) where status = 'open';
create index if not exists early_payment_offers_org_idx on public.early_payment_offers (org_id, created_at desc);

alter table public.early_payment_offers enable row level security;
revoke all privileges on table public.early_payment_offers from anon, authenticated, vestiarion_tenant;
grant select on table public.early_payment_offers to vestiarion_tenant;
grant all privileges on table public.early_payment_offers to service_role;

drop policy if exists tenant_isolation on public.early_payment_offers;
create policy tenant_isolation on public.early_payment_offers for select to vestiarion_tenant
  using (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.early_payment_offers;
create policy tenant_isolation_guard on public.early_payment_offers as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- Whether a bill may take an offer (E1): a payable, scheduled or not decided yet, with no discount and no payment
-- started, falling due at least 3 days after now.
create or replace function public.early_payment_offer_eligible(p_org_id uuid, p_invoice_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.invoices i
     where i.org_id = p_org_id and i.id = p_invoice_id
       and i.direction = 'payable'
       and i.status in ('scheduled', 'pending')
       and i.early_pay_discount_pct is null
       and i.amount > 0
       and (i.due_date at time zone 'UTC')::date >= ((now() at time zone 'UTC')::date + 3)
       and not exists (
         select 1 from public.payment_intents p
          where p.org_id = i.org_id and p.source_type = 'invoice' and p.source_id = i.id
       )
  )
$$;

create or replace function public.create_early_payment_offer(
  p_org_id     uuid,
  p_invoice_id uuid,
  p_pct        numeric,
  p_token_hash text,
  p_by         uuid,
  p_expires_at timestamptz
) returns public.early_payment_offers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices;
  v_row public.early_payment_offers;
  v_expires timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_early_payment_offers:' || p_invoice_id::text));
  if not public.early_payment_offer_eligible(p_org_id, p_invoice_id) then
    raise exception 'offer_not_eligible: this bill cannot take an early-payment offer';
  end if;
  select * into v_invoice from public.invoices where org_id = p_org_id and id = p_invoice_id;
  -- Open until the day before the bill falls due, when that comes before the asked expiry.
  v_expires := least(p_expires_at, ((v_invoice.due_date at time zone 'UTC')::date - 1)::timestamp at time zone 'UTC' + interval '23 hours 59 minutes');
  update public.early_payment_offers set status = 'withdrawn', decided_at = now()
   where org_id = p_org_id and invoice_id = p_invoice_id and status = 'open';
  insert into public.early_payment_offers (org_id, invoice_id, counterparty_id, discount_pct, amount, offered_amount, currency, token_hash, created_by, expires_at)
  values (p_org_id, p_invoice_id, v_invoice.counterparty_id, p_pct, v_invoice.amount,
          round(v_invoice.amount * (100 - p_pct) / 100, 6), coalesce(v_invoice.currency, 'USDC'), p_token_hash, p_by, v_expires)
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.early_payment_offer_preview(p_token_hash text)
returns table (org_name text, counterparty_name text, memo text, amount numeric, offered_amount numeric, currency text,
               discount_pct numeric, due_date timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name, c.name, i.memo, f.amount, f.offered_amount, f.currency, f.discount_pct, i.due_date, f.expires_at
    from public.early_payment_offers f
    join public.orgs o on o.id = f.org_id
    join public.counterparties c on c.org_id = f.org_id and c.id = f.counterparty_id
    join public.invoices i on i.org_id = f.org_id and i.id = f.invoice_id
   where f.token_hash = p_token_hash and f.status = 'open' and f.expires_at > now()
$$;

create or replace function public.decide_early_payment_offer(p_token_hash text, p_accept boolean)
returns table (outcome text, offer_id uuid, org_id uuid, invoice_id uuid, discount_pct numeric, offered_amount numeric, currency text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.early_payment_offers;
begin
  select * into v_offer from public.early_payment_offers f
   where f.token_hash = p_token_hash and f.status = 'open' and f.expires_at > now()
   for update;
  if not found then
    return query select 'not_valid'::text, null::uuid, null::uuid, null::uuid, null::numeric, null::numeric, null::text;
    return;
  end if;
  if not p_accept then
    update public.early_payment_offers set status = 'declined', decided_at = now() where id = v_offer.id;
    return query select 'declined'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, v_offer.discount_pct, v_offer.offered_amount, v_offer.currency;
    return;
  end if;
  -- The bill as it was offered: still eligible, and its amount unchanged (E5). Otherwise nothing changes.
  perform 1 from public.invoices i where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id for update;
  if not public.early_payment_offer_eligible(v_offer.org_id, v_offer.invoice_id)
     or not exists (select 1 from public.invoices i where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id and i.amount = v_offer.amount) then
    return query select 'bill_changed'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, null::numeric, null::numeric, null::text;
    return;
  end if;
  update public.invoices i
     set early_pay_discount_pct = v_offer.discount_pct,
         discount_due_date = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '12 hours',
         status = 'pending',
         scheduled_for = null,
         decided_at = null
   where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id;
  update public.early_payment_offers set status = 'accepted', decided_at = now() where id = v_offer.id;
  return query select 'accepted'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, v_offer.discount_pct, v_offer.offered_amount, v_offer.currency;
end;
$$;

create or replace function public.withdraw_early_payment_offer(p_org_id uuid, p_offer_id uuid, p_by uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  update public.early_payment_offers set status = 'withdrawn', decided_at = now()
   where id = p_offer_id and org_id = p_org_id and status = 'open';
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.early_payment_offers_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.early_payment_offer_eligible(uuid, uuid) from public, anon, authenticated;
grant execute on function public.early_payment_offer_eligible(uuid, uuid) to service_role;
revoke execute on function public.create_early_payment_offer(uuid, uuid, numeric, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.create_early_payment_offer(uuid, uuid, numeric, text, uuid, timestamptz) to service_role;
revoke execute on function public.early_payment_offer_preview(text) from public, anon, authenticated;
grant execute on function public.early_payment_offer_preview(text) to service_role;
revoke execute on function public.decide_early_payment_offer(text, boolean) from public, anon, authenticated;
grant execute on function public.decide_early_payment_offer(text, boolean) to service_role;
revoke execute on function public.withdraw_early_payment_offer(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.withdraw_early_payment_offer(uuid, uuid, uuid) to service_role;
revoke execute on function public.early_payment_offers_ready(uuid) from public, anon, authenticated;
grant execute on function public.early_payment_offers_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.early_payment_offers_ready(uuid);
-- drop function if exists public.withdraw_early_payment_offer(uuid, uuid, uuid);
-- drop function if exists public.decide_early_payment_offer(text, boolean);
-- drop function if exists public.early_payment_offer_preview(text);
-- drop function if exists public.create_early_payment_offer(uuid, uuid, numeric, text, uuid, timestamptz);
-- drop function if exists public.early_payment_offer_eligible(uuid, uuid);
-- drop table if exists public.early_payment_offers;
