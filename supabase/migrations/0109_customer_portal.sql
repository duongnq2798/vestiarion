-- A customer's own statement, by a link (docs/superpowers/specs/2026-10-13-customer-portal-design.md).
--
-- customer_portal_links: one link a member made for one customer (a client counterparty) to see what it owes, kept only
-- as the SHA-256 of its secret, with when it expires (at most about 90 days after it was made). One link per customer is
-- live at a time: making a new one stops the old one first. Stopping sets revoked_at, once; the row is kept, never
-- deleted. The tenant role reads links, adds one with what a new link needs (never created_at, which bounds its expiry),
-- and may set revoked_at and revoked_by alone.
--
-- customer_requests: what the customer said about one of its own open invoices through its link: that it paid (a claim,
-- never a payment: nothing is settled by it), that it will pay on a date, that it disputes the invoice, or that it needs
-- a pay link. Only the service role's customer_portal_submit adds one, after checking the link and that the invoice is
-- the link's customer's. The tenant role reads them and may close an open one (status, outcome, closed_at, closed_by);
-- what the customer said never changes. notified_at is when the workspace's members were last emailed about it, set
-- only by the service role's functions: at most once an hour per request.
--
-- customer_request_messages: the thread under a request: the customer's words (added only through the service role's
-- functions, with the link they came by) and the business's replies (added by the tenant role, which can write only a
-- reply: author is not a column it may set). Append-only; a closed request takes no message.
--
-- customer_portal_by_token, customer_portal_submit, customer_portal_reply: the public page's lookup and its two writes,
-- the service role's alone. A stopped or unknown link is null; an expired one answers only that it expired, and when.
-- Each write locks the link's row and counts what the link sent in the last day (at most 30), so the cap holds across
-- serverless instances.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. It redefines no earlier
-- migration's object.

create table if not exists public.customer_portal_links (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  counterparty_id  uuid not null,
  token_hash       text not null
                        constraint customer_portal_links_token_hash_key unique
                        constraint customer_portal_links_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users(id) on delete set null,
  constraint customer_portal_links_org_id_key unique (org_id, id),
  constraint customer_portal_links_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '91 days'),
  constraint customer_portal_links_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

-- One live link per customer: an expired link still counts until it is stopped, which making a new one does.
create unique index if not exists customer_portal_links_one_live on public.customer_portal_links (org_id, counterparty_id) where revoked_at is null;

-- A link is for a customer: a client counterparty of the same workspace.
create or replace function public.customer_portal_links_client()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.counterparties c where c.org_id = new.org_id and c.id = new.counterparty_id and c.role = 'client') then
    raise exception 'customer_portal_not_client: a statement link is made for a customer';
  end if;
  return new;
end;
$$;

drop trigger if exists customer_portal_links_client on public.customer_portal_links;
create trigger customer_portal_links_client before insert on public.customer_portal_links
  for each row execute function public.customer_portal_links_client();

-- A stopped link stays stopped: once revoked_at is set, neither it nor who stopped it changes.
create or replace function public.customer_portal_links_revoke_once()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by) then
    raise exception 'customer_portal_link_revoked: this statement link was stopped already';
  end if;
  return new;
end;
$$;

drop trigger if exists customer_portal_links_revoke_once on public.customer_portal_links;
create trigger customer_portal_links_revoke_once before update on public.customer_portal_links
  for each row execute function public.customer_portal_links_revoke_once();

