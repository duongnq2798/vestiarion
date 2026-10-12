-- Payments made on Arc booked in the accounting tool, after a person reviews them
-- (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W1, W2, W6, W7).
--
-- accounting_postings: one booking per payable and provider. What it writes is fixed when it is drafted, from the
-- payment confirmed on Arc: the provider's bill, the amount and currency in the bill's currency, the day and the
-- reference (the Arc transaction hash). Beside it, the payment it mirrors: its network, whether it was made in shadow
-- mode, what left and in which stablecoin, and the network fee, which is shown and never booked. Then where it is:
-- draft, sending (an approval's claim, with a two-minute lease), sent (the provider gave a payment id), confirmed (read
-- back), failed (retryable by approving again) or refused (final), with a reason and business words; and, from the
-- approval, the account, the fingerprint of what the person saw, who and when.
--
-- The reality rule is held here too: a booking reaches sending, sent or confirmed only for a payment on Arc mainnet
-- outside shadow mode, or into an organisation the provider said is a demo one (organisation_demo, written with the
-- claim from a read made right before it). A payment on Arc testnet or in shadow mode is never booked into real books.
-- The row's network and shadow are checked against the payment's own facts as it is drafted: Arc mainnet only when the
-- payable's payment intent was made there, shadow whenever the workspace is in shadow mode or the bill keeps an
-- original currency. A draft can only be made stricter than the caller asked, never looser.
--
-- accounting_postings_guard (before insert and update): a booking is inserted as a draft, or refused at once; its facts
-- never change; its state moves only along the review's transitions; confirmed and refused are final. History is the
-- ledger's: each transition appends a signed entry.
--
-- The tenant role reads, inserts and updates its own workspace's rows and deletes none. Composite foreign keys keep a
-- booking in its connection's and its payable's workspace, and it goes with either.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.accounting_postings (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  connection_id        uuid not null,
  provider             text not null constraint accounting_postings_provider_check check (provider in ('xero', 'quickbooks')),
  external_org_id      text not null constraint accounting_postings_external_org_id_check check (char_length(external_org_id) between 1 and 100),
  invoice_id           uuid not null,
  bill_external_id     text not null constraint accounting_postings_bill_external_id_check check (char_length(bill_external_id) between 1 and 100),
  -- What is written: in the bill's currency, on the day the payment was confirmed, with the Arc transaction as reference.
  amount               numeric(24, 6) not null constraint accounting_postings_amount_check check (amount > 0),
  currency             text not null constraint accounting_postings_currency_check check (currency ~ '^[A-Z]{3}$'),
  paid_on              date not null,
  reference            text not null constraint accounting_postings_reference_check check (char_length(reference) between 1 and 255),
  -- The payment on Arc it mirrors.
  network              text not null constraint accounting_postings_network_check check (network in ('arc-testnet', 'arc-mainnet')),
  shadow               boolean not null,
  paid_amount          numeric(24, 6) not null constraint accounting_postings_paid_amount_check check (paid_amount > 0),
  paid_token           text not null constraint accounting_postings_paid_token_check check (paid_token in ('USDC', 'EURC')),
  network_fee          numeric(20, 6) constraint accounting_postings_network_fee_check check (network_fee is null or network_fee >= 0),
  -- What the provider last said of the organisation: a demo (or sandbox) company, or not. Null: not read.
  organisation_demo    boolean,
  state                text not null default 'draft'
                         constraint accounting_postings_state_check check (state in ('draft', 'sending', 'sent', 'confirmed', 'failed', 'refused')),
  reason               text constraint accounting_postings_reason_check check (reason is null or reason ~ '^[a-z_]{1,40}$'),
  message              text constraint accounting_postings_message_check check (message is null or char_length(message) between 1 and 300),
  -- From the approval: the account booked from, the fingerprint of what the person saw, who and when.
  account              jsonb constraint accounting_postings_account_check
                         check (account is null or (jsonb_typeof(account) = 'object' and octet_length(account::text) <= 2000)),
  fingerprint          text constraint accounting_postings_fingerprint_check check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$'),
  approved_by          uuid references auth.users(id) on delete set null,
  approved_at          timestamptz,
  sending_until        timestamptz,
  attempts             integer not null default 0 constraint accounting_postings_attempts_check check (attempts >= 0),
  external_payment_id  text constraint accounting_postings_external_payment_id_check
                         check (external_payment_id is null or char_length(external_payment_id) between 1 and 100),
  sent_at              timestamptz,
  confirmed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint accounting_postings_org_id_key unique (org_id, id),
  -- One payment is never booked twice: one booking per payable and provider, whatever the connection.
  constraint accounting_postings_one_per_payable unique (org_id, invoice_id, provider),
  constraint accounting_postings_connection_fkey foreign key (org_id, connection_id)
    references public.accounting_connections (org_id, id) on delete cascade,
  constraint accounting_postings_invoice_fkey foreign key (org_id, invoice_id)
    references public.invoices (org_id, id) on delete cascade,
  constraint accounting_postings_sending_check check (state <> 'sending' or (sending_until is not null and account is not null and fingerprint is not null)),
  constraint accounting_postings_sent_check check (state not in ('sent', 'confirmed') or (external_payment_id is not null and account is not null and fingerprint is not null)),
  constraint accounting_postings_confirmed_check check ((state = 'confirmed') = (confirmed_at is not null)),
  -- The reality rule (W1).
  constraint accounting_postings_reality_check check (
    state not in ('sending', 'sent', 'confirmed') or (network = 'arc-mainnet' and not shadow) or organisation_demo is true
  )
);

