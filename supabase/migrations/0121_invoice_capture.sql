-- Invoice capture for Chrome (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C1, C9-C17).
--
-- 1. invoice_drafts: what a person captured with the Chrome extension, read into the invoice form's fields, until a
--    person adds it as a bill from the console or discards it. A workspace's own rows, under the tenant isolation every
--    workspace table has; the tenant role reads, adds and changes them and deletes none. A draft is never an invoice:
--    `invoice_id` names the bill it became once a person added it through the add-invoice command, and only a
--    confirmed draft names one (`claimed_invoice_id` is the id the bill was being added with, so the sweep can link a
--    draft whose link was not written). `raw_text` is the text it was read from, kept for the reviewer until the draft
--    is decided or 30 days have passed. `connection_id` is the extension_grants row that captured it, kept as an id
--    after the connection ends. invoice_drafts_guard holds its states and what may change in each.
-- 2. extension_grants: a connected extension, one per consent: the person, the workspace, the extension's id, the
--    audience and scopes it was granted, the code it was exchanged for, and its access and refresh tokens as SHA-256
--    only, with the refresh token it last replaced, so that one used again ends the connection. Never longer than 90
--    days from its making. A platform table, as API keys are: a request names its workspace only through its token,
--    so the token is read before any workspace is known. Ending the membership deletes it.
-- 3. extension_auth_codes: the one-time codes /extension/authorize issues (PKCE S256), as SHA-256, five minutes, used
--    once. A code presented again is marked (`replayed_at`) and ends the connection made with it, found by its hash on
--    the connection. Platform.
-- 4. invoice_capture_sweep(p_now): the daily cleanup's retention, a day early so a daily run keeps each promise.
--    Clears the captured text 29 days after capture and from every decided draft, deletes drafts never sent after 6
--    days, settles drafts left confirmed without their bill linked for an hour, deletes expired codes after a day and
--    connections revoked or expired 30 days ago. The service role only.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time. Until it runs, invoice
-- capture says it is not set up (42P01 / PGRST205) and nothing else changes.

create table if not exists public.invoice_drafts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs(id) on delete cascade,
  state               text not null default 'draft'
                           constraint invoice_drafts_state_check check (state in ('draft', 'sent', 'confirmed', 'discarded')),
  source              text not null constraint invoice_drafts_source_check check (source in ('selection', 'file')),
  document_kind       text constraint invoice_drafts_document_kind_check
                           check (document_kind is null or document_kind in ('pdf', 'email', 'text', 'image')),
  document_sha256     text constraint invoice_drafts_document_sha256_check check (document_sha256 is null or document_sha256 ~ '^[0-9a-f]{64}$'),
  supplier_name       text constraint invoice_drafts_supplier_name_check check (supplier_name is null or char_length(supplier_name) between 1 and 160),
  invoice_number      text constraint invoice_drafts_invoice_number_check check (invoice_number is null or char_length(invoice_number) between 1 and 100),
  amount              text constraint invoice_drafts_amount_check check (amount is null or amount ~ '^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$'),
  currency            text constraint invoice_drafts_currency_check check (currency is null or currency ~ '^[A-Z]{3,5}$'),
  invoice_date        date,
  due_date            date,
  po_reference        text constraint invoice_drafts_po_reference_check check (po_reference is null or char_length(po_reference) between 1 and 100),
  memo                text constraint invoice_drafts_memo_check check (memo is null or char_length(memo) between 1 and 280),
  -- What the reader made of it: warnings, notes and the fields as read. Never more than 64 KB.
  read                jsonb constraint invoice_drafts_read_check check (read is null or octet_length(read::text) <= 65536),
  raw_text            text constraint invoice_drafts_raw_text_check check (raw_text is null or char_length(raw_text) <= 20000),
  counterparty_id     uuid,
  connection_id       uuid not null,
  idempotency_key     text not null constraint invoice_drafts_idempotency_key_check check (char_length(idempotency_key) between 1 and 100),
  request_sha256      text not null constraint invoice_drafts_request_sha256_check check (request_sha256 ~ '^[0-9a-f]{64}$'),
  captured_by         uuid references auth.users(id) on delete set null,
  captured_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  sent_at             timestamptz,
  decided_by          uuid references auth.users(id) on delete set null,
  decided_at          timestamptz,
  claimed_invoice_id  uuid,
  invoice_id          uuid,
  -- A double click sends one capture twice: the same key from the same connection is the same draft.
  constraint invoice_drafts_idempotency_key unique (org_id, connection_id, idempotency_key),
  -- A bill comes from one draft, and only a confirmed draft names one.
  constraint invoice_drafts_invoice_key unique (org_id, invoice_id),
  constraint invoice_drafts_invoice_state_check check (invoice_id is null or state = 'confirmed'),
  -- Composite, as every reference between workspace rows is: a draft of one workspace never points at another's
  -- counterparty or invoice. Only the reference is cleared when the row goes.
  constraint invoice_drafts_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete set null (counterparty_id),
  constraint invoice_drafts_invoice_fkey foreign key (org_id, invoice_id)
    references public.invoices (org_id, id) on delete set null (invoice_id)
);