create table if not exists public.customer_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  link_id          uuid not null,
  counterparty_id  uuid not null,
  invoice_id       uuid not null,
  kind             text not null constraint customer_requests_kind_check check (kind in ('paid', 'promise', 'dispute', 'pay_link')),
  paid_on          date,
  reference        text constraint customer_requests_reference_check check (reference is null or char_length(btrim(reference)) between 1 and 120),
  amount           numeric(20, 6) constraint customer_requests_amount_check check (amount is null or (amount > 0 and amount < 1000000000000)),
  promised_on      date,
  status           text not null default 'open' constraint customer_requests_status_check check (status in ('open', 'closed')),
  outcome          text constraint customer_requests_outcome_check check (outcome is null or outcome in ('resolved', 'not_received', 'superseded')),
  created_at       timestamptz not null default now(),
  closed_at        timestamptz,
  closed_by        uuid references auth.users(id) on delete set null,
  constraint customer_requests_org_id_key unique (org_id, id),
  -- What each kind carries: a claim of payment its day (and, if given, a reference and an amount), a promise its day.
  constraint customer_requests_shape_check check (
    (kind = 'paid' and paid_on is not null and promised_on is null)
    or (kind = 'promise' and promised_on is not null and paid_on is null and reference is null and amount is null)
    or (kind in ('dispute', 'pay_link') and paid_on is null and promised_on is null and reference is null and amount is null)
  ),
  constraint customer_requests_closed_check check (
    (status = 'open' and outcome is null and closed_at is null and closed_by is null)
    or (status = 'closed' and outcome is not null and closed_at is not null)
  ),
  constraint customer_requests_link_fkey foreign key (org_id, link_id)
    references public.customer_portal_links (org_id, id) on delete cascade,
  constraint customer_requests_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade,
  constraint customer_requests_invoice_fkey foreign key (org_id, invoice_id)
    references public.invoices (org_id, id) on delete cascade
);

-- When the workspace's members were last emailed about this request (the service role's functions alone set it).
alter table public.customer_requests add column if not exists notified_at timestamptz;

create index if not exists customer_requests_open on public.customer_requests (org_id, invoice_id) where status = 'open';
create index if not exists customer_requests_link_created on public.customer_requests (link_id, created_at);
create index if not exists customer_requests_counterparty on public.customer_requests (org_id, counterparty_id, created_at desc);

-- A request names its link's customer and one of that customer's receivables, whoever adds it.
create or replace function public.customer_requests_consistent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
      from public.customer_portal_links l
      join public.invoices i on i.org_id = l.org_id and i.counterparty_id = l.counterparty_id
     where l.org_id = new.org_id and l.id = new.link_id and l.counterparty_id = new.counterparty_id
       and i.id = new.invoice_id and i.direction = 'receivable'
  ) then
    raise exception 'customer_request_mismatch: a request is about one of its link''s customer''s receivables';
  end if;
  return new;
end;
$$;

drop trigger if exists customer_requests_consistent on public.customer_requests;
create trigger customer_requests_consistent before insert on public.customer_requests
  for each row execute function public.customer_requests_consistent();

-- A request is closed once: a closed request never opens again or changes how it closed.
create or replace function public.customer_requests_close_once()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'closed' then
    raise exception 'customer_request_closed: this request was closed already';
  end if;
  return new;
end;
$$;

drop trigger if exists customer_requests_close_once on public.customer_requests;
create trigger customer_requests_close_once before update on public.customer_requests
  for each row execute function public.customer_requests_close_once();

create table if not exists public.customer_request_messages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  request_id  uuid not null,
  author      text not null default 'business' constraint customer_request_messages_author_check check (author in ('customer', 'business')),
  body        text not null constraint customer_request_messages_body_check check (char_length(btrim(body)) between 1 and 2000),
  link_id     uuid,
  by          uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  -- The customer's words came by a link and no member; a reply is a member's, by no link.
  constraint customer_request_messages_source_check check (
    (author = 'customer' and link_id is not null and by is null) or (author = 'business' and link_id is null)
  ),
  constraint customer_request_messages_request_fkey foreign key (org_id, request_id)
    references public.customer_requests (org_id, id) on delete cascade,
  constraint customer_request_messages_link_fkey foreign key (org_id, link_id)
    references public.customer_portal_links (org_id, id) on delete cascade
);

create index if not exists customer_request_messages_request on public.customer_request_messages (org_id, request_id, created_at);
create index if not exists customer_request_messages_link_created on public.customer_request_messages (link_id, created_at) where link_id is not null;

-- A closed request takes no more messages, from either side.
create or replace function public.customer_request_messages_open()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.customer_requests r where r.org_id = new.org_id and r.id = new.request_id and r.status = 'open') then
    raise exception 'customer_request_closed: this request was closed already';
  end if;
  return new;