-- One provider payment is one booking's.
create unique index if not exists accounting_postings_payment_key
  on public.accounting_postings (org_id, connection_id, external_payment_id) where external_payment_id is not null;
create index if not exists accounting_postings_state_idx on public.accounting_postings (org_id, connection_id, state);

create or replace function public.accounting_postings_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state not in ('draft', 'refused') then
      raise exception 'accounting_posting_insert: a booking is drafted, or refused, before anything is sent' using errcode = 'P0001';
    end if;
    -- The reality rule reads the payment's own facts, never only the caller's (W1, W2): Arc mainnet only when the
    -- payable's payment intent was made there (0075 takes it from the workspace when the intent is inserted), and shadow
    -- whenever the workspace is in shadow mode or the bill keeps an original currency. Only ever stricter than asked.
    if new.network = 'arc-mainnet' and not exists (
      select 1 from public.payment_intents pi
       where pi.org_id = new.org_id and pi.source_type = 'invoice' and pi.source_id = new.invoice_id and pi.network = 'arc-mainnet'
    ) then
      new.network := 'arc-testnet';
    end if;
    if not new.shadow and (
      exists (select 1 from public.shadow_modes s where s.org_id = new.org_id)
      or exists (select 1 from public.invoices i where i.org_id = new.org_id and i.id = new.invoice_id and i.original_currency is not null)
    ) then
      new.shadow := true;
    end if;
    return new;
  end if;
  -- Final: nothing of it changes but who approved it, when that person's account is deleted (on delete set null).
  if old.state in ('confirmed', 'refused')
     and (new.state, new.reason, new.message, new.account, new.fingerprint, new.approved_at, new.sending_until, new.attempts,
          new.external_payment_id, new.sent_at, new.confirmed_at, new.organisation_demo)
         is distinct from
         (old.state, old.reason, old.message, old.account, old.fingerprint, old.approved_at, old.sending_until, old.attempts,
          old.external_payment_id, old.sent_at, old.confirmed_at, old.organisation_demo)
     or (old.state in ('confirmed', 'refused') and new.approved_by is not null and new.approved_by is distinct from old.approved_by) then
    raise exception 'accounting_posting_final: a booking confirmed or refused does not change' using errcode = 'P0001';
  end if;
  if new.org_id <> old.org_id or new.connection_id <> old.connection_id or new.provider <> old.provider
     or new.external_org_id <> old.external_org_id or new.invoice_id <> old.invoice_id or new.bill_external_id <> old.bill_external_id
     or new.amount <> old.amount or new.currency <> old.currency or new.paid_on <> old.paid_on or new.reference <> old.reference
     or new.network <> old.network or new.shadow <> old.shadow or new.paid_amount <> old.paid_amount or new.paid_token <> old.paid_token
     or new.network_fee is distinct from old.network_fee or new.created_at <> old.created_at then
    raise exception 'accounting_posting_fixed: what a booking writes is fixed once it is drafted' using errcode = 'P0001';
  end if;
  if new.state <> old.state and not (
       (old.state in ('draft', 'failed') and new.state in ('sending', 'refused'))
    or (old.state = 'sending' and new.state in ('draft', 'failed', 'sent', 'refused'))
    or (old.state = 'sent' and new.state in ('confirmed', 'failed', 'refused'))
  ) then
    raise exception 'accounting_posting_transition: a booking does not go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists accounting_postings_guard on public.accounting_postings;
create trigger accounting_postings_guard
  before insert or update on public.accounting_postings
  for each row execute function public.accounting_postings_guard();

alter table public.accounting_postings enable row level security;
revoke all privileges on table public.accounting_postings from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.accounting_postings to vestiarion_tenant;
grant all privileges on table public.accounting_postings to service_role;

drop policy if exists tenant_isolation on public.accounting_postings;
create policy tenant_isolation on public.accounting_postings for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.accounting_postings;
create policy tenant_isolation_guard on public.accounting_postings as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop trigger if exists accounting_postings_guard on public.accounting_postings;
-- drop function if exists public.accounting_postings_guard();
-- drop table if exists public.accounting_postings;
