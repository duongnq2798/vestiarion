-- Receipts written back to the CRM deal a Vestiarion deal was planned from
-- (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3-R7).
--
-- accounting_connections gains writes_on, writes_by and writes_at: whether an owner or admin turned on Write receipts
-- to HubSpot for the connection, who and when. Only a HubSpot connection takes it, and a connection disconnected
-- (revoked) has it off: accounting_connections_writes_off clears it in the same update that revokes the connection.
--
-- crm_receipt_writes: the outbox. One row per write to make to one CRM deal: the fields Vestiarion owns there and their
-- values (fields, fixed once queued), the reality of the payments behind them (network, shadow, made stricter from the
-- workspace's own facts as the row is inserted), and where the write is: queued, sending (a run's claim, with a lease),
-- sent (the CRM took it, not read back yet), written (read back and the same: the CRM's acknowledgement, with what it
-- held), failed (tried again later, with a backoff), conflict (a person changed a field in the CRM since Vestiarion last
-- wrote it: waits for a person), refused (final: the reality rule, or the deal gone from the CRM) or superseded (a newer
-- write for the same deal took its place). The last write read back is what Vestiarion owns on the deal: a field the CRM
-- holds otherwise was changed by someone else.
--
-- crm_receipt_writes_guard (before insert and update) and crm_receipt_writes_network (before insert): a write is inserted queued, for a CRM deal linked to that very
-- Vestiarion deal on that connection; its fields and facts never change; its state moves only along the outbox's
-- transitions; written, refused and superseded are final. The reality rule is held here too: a write reaches sending,
-- sent or written only for payments on Arc mainnet outside shadow mode, or into a CRM account the CRM itself said is a
-- test one (account_test, written with the claim from a read made right before it, and true only beside HubSpot's own
-- word for a developer test account or a sandbox: crm_receipt_writes_account_test_check).
--
-- One write is in hand per deal at a time (queued, sending, sent, failed or conflict): crm_receipt_writes_one_open.
--
-- The tenant role reads, inserts and updates its own workspace's rows and deletes none. Composite foreign keys keep a
-- write in its connection's, its CRM deal's and its deal's workspace, and it goes with any of them.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.accounting_connections
  add column if not exists writes_on boolean not null default false,
  add column if not exists writes_by uuid references auth.users(id) on delete set null,
  add column if not exists writes_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_connections_writes_check' and conrelid = 'public.accounting_connections'::regclass) then
    alter table public.accounting_connections
      add constraint accounting_connections_writes_check check (not writes_on or (provider = 'hubspot' and status <> 'revoked'));
  end if;
end $$;

create or replace function public.accounting_connections_writes_off() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Disconnecting stops every write: the switch goes off with the connection.
  if new.status = 'revoked' then
    new.writes_on := false;
  end if;
  return new;
end;
$$;

revoke all on function public.accounting_connections_writes_off() from public, anon, authenticated;

drop trigger if exists accounting_connections_writes_off on public.accounting_connections;
create trigger accounting_connections_writes_off
  before insert or update on public.accounting_connections
  for each row execute function public.accounting_connections_writes_off();