end;
$$;

drop trigger if exists customer_request_messages_open on public.customer_request_messages;
create trigger customer_request_messages_open before insert on public.customer_request_messages
  for each row execute function public.customer_request_messages_open();

alter table public.customer_portal_links enable row level security;
alter table public.customer_requests enable row level security;
alter table public.customer_request_messages enable row level security;

revoke all privileges on table public.customer_portal_links from anon, authenticated, vestiarion_tenant;
revoke all privileges on table public.customer_requests from anon, authenticated, vestiarion_tenant;
revoke all privileges on table public.customer_request_messages from anon, authenticated, vestiarion_tenant;

grant select on table public.customer_portal_links to vestiarion_tenant;
-- What a new link needs, and no more: created_at keeps its default, so the expiry check bounds the link from now.
grant insert (org_id, counterparty_id, token_hash, created_by, expires_at) on table public.customer_portal_links to vestiarion_tenant;
grant update (revoked_at, revoked_by) on table public.customer_portal_links to vestiarion_tenant;
grant select on table public.customer_requests to vestiarion_tenant;
grant update (status, outcome, closed_at, closed_by) on table public.customer_requests to vestiarion_tenant;
grant select on table public.customer_request_messages to vestiarion_tenant;
-- A reply, never the customer's words: author keeps its default, and link_id cannot be given.
grant insert (org_id, request_id, body, by) on table public.customer_request_messages to vestiarion_tenant;

-- The trigger functions run as triggers only: no browser role may call them.
revoke all on function public.customer_portal_links_client() from public, anon, authenticated;
revoke all on function public.customer_portal_links_revoke_once() from public, anon, authenticated;
revoke all on function public.customer_requests_consistent() from public, anon, authenticated;
revoke all on function public.customer_requests_close_once() from public, anon, authenticated;
revoke all on function public.customer_request_messages_open() from public, anon, authenticated;

grant all privileges on table public.customer_portal_links to service_role;
grant all privileges on table public.customer_requests to service_role;
grant all privileges on table public.customer_request_messages to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['customer_portal_links', 'customer_requests', 'customer_request_messages'] loop
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

