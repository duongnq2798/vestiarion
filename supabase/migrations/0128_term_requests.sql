-- The agent asks suppliers for more time (docs/superpowers/specs/2026-10-17-term-requests-design.md X1-X7): when a bill is
-- held because the operating wallet cannot pay it, the agent emails the supplier a one-time link asking to pay the same
-- amount on a later day; a supplier who agrees moves the due date, and the agent decides the bill again.
--
-- orgs.term_requests_on_at / term_requests_on_by / term_requests_max_days: on (when, by whom) and the most days asked,
-- set by set_term_requests(p_org_id, p_on, p_max_days, p_by), run by the server's service role for an owner or admin.
-- payment_term_requests: one open per invoice; only the link's SHA-256 is kept. The workspace reads its own under RLS;
-- every write goes through the functions below, run by the service role, each checking the workspace or the token.
-- payment_term_request_reviews: the agent's one review of a bill, claimed before a request is made (X6).
--
-- term_request_eligible(p_org_id, p_invoice_id): a held payable with an amount, and no payment started.
-- create_term_request(p_org_id, p_invoice_id, p_days, p_token_hash, p_expires_at): checks the bill is eligible, withdraws
-- its open request, and makes the new one, the new due date being the due date plus the days.
-- term_request_preview(p_token_hash): what the supplier's page shows, for an open, unexpired request only.
-- decide_term_request(p_token_hash, p_accept): one step (X5): the request still open, the bill still eligible and
-- unchanged (amount and due date); agreed, the due date moves to the new one and the bill returns to pending.
-- withdraw_term_request(p_org_id, p_request_id): an open request withdrawn.
-- term_requests_ready(p_org_id): true once this migration has run; reads nothing.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.orgs
  add column if not exists term_requests_on_at timestamptz,
  add column if not exists term_requests_on_by uuid references auth.users(id) on delete set null,
  add column if not exists term_requests_max_days integer
    constraint orgs_term_requests_max_days_check check (term_requests_max_days is null or (term_requests_max_days >= 3 and term_requests_max_days <= 30));

create table if not exists public.payment_term_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  invoice_id       uuid not null,
  counterparty_id  uuid not null,
  days             integer not null constraint payment_term_requests_days_check check (days >= 1 and days <= 60),
  -- The bill as it stood when asked: a request is void once its amount or due date changes.
  amount           numeric(20,6) not null constraint payment_term_requests_amount_check check (amount > 0),
  due_date         timestamptz not null,
  new_due_date     timestamptz not null,
  currency         text not null default 'USDC' constraint payment_term_requests_currency_check check (currency in ('USDC', 'EURC')),
  token_hash       text not null
                        constraint payment_term_requests_token_hash_key unique
                        constraint payment_term_requests_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  status           text not null default 'open'
                        constraint payment_term_requests_status_check check (status in ('open', 'accepted', 'declined', 'withdrawn')),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  decided_at       timestamptz,
  constraint payment_term_requests_later_check check (new_due_date > due_date),
  constraint payment_term_requests_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint payment_term_requests_counterparty_fkey foreign key (org_id, counterparty_id) references public.counterparties (org_id, id) on delete cascade,
  constraint payment_term_requests_decided_check check ((status = 'open') = (decided_at is null))
);

create unique index if not exists payment_term_requests_one_open on public.payment_term_requests (org_id, invoice_id) where status = 'open';
create index if not exists payment_term_requests_org_idx on public.payment_term_requests (org_id, created_at desc);

alter table public.payment_term_requests enable row level security;
revoke all privileges on table public.payment_term_requests from anon, authenticated, vestiarion_tenant;
grant select on table public.payment_term_requests to vestiarion_tenant;
grant all privileges on table public.payment_term_requests to service_role;

drop policy if exists tenant_isolation on public.payment_term_requests;
create policy tenant_isolation on public.payment_term_requests for select to vestiarion_tenant
  using (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.payment_term_requests;
create policy tenant_isolation_guard on public.payment_term_requests as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create table if not exists public.payment_term_request_reviews (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  invoice_id   uuid not null,
  action       text not null constraint payment_term_request_reviews_action_check check (action in ('ask', 'skip')),
  days         integer constraint payment_term_request_reviews_days_check check (days is null or (days >= 1 and days <= 60)),
  request_id   uuid references public.payment_term_requests(id) on delete set null,
  decided_at   timestamptz not null default now(),
  emailed_at   timestamptz,
  constraint payment_term_request_reviews_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint payment_term_request_reviews_one unique (org_id, invoice_id)
);

alter table public.payment_term_request_reviews enable row level security;
revoke all privileges on table public.payment_term_request_reviews from anon, authenticated, vestiarion_tenant;
grant select, insert, update, delete on table public.payment_term_request_reviews to vestiarion_tenant;
grant all privileges on table public.payment_term_request_reviews to service_role;

drop policy if exists tenant_isolation on public.payment_term_request_reviews;
create policy tenant_isolation on public.payment_term_request_reviews for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.payment_term_request_reviews;
create policy tenant_isolation_guard on public.payment_term_request_reviews as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create or replace function public.term_request_eligible(p_org_id uuid, p_invoice_id uuid) returns boolean
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
       and i.status = 'held'
       and i.amount > 0
       and not exists (
         select 1 from public.payment_intents p
          where p.org_id = i.org_id and p.source_type = 'invoice' and p.source_id = i.id
       )
  )
$$;