create table if not exists public.crm_receipt_writes (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  connection_id     uuid not null,
  crm_deal_id       uuid not null,
  deal_id           uuid not null,
  provider          text not null constraint crm_receipt_writes_provider_check check (provider in ('hubspot')),
  external_org_id   text not null constraint crm_receipt_writes_external_org_id_check check (char_length(external_org_id) between 1 and 100),
  external_deal_id  text not null constraint crm_receipt_writes_external_deal_id_check check (char_length(external_deal_id) between 1 and 100),
  -- The fields Vestiarion owns on the deal, and the values to write, as text.
  fields            jsonb not null constraint crm_receipt_writes_fields_check
                      check (jsonb_typeof(fields) = 'object' and octet_length(fields::text) <= 4000),
  -- The payments behind it.
  network           text not null constraint crm_receipt_writes_network_check check (network in ('arc-testnet', 'arc-mainnet')),
  shadow            boolean not null,
  -- What the CRM last said of the account: its own word, and whether that is a test account. Null: not read.
  account_type      text constraint crm_receipt_writes_account_type_check check (account_type is null or account_type ~ '^[A-Z_]{1,40}$'),
  account_test      boolean,
  state             text not null default 'queued'
                      constraint crm_receipt_writes_state_check
                      check (state in ('queued', 'sending', 'sent', 'written', 'failed', 'conflict', 'refused', 'superseded')),
  reason            text constraint crm_receipt_writes_reason_check check (reason is null or reason ~ '^[a-z_]{1,40}$'),
  message           text constraint crm_receipt_writes_message_check check (message is null or char_length(message) between 1 and 300),
  attempts          integer not null default 0 constraint crm_receipt_writes_attempts_check check (attempts >= 0),
  next_attempt_at   timestamptz,
  sending_until     timestamptz,
  -- The fields someone changed in the CRM since Vestiarion last wrote them: field, ours, theirs, next.
  conflicts         jsonb constraint crm_receipt_writes_conflicts_check
                      check (conflicts is null or (jsonb_typeof(conflicts) = 'array' and octet_length(conflicts::text) <= 8000)),
  -- What the CRM held when a person chose to write Vestiarion's figures over it, and who and when.
  overwrite         jsonb constraint crm_receipt_writes_overwrite_check
                      check (overwrite is null or (jsonb_typeof(overwrite) = 'object' and octet_length(overwrite::text) <= 4000)),
  overwrite_by      uuid references auth.users(id) on delete set null,
  overwrite_at      timestamptz,
  -- The CRM's acknowledgement: the fields read back after writing them.
  read_back         jsonb constraint crm_receipt_writes_read_back_check
                      check (read_back is null or (jsonb_typeof(read_back) = 'object' and octet_length(read_back::text) <= 4000)),
  sent_at           timestamptz,
  written_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint crm_receipt_writes_org_id_key unique (org_id, id),
  constraint crm_receipt_writes_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade,
  constraint crm_receipt_writes_crm_deal_fkey foreign key (org_id, crm_deal_id)
    references public.crm_deals (org_id, id) on delete cascade,
  constraint crm_receipt_writes_deal_fkey foreign key (org_id, deal_id)
    references public.deals (org_id, id) on delete cascade,
  constraint crm_receipt_writes_sending_check check (state <> 'sending' or sending_until is not null),
  constraint crm_receipt_writes_written_check check ((state = 'written') = (written_at is not null) and (state <> 'written' or read_back is not null)),
  constraint crm_receipt_writes_conflict_check check (state <> 'conflict' or conflicts is not null),
  -- The reality rule (R4).
  constraint crm_receipt_writes_reality_check check (
    state not in ('sending', 'sent', 'written') or (network = 'arc-mainnet' and not shadow) or account_test is true
  )
);

-- A test account is one HubSpot itself names a developer test account or a sandbox (R4): account_test is never true
-- beside any other word for it, or none. HubSpot is the only CRM that writes; another adds its own words here.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_receipt_writes_account_test_check' and conrelid = 'public.crm_receipt_writes'::regclass) then
    alter table public.crm_receipt_writes
      add constraint crm_receipt_writes_account_test_check
      check (account_test is not true or (provider = 'hubspot' and account_type is not null and account_type in ('DEVELOPER_TEST', 'SANDBOX')));
  end if;
end $$;

-- One write in hand per deal: a newer one supersedes it first.
create unique index if not exists crm_receipt_writes_one_open
  on public.crm_receipt_writes (org_id, crm_deal_id) where state in ('queued', 'sending', 'sent', 'failed', 'conflict');
create index if not exists crm_receipt_writes_deal_idx on public.crm_receipt_writes (org_id, deal_id, created_at desc);
create index if not exists crm_receipt_writes_state_idx on public.crm_receipt_writes (org_id, connection_id, state);

