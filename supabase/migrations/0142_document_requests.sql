-- Asking a vendor for a missing document (docs/superpowers/specs/2026-10-23-document-requests-design.md ER1-ER7): a bill
-- waiting for its purchase order or goods receipt, whose vendor has a billing email, is asked for it through a one-time
-- link, and the vendor sends the document straight to the bill, without an account. It asks, collects and shows; it
-- never pays, and changes no bill.
--
-- 1. approval_policies (0076), one row per workspace, gains `document_requests`: off, shadow or on, off by default. An
--    owner changes it in Settings, which signs each change as `document_requests_changed`. The table's grants and tenant
--    policies are 0076's and stay as they are.
-- 2. document_requests: at most one drafted or open per bill. Only the link's SHA-256 is kept. The workspace reads its
--    own under RLS; every write goes through the functions below, run by the server's service role.
--      drafted   made, not emailed: what shadow records, and a request whose email has not gone yet. Its token_hash is
--                set only while an email is being tried, and a failed one clears it.
--      open      emailed; its link answers until expires_at, while the bill still waits for information.
--      answered  the vendor sent its document, once.
--      expired   its link stopped: by date, because the bill no longer waits for information, or after three failed
--                emails. expires_at is when.
--      revoked   an owner or admin stopped it. expires_at is when.
-- 3. The private `documents` storage bucket, where a vendor's file is kept. No storage policy is made: only the server's
--    service role reads it, and it opens a file for a member of its workspace. Made only where Supabase Storage is.
-- 4. The functions, each `security definer`, run by the service role alone:
--      create_document_request(p_org_id, p_invoice_id, p_missing, p_email_domain): a drafted request, only for a bill
--        that still waits for information, and none while the bill has one drafted or open.
--      claim_document_request_send(p_org_id, p_id, p_attempts, p_token_hash, p_missing, p_email_domain): one attempt to
--        email a drafted request, at most three, compare-and-set on the attempts so two runs never send it twice.
--      mark_document_request_sent(p_org_id, p_id, p_token_hash, p_expires_at): the email went out, so the link answers.
--      release_document_request_send(p_org_id, p_id, p_token_hash): the email did not go; drafted again, or expired
--        after the third attempt.
--      close_document_requests(p_org_id): open requests past their date, or whose bill no longer waits for information,
--        expire; so does a drafted one with its three attempts spent.
--      revoke_document_request(p_org_id, p_id): an owner's or admin's stop, of an open request; the server checks the
--        role.
--      document_request_preview(p_token_hash): what the vendor's page shows, for an open, unexpired request whose bill
--        still waits for information.
--      answer_document_request(p_token_hash, ...): the vendor's document, once, while the request is open; the fields
--        are checked here too.
--    None of them changes a bill's status, amount or address, or moves money (ER7).
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time. No function or view of
-- another migration is redefined.

alter table public.approval_policies add column if not exists document_requests text not null default 'off'
  constraint approval_policies_document_requests_check check (document_requests in ('off', 'shadow', 'on'));