-- The review list (sent, newest first), the invoice numbers a draft may repeat, and each part of the sweep.
drop index if exists public.invoice_drafts_org_state_idx;
create index if not exists invoice_drafts_review_idx on public.invoice_drafts (org_id, state, sent_at desc);
create index if not exists invoice_drafts_number_idx on public.invoice_drafts (org_id, invoice_number) where invoice_number is not null;
create index if not exists invoice_drafts_text_idx on public.invoice_drafts (captured_at) where raw_text is not null;
create index if not exists invoice_drafts_unsent_idx on public.invoice_drafts (captured_at) where state = 'draft';
create index if not exists invoice_drafts_unlinked_idx on public.invoice_drafts (decided_at) where state = 'confirmed' and invoice_id is null;

alter table public.invoice_drafts enable row level security;
revoke all privileges on table public.invoice_drafts from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.invoice_drafts to vestiarion_tenant;
grant all privileges on table public.invoice_drafts to service_role;

drop policy if exists tenant_isolation on public.invoice_drafts;
create policy tenant_isolation on public.invoice_drafts for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.invoice_drafts;
create policy tenant_isolation_guard on public.invoice_drafts as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- A draft moves draft → sent → confirmed, or from draft or sent to discarded; a confirmed draft goes back to sent only
-- while no bill is linked to it, and a bill is linked once. Where a capture came from never changes; its fields and its
-- matched counterparty change only while it is a draft in the extension; the captured text is only ever removed. A
-- foreign key's own set null (a person's account deleted, the counterparty or the bill deleted) passes.
create or replace function public.invoice_drafts_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.source, new.document_kind, new.document_sha256, new.read, new.connection_id, new.idempotency_key,
      new.request_sha256, new.captured_at)
     is distinct from
     (old.id, old.org_id, old.source, old.document_kind, old.document_sha256, old.read, old.connection_id, old.idempotency_key,
      old.request_sha256, old.captured_at)
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

create table if not exists public.extension_grants (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null,
  user_id               uuid not null,
  client_id             text not null constraint extension_grants_client_id_check check (client_id ~ '^[a-p]{32}$'),
  audience              text not null default 'vestiarion-chrome'
                             constraint extension_grants_audience_check check (audience = 'vestiarion-chrome'),
  scopes                text[] not null constraint extension_grants_scopes_check
                             check (cardinality(scopes) between 1 and 2 and scopes <@ array['invoice_draft:create', 'invoice_draft:read']::text[]),
  access_token_hash     text not null constraint extension_grants_access_token_hash_key unique
                             constraint extension_grants_access_token_hash_check check (access_token_hash ~ '^[0-9a-f]{64}$'),
  access_expires_at     timestamptz not null,
  refresh_token_hash    text not null constraint extension_grants_refresh_token_hash_key unique
                             constraint extension_grants_refresh_token_hash_check check (refresh_token_hash ~ '^[0-9a-f]{64}$'),
  refresh_expires_at    timestamptz not null,
  -- The refresh token this pair replaced: used again, the connection is ended.
  retired_refresh_hash  text constraint extension_grants_retired_refresh_hash_check check (retired_refresh_hash is null or retired_refresh_hash ~ '^[0-9a-f]{64}$'),
  -- The one-time code the connection was made with, written with it in one insert.
  code_hash             text not null constraint extension_grants_code_hash_key unique
                             constraint extension_grants_code_hash_check check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  refreshed_at          timestamptz,
  last_used_at          timestamptz,
  revoked_at            timestamptz,
  revoked_by            uuid references auth.users(id) on delete set null,
  revoked_reason        text constraint extension_grants_revoked_reason_check
                             check (revoked_reason is null or revoked_reason in ('extension', 'settings', 'reused_code', 'reused_refresh', 'role_changed')),
  -- However often it is refreshed, a connection ends 90 days after it was made.
  constraint extension_grants_lifetime_check
    check (refresh_expires_at <= created_at + interval '90 days' and access_expires_at <= created_at + interval '90 days'),
  -- A connection acts for a member: ending the membership ends it.
  constraint extension_grants_membership_fkey foreign key (org_id, user_id)
    references public.memberships (org_id, user_id) on delete cascade
);