create or replace function public.crm_receipt_writes_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'queued' then
      raise exception 'crm_receipt_write_insert: a write is queued before anything is sent' using errcode = 'P0001';
    end if;
    -- The CRM deal it writes to is the one linked to this very deal, on this connection.
    if not exists (
      select 1 from public.crm_deals d
       where d.org_id = new.org_id and d.id = new.crm_deal_id and d.deal_id = new.deal_id
         and d.connection_id = new.connection_id and d.external_id = new.external_deal_id
    ) then
      raise exception 'crm_receipt_write_deal: the CRM deal is not the one this deal was planned from' using errcode = 'P0001';
    end if;
    -- The reality rule reads the workspace's own facts, never only the caller's (R4): shadow whenever the workspace is in
    -- shadow mode or one of the deal's invoices keeps an original currency; the network, crm_receipt_writes_network.
    -- Only ever stricter than asked.
    if not new.shadow and (
      exists (select 1 from public.shadow_modes s where s.org_id = new.org_id)
      or exists (select 1 from public.invoices i where i.org_id = new.org_id and i.deal_id = new.deal_id and i.original_currency is not null)
    ) then
      new.shadow := true;
    end if;
    return new;
  end if;
  if new.org_id <> old.org_id or new.connection_id <> old.connection_id or new.crm_deal_id <> old.crm_deal_id or new.deal_id <> old.deal_id
     or new.provider <> old.provider or new.external_org_id <> old.external_org_id or new.external_deal_id <> old.external_deal_id
     or new.fields <> old.fields or new.network <> old.network or new.shadow <> old.shadow or new.created_at <> old.created_at then
    raise exception 'crm_receipt_write_fixed: what a write writes is fixed once it is queued' using errcode = 'P0001';
  end if;
  -- Final: nothing of it changes but who chose to overwrite, when that person's account is deleted (on delete set null).
  if old.state in ('written', 'refused', 'superseded')
     and ((new.state, new.reason, new.message, new.attempts, new.next_attempt_at, new.sending_until, new.conflicts, new.overwrite,
           new.overwrite_at, new.read_back, new.sent_at, new.written_at, new.account_type, new.account_test)
          is distinct from
          (old.state, old.reason, old.message, old.attempts, old.next_attempt_at, old.sending_until, old.conflicts, old.overwrite,
           old.overwrite_at, old.read_back, old.sent_at, old.written_at, old.account_type, old.account_test)
          or (new.overwrite_by is not null and new.overwrite_by is distinct from old.overwrite_by)) then
    raise exception 'crm_receipt_write_final: a write written, refused or superseded does not change' using errcode = 'P0001';
  end if;
  if new.state <> old.state and not (
       (old.state in ('queued', 'failed') and new.state in ('sending', 'superseded', 'refused'))
    or (old.state = 'conflict' and new.state in ('queued', 'superseded'))
    or (old.state = 'sending' and new.state in ('queued', 'sent', 'written', 'failed', 'conflict', 'refused'))
    or (old.state = 'sent' and new.state in ('written', 'failed', 'conflict'))
  ) then
    raise exception 'crm_receipt_write_transition: a write does not go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.crm_receipt_writes_guard() from public, anon, authenticated;

-- Arc mainnet only for a workspace on Arc mainnet, whatever the insert says (R4). The workspace's network is read as
-- 0075's payment_intents_network reads it: orgs is not the tenant role's to read.
create or replace function public.crm_receipt_writes_network() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.network = 'arc-mainnet' and not exists (select 1 from public.orgs o where o.id = new.org_id and o.network = 'arc-mainnet') then
    new.network := 'arc-testnet';
  end if;
  return new;
end;
$$;

revoke all on function public.crm_receipt_writes_network() from public, anon, authenticated;

drop trigger if exists crm_receipt_writes_guard on public.crm_receipt_writes;
create trigger crm_receipt_writes_guard
  before insert or update on public.crm_receipt_writes
  for each row execute function public.crm_receipt_writes_guard();

drop trigger if exists crm_receipt_writes_network on public.crm_receipt_writes;
create trigger crm_receipt_writes_network
  before insert on public.crm_receipt_writes
  for each row execute function public.crm_receipt_writes_network();

alter table public.crm_receipt_writes enable row level security;
revoke all privileges on table public.crm_receipt_writes from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.crm_receipt_writes to vestiarion_tenant;
grant all privileges on table public.crm_receipt_writes to service_role;

drop policy if exists tenant_isolation on public.crm_receipt_writes;
create policy tenant_isolation on public.crm_receipt_writes for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.crm_receipt_writes;
create policy tenant_isolation_guard on public.crm_receipt_writes as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop trigger if exists crm_receipt_writes_guard on public.crm_receipt_writes;
-- drop function if exists public.crm_receipt_writes_guard();
-- drop trigger if exists crm_receipt_writes_network on public.crm_receipt_writes;
-- drop function if exists public.crm_receipt_writes_network();
-- drop table if exists public.crm_receipt_writes;
-- drop trigger if exists accounting_connections_writes_off on public.accounting_connections;
-- drop function if exists public.accounting_connections_writes_off();
-- alter table public.accounting_connections drop constraint if exists accounting_connections_writes_check;
-- alter table public.accounting_connections drop column if exists writes_at, drop column if exists writes_by, drop column if exists writes_on;