create or replace function public.create_term_request(
  p_org_id     uuid,
  p_invoice_id uuid,
  p_days       integer,
  p_token_hash text,
  p_expires_at timestamptz
) returns public.payment_term_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices;
  v_row public.payment_term_requests;
  v_new_due timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_term_requests:' || p_invoice_id::text));
  if not public.term_request_eligible(p_org_id, p_invoice_id) then
    raise exception 'term_request_not_eligible: this bill cannot take a request for more time';
  end if;
  select * into v_invoice from public.invoices where org_id = p_org_id and id = p_invoice_id;
  v_new_due := v_invoice.due_date + make_interval(days => p_days);
  update public.payment_term_requests set status = 'withdrawn', decided_at = now()
   where org_id = p_org_id and invoice_id = p_invoice_id and status = 'open';
  insert into public.payment_term_requests (org_id, invoice_id, counterparty_id, days, amount, due_date, new_due_date, currency, token_hash, expires_at)
  values (p_org_id, p_invoice_id, v_invoice.counterparty_id, p_days, v_invoice.amount, v_invoice.due_date, v_new_due,
          coalesce(v_invoice.currency, 'USDC'), p_token_hash, least(p_expires_at, v_new_due))
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.term_request_preview(p_token_hash text)
returns table (org_name text, counterparty_name text, memo text, amount numeric, currency text, due_date timestamptz,
               new_due_date timestamptz, days integer, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name, c.name, i.memo, r.amount, r.currency, r.due_date, r.new_due_date, r.days, r.expires_at
    from public.payment_term_requests r
    join public.orgs o on o.id = r.org_id
    join public.counterparties c on c.org_id = r.org_id and c.id = r.counterparty_id
    join public.invoices i on i.org_id = r.org_id and i.id = r.invoice_id
   where r.token_hash = p_token_hash and r.status = 'open' and r.expires_at > now()
$$;

create or replace function public.decide_term_request(p_token_hash text, p_accept boolean)
returns table (outcome text, request_id uuid, org_id uuid, invoice_id uuid, days integer, new_due_date timestamptz)
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
    return query select 'not_valid'::text, null::uuid, null::uuid, null::uuid, null::integer, null::timestamptz;
    return;
  end if;
  if not p_accept then
    update public.payment_term_requests r set status = 'declined', decided_at = now() where r.id = v_req.id;
    return query select 'declined'::text, v_req.id, v_req.org_id, v_req.invoice_id, v_req.days, v_req.new_due_date;
    return;
  end if;
  -- The bill as it was when asked: still eligible, its amount and due date unchanged (X5). Otherwise nothing changes.
  perform 1 from public.invoices i where i.org_id = v_req.org_id and i.id = v_req.invoice_id for update;
  if not public.term_request_eligible(v_req.org_id, v_req.invoice_id)
     or not exists (
       select 1 from public.invoices i
        where i.org_id = v_req.org_id and i.id = v_req.invoice_id and i.amount = v_req.amount and i.due_date = v_req.due_date
     ) then
    return query select 'bill_changed'::text, v_req.id, v_req.org_id, v_req.invoice_id, null::integer, null::timestamptz;
    return;
  end if;
  update public.invoices i
     set due_date = v_req.new_due_date,
         status = 'pending',
         decided_at = null
   where i.org_id = v_req.org_id and i.id = v_req.invoice_id;
  update public.payment_term_requests r set status = 'accepted', decided_at = now() where r.id = v_req.id;
  return query select 'accepted'::text, v_req.id, v_req.org_id, v_req.invoice_id, v_req.days, v_req.new_due_date;
end;
$$;

create or replace function public.withdraw_term_request(p_org_id uuid, p_request_id uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  update public.payment_term_requests set status = 'withdrawn', decided_at = now()
   where id = p_request_id and org_id = p_org_id and status = 'open';
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.set_term_requests(p_org_id uuid, p_on boolean, p_max_days integer, p_by uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  if p_on and (p_max_days is null or p_max_days < 3 or p_max_days > 30) then
    raise exception 'term_requests_max_days: the most days to ask for is from 3 to 30';
  end if;
  update public.orgs
     set term_requests_on_at = case when p_on then coalesce(term_requests_on_at, now()) else null end,
         term_requests_on_by = case when p_on then p_by else null end,
         term_requests_max_days = case when p_on then p_max_days else term_requests_max_days end
   where id = p_org_id;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.term_requests_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.term_request_eligible(uuid, uuid) from public, anon, authenticated;
grant execute on function public.term_request_eligible(uuid, uuid) to service_role;
revoke execute on function public.create_term_request(uuid, uuid, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_term_request(uuid, uuid, integer, text, timestamptz) to service_role;
revoke execute on function public.term_request_preview(text) from public, anon, authenticated;
grant execute on function public.term_request_preview(text) to service_role;
revoke execute on function public.decide_term_request(text, boolean) from public, anon, authenticated;
grant execute on function public.decide_term_request(text, boolean) to service_role;
revoke execute on function public.withdraw_term_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.withdraw_term_request(uuid, uuid) to service_role;
revoke execute on function public.set_term_requests(uuid, boolean, integer, uuid) from public, anon, authenticated;
grant execute on function public.set_term_requests(uuid, boolean, integer, uuid) to service_role;
revoke execute on function public.term_requests_ready(uuid) from public, anon, authenticated;
grant execute on function public.term_requests_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.term_requests_ready(uuid);
-- drop function if exists public.set_term_requests(uuid, boolean, integer, uuid);
-- drop function if exists public.withdraw_term_request(uuid, uuid);
-- drop function if exists public.decide_term_request(text, boolean);
-- drop function if exists public.term_request_preview(text);
-- drop function if exists public.create_term_request(uuid, uuid, integer, text, timestamptz);
-- drop function if exists public.term_request_eligible(uuid, uuid);
-- drop table if exists public.payment_term_request_reviews;
-- drop table if exists public.payment_term_requests;
-- alter table public.orgs drop column if exists term_requests_max_days, drop column if exists term_requests_on_by,
--   drop column if exists term_requests_on_at;