-- The public page's lookup: a live link's customer and workspace, nothing else of the workspace. A stopped or unknown
-- link answers null, and so does one whose workspace or customer was deleted (the link went with it). An expired link
-- answers only that it expired, and when: no name.
create or replace function public.customer_portal_by_token(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when l.expires_at <= now() then jsonb_build_object('expired', true, 'expiresAt', l.expires_at)
           else jsonb_build_object(
                  'expired', false,
                  'linkId', l.id,
                  'orgId', l.org_id,
                  'counterpartyId', l.counterparty_id,
                  'createdBy', l.created_by,
                  'expiresAt', l.expires_at,
                  'orgName', o.name,
                  'customerName', c.name,
                  'mode', o.mode,
                  'network', o.network)
         end
    from public.customer_portal_links l
    join public.orgs o on o.id = l.org_id
    join public.counterparties c on c.org_id = l.org_id and c.id = l.counterparty_id
   where l.token_hash = p_token_hash
     and l.revoked_at is null
$$;

revoke all on function public.customer_portal_by_token(text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.customer_portal_by_token(text) to service_role;

-- The live link for a write, locked, and whether it may send more today: 30 requests and messages a day per link.
create or replace function public.customer_portal_live_link(p_token_hash text)
returns public.customer_portal_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.customer_portal_links;
  v_sent integer;
begin
  select * into v_link
    from public.customer_portal_links l
   where l.token_hash = p_token_hash and l.revoked_at is null and l.expires_at > now()
   for update;
  if not found then
    raise exception 'customer_portal_link_dead: this link no longer works';
  end if;
  select (select count(*) from public.customer_requests r where r.link_id = v_link.id and r.created_at > now() - interval '1 day')
       + (select count(*) from public.customer_request_messages m where m.link_id = v_link.id and m.created_at > now() - interval '1 day')
    into v_sent;
  if v_sent >= 30 then
    raise exception 'customer_portal_limit: this link sent enough for today';
  end if;
  return v_link;
end;
$$;

revoke all on function public.customer_portal_live_link(text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.customer_portal_live_link(text) to service_role;

-- A customer's request about one of its own open invoices. A new claim of payment or promise replaces the open one of
-- its kind on that invoice; a dispute or a pay link asked again while one is open adds to it instead of opening another.
-- written says whether anything was added: a pay link asked again with no words adds nothing, so nothing is counted
-- against the day's cap, and the caller signs and sends nothing for it either. notify says whether the workspace's
-- members are to be emailed: at most once an hour per request, a claim or promise keeping the stamp of the one it replaced.
create or replace function public.customer_portal_submit(
  p_token_hash  text,
  p_invoice_id  uuid,
  p_kind        text,
  p_paid_on     date,
  p_reference   text,
  p_amount      numeric,
  p_promised_on date,
  p_message     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link       public.customer_portal_links;
  v_invoice    record;
  v_open       uuid;
  v_request    uuid;
  v_appended   boolean := false;
  v_superseded uuid[] := array[]::uuid[];
  v_message    text := nullif(btrim(coalesce(p_message, '')), '');
  v_reference  text := nullif(btrim(coalesce(p_reference, '')), '');
  v_told       timestamptz;
  v_written    boolean;
  v_notify     boolean := false;
begin
  v_link := public.customer_portal_live_link(p_token_hash);

  select i.id, i.status, i.direction into v_invoice
    from public.invoices i
   where i.org_id = v_link.org_id and i.id = p_invoice_id and i.counterparty_id = v_link.counterparty_id and i.direction = 'receivable';
  if not found then
    raise exception 'customer_portal_invoice_not_found: no such invoice on this statement';
  end if;
  if v_invoice.status not in ('pending', 'matched') then
    raise exception 'customer_portal_invoice_closed: this invoice is no longer open';
  end if;

  if p_kind = 'paid' then
    if p_paid_on is null or p_paid_on > current_date + 1 or p_paid_on < current_date - 366 then
      raise exception 'customer_portal_invalid: paid_on';
    end if;
    if p_amount is not null and (p_amount <= 0 or p_amount >= 1000000000000) then
      raise exception 'customer_portal_invalid: amount';
    end if;
    if v_reference is not null and char_length(v_reference) > 120 then
      raise exception 'customer_portal_invalid: reference';
    end if;
  elsif p_kind = 'promise' then
    if p_promised_on is null or p_promised_on < current_date or p_promised_on > current_date + 90 then
      raise exception 'customer_portal_invalid: promised_on';
    end if;
  elsif p_kind = 'dispute' then
    if v_message is null then
      raise exception 'customer_portal_invalid: message';
    end if;
  elsif p_kind <> 'pay_link' then
    raise exception 'customer_portal_invalid: kind';
  end if;
  if v_message is not null and char_length(v_message) > 2000 then
    raise exception 'customer_portal_invalid: message';
  end if;

  if p_kind in ('dispute', 'pay_link') then
    select r.id into v_open
      from public.customer_requests r
     where r.org_id = v_link.org_id and r.invoice_id = v_invoice.id and r.kind = p_kind and r.status = 'open'
     order by r.created_at desc
     limit 1;
  end if;

  if v_open is not null then
    v_request := v_open;
    v_appended := true;
  else
    if p_kind in ('paid', 'promise') then
      with closed as (
        update public.customer_requests r
           set status = 'closed', outcome = 'superseded', closed_at = now(), closed_by = null
         where r.org_id = v_link.org_id and r.invoice_id = v_invoice.id and r.kind = p_kind and r.status = 'open'
        returning r.id
      )
      select coalesce(array_agg(id), array[]::uuid[]) into v_superseded from closed;
    end if;
    -- A claim or promise replacing one the members were emailed about within the hour keeps that stamp.
    select max(r.notified_at) into v_told from public.customer_requests r where r.id = any(v_superseded);
    v_notify := v_told is null or v_told <= now() - interval '1 hour';
    insert into public.customer_requests (org_id, link_id, counterparty_id, invoice_id, kind, paid_on, reference, amount, promised_on, notified_at)
    values (
      v_link.org_id, v_link.id, v_link.counterparty_id, v_invoice.id, p_kind,
      case when p_kind = 'paid' then p_paid_on end,
      case when p_kind = 'paid' then v_reference end,
      case when p_kind = 'paid' then p_amount end,
      case when p_kind = 'promise' then p_promised_on end,
      case when v_notify then now() else v_told end
    )
    returning id into v_request;
  end if;

  if v_message is not null then
    insert into public.customer_request_messages (org_id, request_id, author, body, link_id)
    values (v_link.org_id, v_request, 'customer', v_message, v_link.id);
  end if;

  -- A pay link asked again with no words wrote nothing; words added to an open request are emailed at most once an hour.
  v_written := not v_appended or v_message is not null;
  if v_appended and v_written then
    update public.customer_requests r
       set notified_at = now()
     where r.id = v_request and (r.notified_at is null or r.notified_at <= now() - interval '1 hour');
    v_notify := found;
  end if;

  return jsonb_build_object(
    'requestId', v_request,
    'appended', v_appended,
    'written', v_written,
    'notify', v_notify,
    'superseded', to_jsonb(v_superseded),
    'orgId', v_link.org_id,
    'linkId', v_link.id,
    'counterpartyId', v_link.counterparty_id,
    'createdBy', v_link.created_by,
    'invoiceId', v_invoice.id);
end;
$$;

revoke all on function public.customer_portal_submit(text, uuid, text, date, text, numeric, date, text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.customer_portal_submit(text, uuid, text, date, text, numeric, date, text) to service_role;

-- The customer's message under one of its own open requests. notify, as for customer_portal_submit: at most once an
-- hour per request.
create or replace function public.customer_portal_reply(p_token_hash text, p_request_id uuid, p_message text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link    public.customer_portal_links;
  v_request record;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_id      uuid;
  v_notify  boolean;
begin
  v_link := public.customer_portal_live_link(p_token_hash);
  if v_message is null or char_length(v_message) > 2000 then
    raise exception 'customer_portal_invalid: message';
  end if;
  select r.id, r.status, r.invoice_id, r.kind into v_request
    from public.customer_requests r
   where r.org_id = v_link.org_id and r.id = p_request_id and r.counterparty_id = v_link.counterparty_id;
  if not found then
    raise exception 'customer_portal_request_not_found: no such request on this statement';
  end if;
  if v_request.status <> 'open' then
    raise exception 'customer_request_closed: this request was closed already';
  end if;
  insert into public.customer_request_messages (org_id, request_id, author, body, link_id)
  values (v_link.org_id, v_request.id, 'customer', v_message, v_link.id)
  returning id into v_id;
  update public.customer_requests r
     set notified_at = now()
   where r.id = v_request.id and (r.notified_at is null or r.notified_at <= now() - interval '1 hour');
  v_notify := found;
  return jsonb_build_object(
    'messageId', v_id,
    'requestId', v_request.id,
    'kind', v_request.kind,
    'notify', v_notify,
    'orgId', v_link.org_id,
    'linkId', v_link.id,
    'counterpartyId', v_link.counterparty_id,
    'invoiceId', v_request.invoice_id);
end;
$$;

revoke all on function public.customer_portal_reply(text, uuid, text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.customer_portal_reply(text, uuid, text) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.customer_portal_reply(text, uuid, text);
-- drop function if exists public.customer_portal_submit(text, uuid, text, date, text, numeric, date, text);
-- drop function if exists public.customer_portal_live_link(text);
-- drop function if exists public.customer_portal_by_token(text);
-- drop table if exists public.customer_request_messages;
-- drop table if exists public.customer_requests;
-- drop table if exists public.customer_portal_links;
-- drop function if exists public.customer_request_messages_open();
-- drop function if exists public.customer_requests_close_once();
-- drop function if exists public.customer_requests_consistent();
-- drop function if exists public.customer_portal_links_revoke_once();
-- drop function if exists public.customer_portal_links_client();