create table if not exists public.document_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  invoice_id       uuid not null,
  counterparty_id  uuid not null,
  token_hash       text
                        constraint document_requests_token_hash_key unique
                        constraint document_requests_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  -- What the bill lacks, as the email and the page name it.
  missing          jsonb not null
                        constraint document_requests_missing_check check (
                          jsonb_typeof(missing) = 'array' and jsonb_array_length(missing) between 1 and 2
                          and missing <@ '["purchase_order", "goods_receipt"]'::jsonb),
  status           text not null default 'drafted'
                        constraint document_requests_status_check check (status in ('drafted', 'open', 'answered', 'expired', 'revoked')),
  -- The billing email's domain: the only part of the address kept.
  email_domain     text not null
                        constraint document_requests_email_domain_check check (char_length(email_domain) between 1 and 253 and email_domain ~ '^[a-z0-9.-]+$'),
  send_attempts    integer not null default 0 constraint document_requests_send_attempts_check check (send_attempts between 0 and 3),
  sent_at          timestamptz,
  expires_at       timestamptz,
  answered_at      timestamptz,
  -- What the vendor typed: a purchase order number, and a note, which may break its lines with \n. No other control
  -- character, named by code point (C0, DEL, C1, and the line and paragraph separators U+2028 and U+2029) rather than
  -- [[:cntrl:]], whose members follow the database's ctype: glibc counts the separators, plain C not even C1.
  po_reference     text constraint document_requests_po_reference_check
                        check (po_reference is null or (char_length(po_reference) between 1 and 100
                                                        and po_reference !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]')),
  note             text constraint document_requests_note_check
                        check (note is null or (char_length(note) between 1 and 500
                                                and note !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]')),
  -- The vendor's file, in the private `documents` bucket, under the workspace's own folder.
  file_path        text constraint document_requests_file_path_check
                        check (file_path is null or (file_path ~ '^[0-9a-f-]{36}/document-requests/[0-9a-f-]{36}/[0-9a-f]{64}$'
                                                     and split_part(file_path, '/', 1) = org_id::text)),
  file_sha256      text constraint document_requests_file_sha256_check check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  file_type        text constraint document_requests_file_type_check check (file_type is null or file_type in ('application/pdf', 'image/png', 'image/jpeg')),
  file_size        integer constraint document_requests_file_size_check check (file_size is null or file_size between 1 and 10485760),
  created_at       timestamptz not null default now(),
  constraint document_requests_invoice_fkey foreign key (org_id, invoice_id) references public.invoices (org_id, id) on delete cascade,
  constraint document_requests_counterparty_fkey foreign key (org_id, counterparty_id) references public.counterparties (org_id, id) on delete cascade,
  -- An open request was emailed, with its link and its date.
  constraint document_requests_open_check check (status <> 'open' or (token_hash is not null and sent_at is not null and expires_at is not null)),
  -- An answered one has its file, and only an answered one has a file, a purchase order or a note.
  constraint document_requests_answered_check check (
    (status = 'answered') = (answered_at is not null)
    and (status = 'answered') = (file_path is not null)
    and (file_path is null) = (file_sha256 is null)
    and (file_path is null) = (file_type is null)
    and (file_path is null) = (file_size is null)
    and (status = 'answered' or (po_reference is null and note is null)))
);

create unique index if not exists document_requests_one_at_a_time on public.document_requests (org_id, invoice_id) where status in ('drafted', 'open');
create index if not exists document_requests_invoice_idx on public.document_requests (org_id, invoice_id, created_at desc);
create index if not exists document_requests_created_idx on public.document_requests (org_id, created_at desc);

alter table public.document_requests enable row level security;
revoke all privileges on table public.document_requests from anon, authenticated, vestiarion_tenant;
grant select on table public.document_requests to vestiarion_tenant;
grant all privileges on table public.document_requests to service_role;

drop policy if exists tenant_isolation on public.document_requests;
create policy tenant_isolation on public.document_requests for select to vestiarion_tenant
  using (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.document_requests;
create policy tenant_isolation_guard on public.document_requests as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- The private bucket (ER5): no public URL, 10 MB a file, the three kinds a vendor may send. Kept private on every run.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('documents', 'documents', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
exception
  when insufficient_privilege then
    raise notice 'documents bucket not made here: %', sqlerrm;
end;
$$;

create or replace function public.create_document_request(p_org_id uuid, p_invoice_id uuid, p_missing jsonb, p_email_domain text)
returns public.document_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices;
  v_row     public.document_requests;
begin
  select * into v_invoice from public.invoices i where i.org_id = p_org_id and i.id = p_invoice_id;
  if not found then
    raise exception 'document_request_not_possible: no such bill';
  end if;
  -- Only a bill that still waits for information: a late ask makes nothing.
  if v_invoice.direction <> 'payable' or v_invoice.status <> 'awaiting_info' then
    return null;
  end if;
  insert into public.document_requests (org_id, invoice_id, counterparty_id, missing, email_domain)
  values (p_org_id, p_invoice_id, v_invoice.counterparty_id, p_missing, p_email_domain)
  on conflict (org_id, invoice_id) where status in ('drafted', 'open') do nothing
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.claim_document_request_send(
  p_org_id       uuid,
  p_id           uuid,
  p_attempts     integer,
  p_token_hash   text,
  p_missing      jsonb,
  p_email_domain text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  update public.document_requests r
     set token_hash = p_token_hash, send_attempts = r.send_attempts + 1, missing = p_missing, email_domain = p_email_domain
   where r.org_id = p_org_id and r.id = p_id and r.status = 'drafted' and r.send_attempts = p_attempts and r.send_attempts < 3
     and exists (
       select 1 from public.invoices i
        where i.org_id = r.org_id and i.id = r.invoice_id and i.direction = 'payable' and i.status = 'awaiting_info');
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.mark_document_request_sent(p_org_id uuid, p_id uuid, p_token_hash text, p_expires_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int;
begin
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '15 days' then
    raise exception 'document_request_invalid: the expiry';
  end if;
  update public.document_requests r set status = 'open', sent_at = now(), expires_at = p_expires_at
   where r.org_id = p_org_id and r.id = p_id and r.status = 'drafted' and r.token_hash = p_token_hash;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end;
$$;

create or replace function public.release_document_request_send(p_org_id uuid, p_id uuid, p_token_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  update public.document_requests r
     set token_hash = null,
         status = case when r.send_attempts >= 3 then 'expired' else 'drafted' end,
         expires_at = case when r.send_attempts >= 3 then now() else r.expires_at end
   where r.org_id = p_org_id and r.id = p_id and r.status = 'drafted' and r.token_hash = p_token_hash
  returning r.status into v_status;
  return v_status;
end;
$$;

create or replace function public.close_document_requests(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dated int;
  v_moved int;
  v_spent int;
begin
  update public.document_requests r set status = 'expired'
   where r.org_id = p_org_id and r.status = 'open' and r.expires_at <= now();
  get diagnostics v_dated = row_count;
  -- A bill paid, scheduled or held for another reason since: its link stops now.
  update public.document_requests r set status = 'expired', expires_at = now()
   where r.org_id = p_org_id and r.status = 'open'
     and not exists (
       select 1 from public.invoices i where i.org_id = r.org_id and i.id = r.invoice_id and i.status = 'awaiting_info');
  get diagnostics v_moved = row_count;
  update public.document_requests r set status = 'expired', expires_at = now(), token_hash = null
   where r.org_id = p_org_id and r.status = 'drafted' and r.send_attempts >= 3;
  get diagnostics v_spent = row_count;
  return v_dated + v_moved + v_spent;
end;
$$;

create or replace function public.revoke_document_request(p_org_id uuid, p_id uuid)
returns public.document_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.document_requests;
begin
  update public.document_requests r set status = 'revoked', expires_at = now()
   where r.org_id = p_org_id and r.id = p_id and r.status = 'open'
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.document_request_preview(p_token_hash text)
returns table (request_id uuid, org_id uuid, org_name text, counterparty_name text, invoice_reference text, amount numeric,
               currency text, due_date timestamptz, missing jsonb, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.org_id, o.name, c.name, i.memo, i.amount, i.currency, i.due_date, r.missing, r.expires_at
    from public.document_requests r
    join public.orgs o on o.id = r.org_id
    join public.invoices i on i.org_id = r.org_id and i.id = r.invoice_id
    join public.counterparties c on c.org_id = r.org_id and c.id = r.counterparty_id
   where r.token_hash = p_token_hash and r.status = 'open' and r.expires_at > now() and i.status = 'awaiting_info'
$$;

create or replace function public.answer_document_request(
  p_token_hash   text,
  p_file_path    text,
  p_file_sha256  text,
  p_file_type    text,
  p_file_size    integer,
  p_po_reference text,
  p_note         text
) returns table (outcome text, request_id uuid, org_id uuid, org_name text, org_slug text, invoice_id uuid,
                 counterparty_id uuid, counterparty_name text, invoice_reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.document_requests;
  v_org     public.orgs;
  v_name    text;
  v_memo    text;
  v_po      text := nullif(btrim(coalesce(p_po_reference, '')), '');
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_request from public.document_requests r
   where r.token_hash = p_token_hash and r.status = 'open' and r.expires_at > now()
   for update;
  if not found or not exists (
    select 1 from public.invoices i where i.org_id = v_request.org_id and i.id = v_request.invoice_id and i.status = 'awaiting_info'
  ) then
    return query select 'not_valid'::text, null::uuid, null::uuid, null::text, null::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$'
     or p_file_path is distinct from (v_request.org_id::text || '/document-requests/' || v_request.id::text || '/' || p_file_sha256)
     or p_file_type is null or p_file_type not in ('application/pdf', 'image/png', 'image/jpeg')
     or p_file_size is null or p_file_size not between 1 and 10485760 then
    raise exception 'document_request_invalid: the file';
  end if;
  -- One line of plain text: no control character, and no link a member might open from the card. The note may break its
  -- lines with \n. The control characters are the table's, named by code point, so every database refuses the same ones.
  if v_po is not null and (char_length(v_po) > 100 or v_po ~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]' or v_po ~* '://|www[.]') then
    raise exception 'document_request_invalid: the purchase order';
  end if;
  if v_note is not null and (char_length(v_note) > 500 or v_note ~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]') then
    raise exception 'document_request_invalid: the note';
  end if;
  update public.document_requests r
     set status = 'answered', answered_at = now(), po_reference = v_po, note = v_note,
         file_path = p_file_path, file_sha256 = p_file_sha256, file_type = p_file_type, file_size = p_file_size
   where r.id = v_request.id;
  select * into v_org from public.orgs o where o.id = v_request.org_id;
  select c.name into v_name from public.counterparties c where c.org_id = v_request.org_id and c.id = v_request.counterparty_id;
  select i.memo into v_memo from public.invoices i where i.org_id = v_request.org_id and i.id = v_request.invoice_id;
  return query select 'answered'::text, v_request.id, v_request.org_id, v_org.name, v_org.slug, v_request.invoice_id,
                      v_request.counterparty_id, v_name, v_memo;
end;
$$;

revoke execute on function public.create_document_request(uuid, uuid, jsonb, text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.create_document_request(uuid, uuid, jsonb, text) to service_role;
revoke execute on function public.claim_document_request_send(uuid, uuid, integer, text, jsonb, text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.claim_document_request_send(uuid, uuid, integer, text, jsonb, text) to service_role;
revoke execute on function public.mark_document_request_sent(uuid, uuid, text, timestamptz) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.mark_document_request_sent(uuid, uuid, text, timestamptz) to service_role;
revoke execute on function public.release_document_request_send(uuid, uuid, text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.release_document_request_send(uuid, uuid, text) to service_role;
revoke execute on function public.close_document_requests(uuid) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.close_document_requests(uuid) to service_role;
revoke execute on function public.revoke_document_request(uuid, uuid) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.revoke_document_request(uuid, uuid) to service_role;
revoke execute on function public.document_request_preview(text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.document_request_preview(text) to service_role;
revoke execute on function public.answer_document_request(text, text, text, text, integer, text, text) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.answer_document_request(text, text, text, text, integer, text, text) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.answer_document_request(text, text, text, text, integer, text, text);
-- drop function if exists public.document_request_preview(text);
-- drop function if exists public.revoke_document_request(uuid, uuid);
-- drop function if exists public.close_document_requests(uuid);
-- drop function if exists public.release_document_request_send(uuid, uuid, text);
-- drop function if exists public.mark_document_request_sent(uuid, uuid, text, timestamptz);
-- drop function if exists public.claim_document_request_send(uuid, uuid, integer, text, jsonb, text);
-- drop function if exists public.create_document_request(uuid, uuid, jsonb, text);
-- drop table if exists public.document_requests;
-- alter table public.approval_policies drop column if exists document_requests;
-- The `documents` bucket and its files are removed in Supabase Storage, once its files are no longer needed.
