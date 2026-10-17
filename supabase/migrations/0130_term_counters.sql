-- Suppliers counter the agent's requests for more time (docs/superpowers/specs/2026-10-17-term-requests-follow-up-design.md
-- F5-F7): on a request the agent sent, the supplier may propose fewer days; the agent answers it, and an accepted counter
-- moves the bill's due date by those days and returns it to the agent.
--
-- payment_term_requests.status gains 'countered'; counter_days keeps what the supplier proposed.
-- counter_term_request(p_token_hash, p_days): one step (F5): the request open and unexpired, the counter from 1 day to
-- fewer than asked; the request becomes countered and its link works no more.
-- answer_term_counter(p_org_id, p_request_id, p_accept): one step (F6): a countered request answered; accepted, the bill's
-- due date moves by the counter's days and the bill returns to pending, if it is still eligible with its amount and due
-- date unchanged; declined, or the bill changed, the request is declined.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time. 0128's functions are left as
-- they are, so its re-run meets the signatures it made.

alter table public.payment_term_requests
  add column if not exists counter_days integer
    constraint payment_term_requests_counter_days_check check (counter_days is null or (counter_days >= 1 and counter_days <= 60));

-- Widened only while it lacks 'countered': a re-run never narrows it again.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'payment_term_requests_status_check'
       and conrelid = 'public.payment_term_requests'::regclass
       and pg_get_constraintdef(oid) like '%''countered''%'
  ) then
    alter table public.payment_term_requests drop constraint if exists payment_term_requests_status_check;
    alter table public.payment_term_requests add constraint payment_term_requests_status_check
      check (status in ('open', 'accepted', 'declined', 'withdrawn', 'countered'));
  end if;
end;
$$;

create or replace function public.counter_term_request(p_token_hash text, p_days integer)
returns table (outcome text, request_id uuid, org_id uuid, invoice_id uuid, counter_days integer, days integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.payment_term_requests;
begin
  select * into v_req from public.payment_term_requests r
   where r.token_hash = p_token_hash and r.status = 'open' and r.expires_at > now()
   for update;
  if not found then
    return query select 'not_valid'::text, null::uuid, null::uuid, null::uuid, null::integer, null::integer;
    return;
  end if;
  if p_days is null or p_days < 1 or p_days >= v_req.days then
    return query select 'bad_days'::text, v_req.id, v_req.org_id, v_req.invoice_id, null::integer, v_req.days;
    return;
  end if;
  update public.payment_term_requests r set status = 'countered', counter_days = p_days, decided_at = now() where r.id = v_req.id;
  return query select 'countered'::text, v_req.id, v_req.org_id, v_req.invoice_id, p_days, v_req.days;
end;
$$;

create or replace function public.answer_term_counter(p_org_id uuid, p_request_id uuid, p_accept boolean)
returns table (outcome text, invoice_id uuid, counter_days integer, new_due_date timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.payment_term_requests;
  v_new timestamptz;
begin
  select * into v_req from public.payment_term_requests r
   where r.id = p_request_id and r.org_id = p_org_id and r.status = 'countered'
   for update;
  -- Answered already, by another run: nothing to do (F6).
  if not found then
    return query select 'not_countered'::text, null::uuid, null::integer, null::timestamptz;
    return;
  end if;
  if not p_accept then
    update public.payment_term_requests r set status = 'declined' where r.id = v_req.id;
    return query select 'declined'::text, v_req.invoice_id, v_req.counter_days, null::timestamptz;
    return;
  end if;
  -- The bill as it was when asked: still eligible, its amount and due date unchanged. Otherwise the counter cannot stand.
  perform 1 from public.invoices i where i.org_id = v_req.org_id and i.id = v_req.invoice_id for update;
  if not public.term_request_eligible(v_req.org_id, v_req.invoice_id)
     or not exists (
       select 1 from public.invoices i
        where i.org_id = v_req.org_id and i.id = v_req.invoice_id and i.amount = v_req.amount and i.due_date = v_req.due_date
     ) then
    update public.payment_term_requests r set status = 'declined' where r.id = v_req.id;
    return query select 'bill_changed'::text, v_req.invoice_id, v_req.counter_days, null::timestamptz;
    return;
  end if;
  v_new := v_req.due_date + make_interval(days => v_req.counter_days);
  update public.invoices i
     set due_date = v_new,
         status = 'pending',
         decided_at = null
   where i.org_id = v_req.org_id and i.id = v_req.invoice_id;
  update public.payment_term_requests r
     set status = 'accepted', days = v_req.counter_days, new_due_date = v_new, decided_at = now()
   where r.id = v_req.id;
  return query select 'accepted'::text, v_req.invoice_id, v_req.counter_days, v_new;
end;
$$;

revoke execute on function public.counter_term_request(text, integer) from public, anon, authenticated;
grant execute on function public.counter_term_request(text, integer) to service_role;
revoke execute on function public.answer_term_counter(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.answer_term_counter(uuid, uuid, boolean) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.answer_term_counter(uuid, uuid, boolean);
-- drop function if exists public.counter_term_request(text, integer);
-- alter table public.payment_term_requests drop constraint if exists payment_term_requests_status_check;
-- alter table public.payment_term_requests add constraint payment_term_requests_status_check
--   check (status in ('open', 'accepted', 'declined', 'withdrawn'));
-- alter table public.payment_term_requests drop column if exists counter_days;