create index if not exists extension_grants_org_idx on public.extension_grants (org_id, created_at desc);
create index if not exists extension_grants_member_idx on public.extension_grants (org_id, user_id);
create index if not exists extension_grants_retired_refresh_idx on public.extension_grants (retired_refresh_hash) where retired_refresh_hash is not null;
create index if not exists extension_grants_revoked_idx on public.extension_grants (revoked_at) where revoked_at is not null;
create index if not exists extension_grants_refresh_expires_idx on public.extension_grants (refresh_expires_at);

alter table public.extension_grants enable row level security;
revoke all privileges on table public.extension_grants from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.extension_grants to service_role;

create table if not exists public.extension_auth_codes (
  code_hash       text primary key constraint extension_auth_codes_code_hash_check check (code_hash ~ '^[0-9a-f]{64}$'),
  org_id          uuid not null,
  user_id         uuid not null,
  client_id       text not null constraint extension_auth_codes_client_id_check check (client_id ~ '^[a-p]{32}$'),
  redirect_uri    text not null constraint extension_auth_codes_redirect_uri_check check (char_length(redirect_uri) between 1 and 200),
  code_challenge  text not null constraint extension_auth_codes_code_challenge_check check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scopes          text[] not null constraint extension_auth_codes_scopes_check
                       check (cardinality(scopes) between 1 and 2 and scopes <@ array['invoice_draft:create', 'invoice_draft:read']::text[]),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  -- Presented again after it was used: the connection made with it is ended, even one made a moment later.
  replayed_at     timestamptz,
  constraint extension_auth_codes_membership_fkey foreign key (org_id, user_id)
    references public.memberships (org_id, user_id) on delete cascade
);

create index if not exists extension_auth_codes_expires_idx on public.extension_auth_codes (expires_at);
create index if not exists extension_auth_codes_member_idx on public.extension_auth_codes (org_id, user_id);

alter table public.extension_auth_codes enable row level security;
revoke all privileges on table public.extension_auth_codes from anon, authenticated, vestiarion_tenant;
grant all privileges on table public.extension_auth_codes to service_role;

create or replace function public.invoice_capture_sweep(p_now timestamptz default now()) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_linked integer;
  v_returned integer;
  v_text integer;
  v_drafts integer;
  v_codes integer;
  v_connections integer;
begin
  -- A draft left confirmed for an hour without its bill linked: linked when the bill it was being added as exists,
  -- and put back for review when it was never added.
  update public.invoice_drafts d set invoice_id = d.claimed_invoice_id
   where d.state = 'confirmed' and d.invoice_id is null and d.claimed_invoice_id is not null
     and d.decided_at < p_now - interval '1 hour'
     and exists (select 1 from public.invoices i where i.org_id = d.org_id and i.id = d.claimed_invoice_id);
  get diagnostics v_linked = row_count;

  update public.invoice_drafts set state = 'sent', decided_by = null, decided_at = null, claimed_invoice_id = null
   where state = 'confirmed' and invoice_id is null and decided_at < p_now - interval '1 hour';
  get diagnostics v_returned = row_count;

  -- A draft confirmed without its bill linked yet keeps its text: it may still go back for review.
  update public.invoice_drafts set raw_text = null
   where raw_text is not null
     and (captured_at < p_now - interval '29 days' or state = 'discarded' or (state = 'confirmed' and invoice_id is not null));
  get diagnostics v_text = row_count;

  delete from public.invoice_drafts where state = 'draft' and captured_at < p_now - interval '6 days';
  get diagnostics v_drafts = row_count;

  delete from public.extension_auth_codes where expires_at < p_now - interval '1 day';
  get diagnostics v_codes = row_count;

  delete from public.extension_grants
   where (revoked_at is not null and revoked_at < p_now - interval '30 days')
      or refresh_expires_at < p_now - interval '30 days';
  get diagnostics v_connections = row_count;

  return jsonb_build_object('draftsLinked', v_linked, 'draftsReturned', v_returned, 'textCleared', v_text, 'draftsDeleted', v_drafts,
    'codesDeleted', v_codes, 'connectionsDeleted', v_connections);
end
$$;

revoke execute on function public.invoice_capture_sweep(timestamptz) from public, anon, authenticated, vestiarion_tenant;
grant execute on function public.invoice_capture_sweep(timestamptz) to service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.invoice_capture_sweep(timestamptz);
-- drop table if exists public.extension_auth_codes;
-- drop table if exists public.extension_grants;
-- drop trigger if exists invoice_drafts_guard on public.invoice_drafts;
-- drop function if exists public.invoice_drafts_guard();
-- drop table if exists public.invoice_drafts;
