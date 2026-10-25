-- Checking a vendor's document against its bill (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md
-- DK1-DK16): the cycle reads the PDF a vendor sent for a bill's missing purchase order or goods receipt, compares its
-- vendor, amount and purchase order with the bill in code, and, with vendor requests on and a match, adds the bill's
-- purchase order. A bill whose purchase order came from a document is never paid or scheduled by the agent: a person
-- approves it (`invoice.vendor_document`, read from `po_written` below).
--
-- 1. document_requests (0142) gains:
--      source        'vendor' (an answer through the one-time link, as before) or 'member' (an owner or admin attached
--                    the vendor's PDF, DK11). Every row 0142 made is a vendor's.
--      attached_by   the member who attached it.
--      checked_at, check_outcome, check_reason, check_shadow
--                    the check, once (DK12): matched, mismatched, unreadable or skipped, the sentence the card shows,
--                    and whether vendor requests were in shadow. A request answered before this migration ran has none
--                    yet, and is checked by the next cycle like any new one.
--      document_po   the purchase order the document names, as it writes it.
--      po_written    true only when the check added the bill's purchase order: the marker that holds the bill for a
--                    person (DK8). Only check_document_request below sets it, and no tenant write reaches the table.
--      parse_attempts
--                    the reads of the file begun and not finished (DK3): the cycle counts one before pdf.js parses the
--                    file, in a worker with a time and a memory limit, and clears it once the parse ends, whatever it
--                    found. A parse that took the whole run down with it is never cleared: after two, the file is
--                    recorded unreadable and not parsed again.
--    email_domain may now be null: a member's row was never emailed.
-- 2. Four functions, each `security definer`, run by the service role alone:
--      attach_document(...): a member's answered row, for a payable still waiting for information; one waiting to be
--        checked per bill; the same file is refused while it waits, or once a check outside shadow compared it
--        ("checked outside shadow" means matched or mismatched). A file skipped or unreadable was never compared, and
--        may be attached again.
--      check_document_request(...): the check, once per request, under a row lock; with p_write_po, the bill's
--        purchase order, compare-and-set on the bill still waiting for information, with no purchase order and no
--        payment. It changes no status, amount, currency, address or goods receipt, and moves no money.
--      start_document_parse(p_org_id, p_id) and finish_document_parse(p_org_id, p_id): parse_attempts, on a request
--        still waiting to be checked. start answers how many reads began before this one and never finished, or null
--        for a request that no longer waits.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time. No function or view of
-- another migration is redefined.

alter table public.document_requests add column if not exists source text not null default 'vendor'
  constraint document_requests_source_check check (source in ('vendor', 'member'));
alter table public.document_requests add column if not exists attached_by uuid references auth.users(id) on delete set null;
alter table public.document_requests add column if not exists checked_at timestamptz;
alter table public.document_requests add column if not exists check_outcome text
  constraint document_requests_check_outcome_check check (check_outcome is null or check_outcome in ('matched', 'mismatched', 'unreadable', 'skipped'));
-- One line of Vestiarion's own words. The control characters are 0142's, named by code point (C0, DEL, C1, U+2028 and
-- U+2029) rather than [[:cntrl:]], whose members follow the database's ctype.
alter table public.document_requests add column if not exists check_reason text
  constraint document_requests_check_reason_check
  check (check_reason is null or (char_length(check_reason) between 1 and 300
                                  and check_reason !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'));
alter table public.document_requests add column if not exists check_shadow boolean not null default false;
alter table public.document_requests add column if not exists document_po text
  constraint document_requests_document_po_check
  check (document_po is null or (char_length(document_po) between 1 and 100
                                 and document_po !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
                                 and document_po !~* '://|www[.]'));
alter table public.document_requests add column if not exists po_written boolean not null default false;
alter table public.document_requests add column if not exists parse_attempts integer not null default 0
  constraint document_requests_parse_attempts_check check (parse_attempts >= 0);

-- A member's row has no email: it was never sent.
alter table public.document_requests alter column email_domain drop not null;

do $$
begin
  -- A check is whole: its date with its outcome, only on an answered request, and the marker only on a match written
  -- outside shadow, with the purchase order it wrote.
  if not exists (
    select 1 from pg_constraint
    where conname = 'document_requests_checked_check' and conrelid = 'public.document_requests'::regclass
  ) then
    alter table public.document_requests
      add constraint document_requests_checked_check check (
        (checked_at is null) = (check_outcome is null)
        and (checked_at is null or status = 'answered')
        and (not po_written or (check_outcome = 'matched' and document_po is not null and not check_shadow)));
  end if;
  -- A vendor's request was emailed to a domain; a member's is an answered PDF, with no link and no email.
  if not exists (
    select 1 from pg_constraint
    where conname = 'document_requests_source_fields_check' and conrelid = 'public.document_requests'::regclass
  ) then
    alter table public.document_requests
      add constraint document_requests_source_fields_check check (
        (source = 'vendor') = (email_domain is not null)
        and (source = 'vendor' or (status = 'answered' and token_hash is null and file_type = 'application/pdf')));
  end if;
end $$;

-- The cycle's queue, oldest answer first (DK2); the AP stage's read of the marker (DK8); one member's attachment
-- waiting per bill (DK11).
create index if not exists document_requests_unchecked_idx on public.document_requests (org_id, answered_at)
  where status = 'answered' and checked_at is null;
create index if not exists document_requests_po_written_idx on public.document_requests (org_id, invoice_id) where po_written;
create unique index if not exists document_requests_one_attachment_waiting on public.document_requests (org_id, invoice_id)
  where source = 'member' and checked_at is null;

create or replace function public.attach_document(
  p_org_id      uuid,
  p_id          uuid,
  p_invoice_id  uuid,
  p_by          uuid,
  p_missing     jsonb,
  p_file_path   text,
  p_file_sha256 text,
  p_file_size   integer
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice  public.invoices;
  v_inserted uuid;
begin
  select * into v_invoice from public.invoices i where i.org_id = p_org_id and i.id = p_invoice_id;
  if not found or v_invoice.direction <> 'payable' or v_invoice.status <> 'awaiting_info' then
    return 'not_waiting';
  end if;
  if p_by is null then
    raise exception 'document_check_invalid: the member';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$'
     or p_file_path is distinct from (p_org_id::text || '/document-requests/' || p_id::text || '/' || p_file_sha256)
     or p_file_size is null or p_file_size not between 1 and 4000000 then
    raise exception 'document_check_invalid: the file';
  end if;
  -- The same file again: refused while it waits, or once a check outside shadow compared it (DK10, DK12). One skipped
  -- or unreadable was never compared, so it may come again.
  if exists (
    select 1 from public.document_requests r
     where r.org_id = p_org_id and r.invoice_id = p_invoice_id and r.file_sha256 = p_file_sha256
       and (r.checked_at is null or (not r.check_shadow and r.check_outcome in ('matched', 'mismatched')))
  ) then
    return 'same_file';
  end if;
  insert into public.document_requests (id, org_id, invoice_id, counterparty_id, missing, status, email_domain, answered_at,
                                        file_path, file_sha256, file_type, file_size, source, attached_by)
  values (p_id, p_org_id, p_invoice_id, v_invoice.counterparty_id, p_missing, 'answered', null, now(),
          p_file_path, p_file_sha256, 'application/pdf', p_file_size, 'member', p_by)
  on conflict (org_id, invoice_id) where source = 'member' and checked_at is null do nothing
  returning id into v_inserted;
  if v_inserted is null then
    return 'busy';
  end if;
  return 'attached';
end;
$$;

create or replace function public.check_document_request(
  p_org_id      uuid,
  p_id          uuid,
  p_file_sha256 text,
  p_outcome     text,
  p_reason      text,
  p_shadow      boolean,
  p_document_po text,
  p_write_po    boolean
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.document_requests;
  v_po      text := nullif(btrim(coalesce(p_document_po, '')), '');
  v_write   boolean := coalesce(p_write_po, false);
  v_shadow  boolean := coalesce(p_shadow, false);
  v_changed int;
begin
  select * into v_request from public.document_requests r
   where r.org_id = p_org_id and r.id = p_id and r.status = 'answered'
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_request.checked_at is not null then
    return 'already_checked';
  end if;
  if p_file_sha256 is distinct from v_request.file_sha256 then
    raise exception 'document_check_invalid: the file';
  end if;
  if p_outcome is null or p_outcome not in ('matched', 'mismatched', 'unreadable', 'skipped') then
    raise exception 'document_check_invalid: the outcome';
  end if;
  if p_reason is not null and (char_length(p_reason) not between 1 and 300
                               or p_reason ~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]') then
    raise exception 'document_check_invalid: the reason';
  end if;
  if v_po is not null and (char_length(v_po) > 100 or v_po ~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]' or v_po ~* '://|www[.]') then
    raise exception 'document_check_invalid: the purchase order';
  end if;
  if v_write then
    if p_outcome <> 'matched' or v_shadow or v_po is null then
      raise exception 'document_check_invalid: only a match outside shadow, with its purchase order, writes it';
    end if;
    -- Compare-and-set (DK7): a person deciding the bill, adding its details or paying it in between wins.
    update public.invoices i set po_reference = v_po
     where i.org_id = p_org_id and i.id = v_request.invoice_id and i.direction = 'payable' and i.status = 'awaiting_info'
       and i.po_reference is null
       and not exists (
         select 1 from public.payment_intents pi where pi.org_id = i.org_id and pi.source_type = 'invoice' and pi.source_id = i.id);
    get diagnostics v_changed = row_count;
    if v_changed = 0 then
      return 'bill_moved';
    end if;
  end if;
  update public.document_requests r
     set checked_at = now(), check_outcome = p_outcome, check_reason = p_reason, check_shadow = v_shadow,
         document_po = v_po, po_written = v_write
   where r.id = v_request.id;
  return case when v_write then 'written' else 'checked' end;
end;
$$;

-- A read of the request's file begins (DK3): counted before pdf.js parses it. The answer is how many reads began before
-- this one and never finished, which the cycle refuses a third; null for a request no longer waiting to be checked.
create or replace function public.start_document_parse(p_org_id uuid, p_id uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before integer;
begin
  update public.document_requests r set parse_attempts = r.parse_attempts + 1
   where r.org_id = p_org_id and r.id = p_id and r.status = 'answered' and r.checked_at is null
  returning r.parse_attempts - 1 into v_before;
  return v_before;
end;
$$;

-- The read ended, whatever it found: nothing is left unfinished.
create or replace function public.finish_document_parse(p_org_id uuid, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.document_requests r set parse_attempts = 0
   where r.org_id = p_org_id and r.id = p_id and r.checked_at is null and r.parse_attempts <> 0;
end;
$$;

revoke execute on function public.attach_document(uuid, uuid, uuid, uuid, jsonb, text, text, integer) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.attach_document(uuid, uuid, uuid, uuid, jsonb, text, text, integer) to service_role;
revoke execute on function public.check_document_request(uuid, uuid, text, text, text, boolean, text, boolean) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.check_document_request(uuid, uuid, text, text, text, boolean, text, boolean) to service_role;
revoke execute on function public.start_document_parse(uuid, uuid) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.start_document_parse(uuid, uuid) to service_role;
revoke execute on function public.finish_document_parse(uuid, uuid) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.finish_document_parse(uuid, uuid) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.finish_document_parse(uuid, uuid);
-- drop function if exists public.start_document_parse(uuid, uuid);
-- drop function if exists public.check_document_request(uuid, uuid, text, text, text, boolean, text, boolean);
-- drop function if exists public.attach_document(uuid, uuid, uuid, uuid, jsonb, text, text, integer);
-- drop index if exists public.document_requests_one_attachment_waiting;
-- drop index if exists public.document_requests_po_written_idx;
-- drop index if exists public.document_requests_unchecked_idx;
-- alter table public.document_requests drop constraint if exists document_requests_source_fields_check;
-- alter table public.document_requests drop constraint if exists document_requests_checked_check;
-- delete from public.document_requests where source = 'member';
-- alter table public.document_requests alter column email_domain set not null;
-- alter table public.document_requests drop column if exists parse_attempts, drop column if exists po_written, drop column if exists document_po,
--   drop column if exists check_shadow, drop column if exists check_reason, drop column if exists check_outcome,
--   drop column if exists checked_at, drop column if exists attached_by, drop column if exists source;
-- A member's files are in the `documents` bucket, under the workspace's own folder, removed with it.
