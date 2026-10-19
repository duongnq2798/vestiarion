-- A payee sends its invoice, and picks where it is paid, through its payee link
-- (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P1-P8).
--
-- 1. payee_links gains two options a member ticks when making a link, both off by default so a link made without them
--    works as before: `asks_invoice` (the page asks for the payee's invoice) and `offers_chain` (the payee picks the
--    chain its wallet receives USDC on). `invoice_at` is when the link's one invoice arrived, and `invoice_closed_at`
--    when a member stopped a used link from taking one: with Revoke, or by making a newer link for the same payee.
--    0039's create_payee_link is re-run by every db:migrate with its signature and is left as it is: a link with an
--    option is made by create_payee_link_with_options, which revokes the payee's unused link, closes the invoice of any
--    earlier used one, and inserts the new link with its options, in one transaction. close_payee_invoice_intake does
--    the closing alone, for a link made by 0039's function.
-- 2. revoke_payee_link (0039's) is redefined: an unused link is revoked as before, and a used link still waiting for its
--    invoice stops taking one; the payee's status page stays.
-- 3. invoice_drafts, the review queue the Chrome extension fills (0121), takes a third source, `payee_link`: no extension
--    connection (`connection_id` is null only then), the link it came through (`payee_link_id`, one draft per link),
--    and always sent for review. invoice_drafts_guard (0121's) keeps `payee_link_id` fixed with where a capture came
--    from; this file redefines it after 0121's re-run.
-- 4. submit_payee_invoice: locks the link, checks it is live (unused and unexpired, or used within 30 days, never
--    revoked and its invoice not closed), that it asks for an invoice and has none yet, then inserts the draft and
--    stamps `invoice_at`, in one transaction. The service role only. A draft is never an invoice: a member adds it from
--    Bills, or discards it.
-- 5. payee_link_status (0078's) adds `asksInvoice` (false once a member closed it), `offersChain`, `invoiceSent`,
--    `addressMirror` (the address is a mirror Vestiarion made in shadow mode, not the payee's) and `chainOpen`: whether
--    the payee may still choose its chain, which needs the link to offer it and be unused, and the payee to be a vendor
--    with no address, no payment, no milestone not yet paid or closed, and no open bill in another currency than USDC.
--    Which chains are offered, and whether the workspace's contract can pay them, is read in the workspace's scope
--    (src/lib/payee-chain-choice.ts).
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. 0039's create_payee_link
-- and revoke_payee_link, 0078's payee_link_status and 0121's invoice_drafts_guard are redefined here, after their own
-- files run.

alter table public.payee_links add column if not exists asks_invoice boolean not null default false;
alter table public.payee_links add column if not exists offers_chain boolean not null default false;
alter table public.payee_links add column if not exists invoice_at timestamptz;
alter table public.payee_links add column if not exists invoice_closed_at timestamptz;

-- An earlier draft of this file set the options on a link after it was made; a link made in two steps could be left
-- without them. Gone from any database that ran it.
drop function if exists public.set_payee_link_options(uuid, uuid, boolean, boolean);

-- Stops the payee's used links still waiting for their invoice from taking one; how many it stopped.
create or replace function public.close_payee_invoice_intake(p_org_id uuid, p_counterparty_id uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closed int;
begin
  update public.payee_links set invoice_closed_at = now()
   where org_id = p_org_id and counterparty_id = p_counterparty_id
     and used_at is not null and revoked_at is null
     and asks_invoice and invoice_at is null and invoice_closed_at is null;
  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

revoke execute on function public.close_payee_invoice_intake(uuid, uuid) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.close_payee_invoice_intake(uuid, uuid) to service_role;

-- 0039's create_payee_link, with the link's options, and closing the invoice of the payee's earlier used links. The same
-- advisory lock as 0039's serialises it with a link made there.
create or replace function public.create_payee_link_with_options(
  p_org_id          uuid,
  p_counterparty_id uuid,
  p_token_hash      text,
  p_by              uuid,
  p_expires_at      timestamptz,
  p_asks_invoice    boolean,
  p_offers_chain    boolean
) returns public.payee_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.payee_links;
begin
  perform pg_advisory_xact_lock(hashtext('vestiarion_payee_links:' || p_counterparty_id::text));
  if not exists (select 1 from public.counterparties where org_id = p_org_id and id = p_counterparty_id) then
    raise exception 'counterparty_not_found: no such counterparty in this workspace';
  end if;
  update public.payee_links set revoked_at = now()
   where org_id = p_org_id and counterparty_id = p_counterparty_id and used_at is null and revoked_at is null;
  perform public.close_payee_invoice_intake(p_org_id, p_counterparty_id);
  insert into public.payee_links (org_id, counterparty_id, token_hash, created_by, expires_at, asks_invoice, offers_chain)
  values (p_org_id, p_counterparty_id, p_token_hash, p_by, p_expires_at, coalesce(p_asks_invoice, false), coalesce(p_offers_chain, false))
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.create_payee_link_with_options(uuid, uuid, text, uuid, timestamptz, boolean, boolean) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.create_payee_link_with_options(uuid, uuid, text, uuid, timestamptz, boolean, boolean) to service_role;

-- 0039's revoke_payee_link: an unused link of the workspace is revoked, as before; a used link still waiting for its
-- invoice, within its 30 days, stops taking one, and keeps showing the payee its payment's status. Whether it did either.
create or replace function public.revoke_payee_link(p_org_id uuid, p_link_id uuid, p_by uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  update public.payee_links set revoked_at = now()
   where id = p_link_id and org_id = p_org_id and used_at is null and revoked_at is null;
  get diagnostics v_changed = row_count;
  if v_changed > 0 then
    return true;
  end if;
  update public.payee_links set invoice_closed_at = now()
   where id = p_link_id and org_id = p_org_id and used_at is not null and revoked_at is null
     and used_at > now() - interval '30 days'
     and asks_invoice and invoice_at is null and invoice_closed_at is null;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

revoke execute on function public.revoke_payee_link(uuid, uuid, uuid) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.revoke_payee_link(uuid, uuid, uuid) to service_role;

-- An invoice a payee sent through its link: no extension connection, the link's id kept as an id (a link goes with its
-- payee), one draft per link.
alter table public.invoice_drafts alter column connection_id drop not null;
alter table public.invoice_drafts add column if not exists payee_link_id uuid;

alter table public.invoice_drafts drop constraint if exists invoice_drafts_source_check;
alter table public.invoice_drafts
  add constraint invoice_drafts_source_check check (source in ('selection', 'file', 'payee_link'));
alter table public.invoice_drafts drop constraint if exists invoice_drafts_connection_check;
alter table public.invoice_drafts
  add constraint invoice_drafts_connection_check check (connection_id is not null or source = 'payee_link');
alter table public.invoice_drafts drop constraint if exists invoice_drafts_payee_link_check;
alter table public.invoice_drafts
  add constraint invoice_drafts_payee_link_check check ((payee_link_id is not null) = (source = 'payee_link'));

create unique index if not exists invoice_drafts_payee_link_key on public.invoice_drafts (payee_link_id) where payee_link_id is not null;

-- 0121's guard, with the payee link among what never changes.
create or replace function public.invoice_drafts_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.source, new.document_kind, new.document_sha256, new.read, new.connection_id, new.idempotency_key,
      new.request_sha256, new.captured_at, new.payee_link_id)
     is distinct from
     (old.id, old.org_id, old.source, old.document_kind, old.document_sha256, old.read, old.connection_id, old.idempotency_key,
      old.request_sha256, old.captured_at, old.payee_link_id)
     or (new.captured_by is distinct from old.captured_by and new.captured_by is not null) then
    raise exception 'invoice_draft_fixed: where a capture came from never changes' using errcode = 'P0001';
  end if;
  if new.raw_text is distinct from old.raw_text and new.raw_text is not null then
    raise exception 'invoice_draft_text: the captured text is only ever removed' using errcode = 'P0001';
  end if;
  if not (old.state = 'draft' and new.state = 'draft')
     and ((new.supplier_name, new.invoice_number, new.amount, new.currency, new.invoice_date, new.due_date, new.po_reference, new.memo)
          is distinct from
          (old.supplier_name, old.invoice_number, old.amount, old.currency, old.invoice_date, old.due_date, old.po_reference, old.memo)
          or (new.counterparty_id is distinct from old.counterparty_id and new.counterparty_id is not null)) then
    raise exception 'invoice_draft_sent: a draft sent for review keeps what was captured' using errcode = 'P0001';
  end if;
  if old.invoice_id is not null and new.invoice_id is not null and new.invoice_id is distinct from old.invoice_id then
    raise exception 'invoice_draft_linked: a draft names the bill it became once' using errcode = 'P0001';
  end if;
  if new.state is distinct from old.state
     and not ((old.state = 'draft' and new.state = 'sent')
              or (old.state in ('draft', 'sent') and new.state = 'discarded')
              or (old.state = 'sent' and new.state = 'confirmed')
              or (old.state = 'confirmed' and new.state = 'sent' and old.invoice_id is null and new.invoice_id is null)) then
    raise exception 'invoice_draft_state: a draft does not go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists invoice_drafts_guard on public.invoice_drafts;
create trigger invoice_drafts_guard before update on public.invoice_drafts
  for each row execute function public.invoice_drafts_guard();

-- The payee's invoice, as a draft sent for review in the link's workspace, for the link's payee. The fields are checked
-- here too: an invoice number of 1 to 100 characters with no control character and no link, an amount above 0 with at
-- most 6 decimals, a due day from today (UTC) to a year ahead, a note of at most 500 characters with no control
-- character but a line break. The document, when one was sent, is its kind, its SHA-256 and its text; the file itself
-- is never stored. The note and the payee's name go in `read`, which never changes.
create or replace function public.submit_payee_invoice(
  p_token_hash      text,
  p_invoice_number  text,
  p_amount          text,
  p_due_date        date,
  p_note            text,
  p_document_kind   text,
  p_document_sha256 text,
  p_raw_text        text,
  p_request_sha256  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link   public.payee_links;
  v_payee  text;
  v_org    text;
  v_today  date := (now() at time zone 'UTC')::date;
  v_draft  uuid;
begin
  select * into v_link
    from public.payee_links l
   where l.token_hash = p_token_hash
     and l.revoked_at is null
     and ((l.used_at is null and l.expires_at > now())
          or (l.used_at is not null and l.used_at > now() - interval '30 days'))
   for update;
  if not found or v_link.invoice_closed_at is not null then
    raise exception 'payee_invoice_link_dead: this link no longer takes an invoice';
  end if;
  if not v_link.asks_invoice then
    raise exception 'payee_invoice_not_asked: this link does not ask for an invoice';
  end if;
  if v_link.invoice_at is not null then
    raise exception 'payee_invoice_sent: this link already sent its invoice';
  end if;

  if p_invoice_number is null or char_length(btrim(p_invoice_number)) not between 1 and 100
     or p_invoice_number ~ '[[:cntrl:]]' or p_invoice_number ~* '(://|www\.)' then
    raise exception 'payee_invoice_invalid: the invoice number';
  end if;
  if p_amount is null or p_amount !~ '^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$' then
    raise exception 'payee_invoice_invalid: the amount';
  end if;
  if p_amount::numeric <= 0 then
    raise exception 'payee_invoice_invalid: the amount';
  end if;
  if p_due_date is null or p_due_date < v_today or p_due_date > (v_today + interval '1 year')::date then
    raise exception 'payee_invoice_invalid: the due date';
  end if;
  if p_note is not null and (char_length(p_note) > 500 or replace(p_note, E'\n', '') ~ '[[:cntrl:]]') then
    raise exception 'payee_invoice_invalid: the note';
  end if;

  select c.name into v_payee from public.counterparties c where c.org_id = v_link.org_id and c.id = v_link.counterparty_id;
  select o.name into v_org from public.orgs o where o.id = v_link.org_id;

  insert into public.invoice_drafts (
    org_id, state, source, document_kind, document_sha256, supplier_name, invoice_number, amount, currency, due_date, read,
    raw_text, counterparty_id, connection_id, payee_link_id, idempotency_key, request_sha256, captured_at, sent_at
  ) values (
    v_link.org_id, 'sent', 'payee_link', p_document_kind, p_document_sha256, left(v_payee, 160), btrim(p_invoice_number), p_amount,
    'USDC', p_due_date,
    jsonb_build_object(
      'via', 'payee_link',
      'reader', null,
      'warnings', '[]'::jsonb,
      'documentNotes', '[]'::jsonb,
      'modelNote', null,
      'counterpartyName', v_payee,
      'note', nullif(btrim(coalesce(p_note, '')), ''),
      'extracted', jsonb_build_object(
        'counterpartyId', v_link.counterparty_id,
        'amount', p_amount,
        'currency', 'USDC',
        'dueDate', to_char(p_due_date, 'YYYY-MM-DD'),
        'poReference', null,
        'earlyPayDiscountPct', null,
        'discountDeadline', null,
        'memo', null)),
    p_raw_text, v_link.counterparty_id, null, v_link.id, v_link.id::text, p_request_sha256, now(), now()
  )
  returning id into v_draft;

  update public.payee_links set invoice_at = now() where id = v_link.id;

  return jsonb_build_object(
    'draftId', v_draft,
    'linkId', v_link.id,
    'orgId', v_link.org_id,
    'counterpartyId', v_link.counterparty_id,
    'orgName', v_org,
    'payeeName', v_payee);
exception
  when unique_violation then
    raise exception 'payee_invoice_sent: this link already sent its invoice';
end;
$$;

revoke execute on function public.submit_payee_invoice(text, text, text, date, text, text, text, text, text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.submit_payee_invoice(text, text, text, date, text, text, text, text, text) to service_role;

-- 0078's payee_link_status, with the link's options, whether its invoice arrived, whether the address on file is a
-- mirror, and whether its payee may still choose where it is paid: not once anything owed to it, or paid, is on its
-- current chain or in another currency than USDC, which a payment on another chain would strand.
create or replace function public.payee_link_status(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'orgName', o.name,
           'payeeName', c.name,
           'chain', coalesce(c.chain, case o.network when 'arc-mainnet' then 'ARC' else 'ARC-TESTNET' end),
           'linkState', case when l.used_at is null then 'open' else 'used' end,
           'expiresAt', l.expires_at,
           'usedAt', l.used_at,
           'statusUntil', case when l.used_at is null then l.expires_at else l.used_at + interval '30 days' end,
           'address', c.address,
           'addressConfirmed',
             c.address is not null
             and (c.address_changed_at is null
                  or (c.address_confirmed_at is not null and c.address_confirmed_at >= c.address_changed_at)),
           'asksInvoice', l.asks_invoice and (l.invoice_at is not null or l.invoice_closed_at is null),
           'offersChain', l.offers_chain,
           'invoiceSent', l.invoice_at is not null,
           'addressMirror', c.address is not null and c.mirror_wallet_id is not null,
           'chainOpen',
             l.offers_chain
             and l.used_at is null
             and c.role = 'vendor'
             and c.address is null
             and not exists (
               select 1
                 from public.invoices i
                 join public.payment_intents p on p.org_id = i.org_id and p.source_type = 'invoice' and p.source_id = i.id
                where i.org_id = l.org_id and i.counterparty_id = c.id)
             and not exists (
               select 1
                 from public.milestones m
                 join public.payment_intents p on p.org_id = m.org_id and p.source_type = 'milestone' and p.source_id = m.id
                where m.org_id = l.org_id and m.contractor_id = c.id)
             -- A milestone is paid on the workspace's own chain only, and only USDC crosses chains.
             and not exists (
               select 1 from public.milestones m
                where m.org_id = l.org_id and m.contractor_id = c.id and m.status not in ('paid', 'closed'))
             and not exists (
               select 1 from public.invoices i
                where i.org_id = l.org_id and i.counterparty_id = c.id and i.direction = 'payable'
                  and coalesce(i.currency, 'USDC') <> 'USDC' and i.status not in ('paid', 'rejected', 'received')),
           'payments', coalesce((
             select jsonb_agg(p.item order by p.created_at)
               from (
                 select q.item, q.created_at
                   from (
                     select jsonb_build_object(
                              'kind', 'milestone', 'title', m.title, 'amount', m.amount, 'currency', 'USDC',
                              'status', m.status, 'txRef', m.tx_ref, 'settledAt', m.settled_at, 'scheduledFor', null
                            ) as item,
                            m.created_at, m.status, m.settled_at
                       from public.milestones m
                      where m.org_id = l.org_id and m.contractor_id = c.id
                     union all
                     select jsonb_build_object(
                              'kind', 'invoice', 'title', coalesce(i.memo, 'Invoice'), 'amount', i.amount,
                              'currency', coalesce(i.currency, 'USDC'), 'status', i.status, 'txRef', i.tx_ref,
                              'settledAt', i.settled_at, 'scheduledFor', i.scheduled_for
                            ),
                            i.created_at, i.status, i.settled_at
                       from public.invoices i
                      where i.org_id = l.org_id and i.counterparty_id = c.id and i.direction = 'payable'
                   ) q
                  where q.status not in ('rejected', 'received')
                    and (q.status <> 'paid' or q.settled_at >= l.created_at - interval '1 day')
                  order by q.created_at desc
                  limit 10
               ) p
           ), '[]'::jsonb)
         )
    from public.payee_links l
    join public.orgs o on o.id = l.org_id
    join public.counterparties c on c.org_id = l.org_id and c.id = l.counterparty_id
   where l.token_hash = p_token_hash
     and l.revoked_at is null
     and ((l.used_at is null and l.expires_at > now())
          or (l.used_at is not null and l.used_at > now() - interval '30 days'))
$$;

revoke execute on function public.payee_link_status(text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.payee_link_status(text) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts): restore 0078's payee_link_status, 0039's revoke_payee_link and 0121's
-- invoice_drafts_guard; delete the drafts whose source is 'payee_link', then drop invoice_drafts_payee_link_key,
-- invoice_drafts_payee_link_check and invoice_drafts_connection_check, restore 0121's invoice_drafts_source_check and
-- `connection_id ... not null`, and drop invoice_drafts.payee_link_id; drop submit_payee_invoice,
-- create_payee_link_with_options and close_payee_invoice_intake; drop payee_links.invoice_closed_at, invoice_at,
-- offers_chain and asks_invoice.
