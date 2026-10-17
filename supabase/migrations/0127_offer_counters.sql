-- Suppliers counter the agent's early-payment offers (docs/superpowers/specs/2026-10-17-offer-counters-design.md N1-N5):
-- on an offer the agent made, the supplier may propose a smaller discount; the agent answers it, and an accepted counter
-- puts that discount on the bill, ending today, for the agent to pay it.
--
-- early_payment_offers.status gains 'countered'; counter_pct keeps what the supplier proposed.
-- early_payment_offer_by_agent(p_token_hash): whether an open offer is the agent's, so its page offers the counter (N1).
-- counter_early_payment_offer(p_token_hash, p_pct): one step (N2): the offer open, unexpired and the agent's, the counter
-- under its discount; the offer becomes countered and its link works no more.
-- answer_early_payment_counter(p_org_id, p_offer_id, p_accept): one step (N5): a countered offer answered; accepted, the
-- bill takes the counter as its discount, ending today (UTC), and returns to pending, if it is still eligible and its
-- amount unchanged; declined, or the bill changed, the offer is declined.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time. 0125's functions are left as
-- they are, so its re-run meets the signatures it made.

alter table public.early_payment_offers
  add column if not exists counter_pct numeric(5,2)
    constraint early_payment_offers_counter_pct_check check (counter_pct is null or (counter_pct >= 0.1 and counter_pct <= 10));

-- Widened only while it lacks 'countered': a re-run never narrows it again.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'early_payment_offers_status_check'
       and conrelid = 'public.early_payment_offers'::regclass
       and pg_get_constraintdef(oid) like '%''countered''%'
  ) then
    alter table public.early_payment_offers drop constraint if exists early_payment_offers_status_check;
    alter table public.early_payment_offers add constraint early_payment_offers_status_check
      check (status in ('open', 'accepted', 'declined', 'withdrawn', 'countered'));
  end if;
end;
$$;

create or replace function public.early_payment_offer_by_agent(p_token_hash text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.early_payment_offers f
      join public.early_payment_offer_reviews r on r.offer_id = f.id and r.org_id = f.org_id
     where f.token_hash = p_token_hash and f.status = 'open' and f.expires_at > now()
  );
$$;

create or replace function public.counter_early_payment_offer(p_token_hash text, p_pct numeric)
returns table (outcome text, offer_id uuid, org_id uuid, invoice_id uuid, counter_pct numeric, discount_pct numeric, currency text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.early_payment_offers;
  v_pct numeric;
begin
  select * into v_offer from public.early_payment_offers f
   where f.token_hash = p_token_hash and f.status = 'open' and f.expires_at > now()
   for update;
  if not found then
    return query select 'not_valid'::text, null::uuid, null::uuid, null::uuid, null::numeric, null::numeric, null::text;
    return;
  end if;
  -- The agent negotiates its own offers only: a person's terms are a person's (N1).
  if not exists (select 1 from public.early_payment_offer_reviews r where r.offer_id = v_offer.id and r.org_id = v_offer.org_id) then
    return query select 'not_agent'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, null::numeric, v_offer.discount_pct, v_offer.currency;
    return;
  end if;
  v_pct := round(p_pct, 2);
  if v_pct is null or v_pct < 0.1 or v_pct >= v_offer.discount_pct then
    return query select 'bad_pct'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, null::numeric, v_offer.discount_pct, v_offer.currency;
    return;
  end if;
  update public.early_payment_offers f set status = 'countered', counter_pct = v_pct, decided_at = now() where f.id = v_offer.id;
  return query select 'countered'::text, v_offer.id, v_offer.org_id, v_offer.invoice_id, v_pct, v_offer.discount_pct, v_offer.currency;
end;
$$;

create or replace function public.answer_early_payment_counter(p_org_id uuid, p_offer_id uuid, p_accept boolean)
returns table (outcome text, invoice_id uuid, counter_pct numeric, offered_amount numeric, currency text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.early_payment_offers;
  v_offered numeric;
begin
  select * into v_offer from public.early_payment_offers f
   where f.id = p_offer_id and f.org_id = p_org_id and f.status = 'countered'
   for update;
  -- Answered already, by another run: nothing to do (N5).
  if not found then
    return query select 'not_countered'::text, null::uuid, null::numeric, null::numeric, null::text;
    return;
  end if;
  if not p_accept then
    update public.early_payment_offers f set status = 'declined' where f.id = v_offer.id;
    return query select 'declined'::text, v_offer.invoice_id, v_offer.counter_pct, null::numeric, v_offer.currency;
    return;
  end if;
  -- The bill as it was offered: still eligible, and its amount unchanged. Otherwise the counter cannot stand.
  perform 1 from public.invoices i where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id for update;
  if not public.early_payment_offer_eligible(v_offer.org_id, v_offer.invoice_id)
     or not exists (select 1 from public.invoices i where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id and i.amount = v_offer.amount) then
    update public.early_payment_offers f set status = 'declined' where f.id = v_offer.id;
    return query select 'bill_changed'::text, v_offer.invoice_id, v_offer.counter_pct, null::numeric, v_offer.currency;
    return;
  end if;
  v_offered := round(v_offer.amount * (100 - v_offer.counter_pct) / 100, 6);
  update public.invoices i
     set early_pay_discount_pct = v_offer.counter_pct,
         discount_due_date = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '12 hours',
         status = 'pending',
         scheduled_for = null,
         decided_at = null
   where i.org_id = v_offer.org_id and i.id = v_offer.invoice_id;
  update public.early_payment_offers f
     set status = 'accepted', discount_pct = v_offer.counter_pct, offered_amount = v_offered, decided_at = now()
   where f.id = v_offer.id;
  return query select 'accepted'::text, v_offer.invoice_id, v_offer.counter_pct, v_offered, v_offer.currency;
end;
$$;

revoke execute on function public.early_payment_offer_by_agent(text) from public, anon, authenticated;
grant execute on function public.early_payment_offer_by_agent(text) to service_role;
revoke execute on function public.counter_early_payment_offer(text, numeric) from public, anon, authenticated;
grant execute on function public.counter_early_payment_offer(text, numeric) to service_role;
revoke execute on function public.answer_early_payment_counter(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.answer_early_payment_counter(uuid, uuid, boolean) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.answer_early_payment_counter(uuid, uuid, boolean);
-- drop function if exists public.counter_early_payment_offer(text, numeric);
-- drop function if exists public.early_payment_offer_by_agent(text);
-- alter table public.early_payment_offers drop constraint if exists early_payment_offers_status_check;
-- alter table public.early_payment_offers add constraint early_payment_offers_status_check
--   check (status in ('open', 'accepted', 'declined', 'withdrawn'));
-- alter table public.early_payment_offers drop column if exists counter_pct;
