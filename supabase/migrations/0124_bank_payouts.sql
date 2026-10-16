-- Bank payouts through BlindPay (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B3, B4, B7, B11): a vendor's
-- bill paid to its Mexican bank account over SPEI, from the workspace's USDC on Arc.
--
-- workspace_payout_partners: the workspace's BlindPay business customer, one per workspace. Only BlindPay's ids, the KYB
-- status and when it was set up are kept: never a document or a person's details.
--
-- counterparty_bank_accounts: a vendor's bank account at BlindPay, one in use per counterparty. Only BlindPay's id, the
-- CLABE's bank code and last four digits and the beneficiary's name are kept: never the whole CLABE. A removed one keeps
-- its row (removed_at), so the history of where a vendor was paid stays.
--
-- payment_intents.payout_route takes 'bank'. 0047 drops and adds this check on every run, with cctp, gateway and escrow;
-- this file runs after it and widens it again, so the check always ends with bank.
--
-- bank_payouts_ready(p_org_id): true once this migration has run; reads nothing.
--
-- Additive and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

create table if not exists public.workspace_payout_partners (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  provider      text not null default 'blindpay' constraint workspace_payout_partners_provider_check check (provider = 'blindpay'),
  -- The accepted terms (BlindPay's tos_id), then the customer made with them.
  tos_id        text constraint workspace_payout_partners_tos_id_check check (tos_id is null or tos_id ~ '^to_[A-Za-z0-9_]{4,60}$'),
  customer_id   text constraint workspace_payout_partners_customer_id_check check (customer_id is null or customer_id ~ '^re_[A-Za-z0-9_]{4,60}$'),
  kyb_status    text constraint workspace_payout_partners_kyb_status_check
                     check (kyb_status is null or kyb_status in ('verifying', 'approved', 'rejected', 'pending_review', 'other')),
  set_up_by     uuid references auth.users(id) on delete set null,
  set_up_at     timestamptz,
  updated_at    timestamptz not null default now(),
  constraint workspace_payout_partners_org_provider_key unique (org_id, provider),
  constraint workspace_payout_partners_customer_check check (customer_id is null or tos_id is not null)
);

alter table public.workspace_payout_partners enable row level security;
revoke all privileges on table public.workspace_payout_partners from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.workspace_payout_partners to vestiarion_tenant;
grant all privileges on table public.workspace_payout_partners to service_role;

drop policy if exists tenant_isolation on public.workspace_payout_partners;
create policy tenant_isolation on public.workspace_payout_partners for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.workspace_payout_partners;
create policy tenant_isolation_guard on public.workspace_payout_partners as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

create table if not exists public.counterparty_bank_accounts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  counterparty_id   uuid not null,
  provider          text not null default 'blindpay' constraint counterparty_bank_accounts_provider_check check (provider = 'blindpay'),
  external_id       text not null constraint counterparty_bank_accounts_external_id_check check (external_id ~ '^ba_[A-Za-z0-9_]{4,60}$'),
  rail              text not null default 'spei' constraint counterparty_bank_accounts_rail_check check (rail = 'spei'),
  country           text not null default 'MX' constraint counterparty_bank_accounts_country_check check (country = 'MX'),
  currency          text not null default 'MXN' constraint counterparty_bank_accounts_currency_check check (currency = 'MXN'),
  bank_code         text not null constraint counterparty_bank_accounts_bank_code_check check (bank_code ~ '^[0-9]{3}$'),
  last4             text not null constraint counterparty_bank_accounts_last4_check check (last4 ~ '^[0-9]{4}$'),
  beneficiary_name  text not null constraint counterparty_bank_accounts_beneficiary_name_check check (char_length(beneficiary_name) between 1 and 128),
  status            text not null default 'verifying'
                         constraint counterparty_bank_accounts_status_check check (status in ('verifying', 'approved', 'rejected', 'deprecated')),
  added_by          uuid references auth.users(id) on delete set null,
  added_at          timestamptz not null default now(),
  removed_at        timestamptz,
  constraint counterparty_bank_accounts_counterparty_fkey foreign key (org_id, counterparty_id)
    references public.counterparties (org_id, id) on delete cascade
);

-- One bank account in use per counterparty: adding another removes the one before, in the same command.
create unique index if not exists counterparty_bank_accounts_in_use on public.counterparty_bank_accounts (org_id, counterparty_id) where removed_at is null;

alter table public.counterparty_bank_accounts enable row level security;
revoke all privileges on table public.counterparty_bank_accounts from anon, authenticated, vestiarion_tenant;
grant select, insert, update on table public.counterparty_bank_accounts to vestiarion_tenant;
grant all privileges on table public.counterparty_bank_accounts to service_role;

drop policy if exists tenant_isolation on public.counterparty_bank_accounts;
create policy tenant_isolation on public.counterparty_bank_accounts for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));
drop policy if exists tenant_isolation_guard on public.counterparty_bank_accounts;
create policy tenant_isolation_guard on public.counterparty_bank_accounts as restrictive for all to vestiarion_tenant
  using (org_id = (select public.request_org_id())) with check (org_id = (select public.request_org_id()));

-- What a bank account names never changes; only its status, and its removal, once.
create or replace function public.counterparty_bank_accounts_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.org_id, new.counterparty_id, new.provider, new.external_id, new.rail, new.country, new.currency, new.bank_code,
      new.last4, new.beneficiary_name, new.added_by, new.added_at)
     is distinct from
     (old.id, old.org_id, old.counterparty_id, old.provider, old.external_id, old.rail, old.country, old.currency, old.bank_code,
      old.last4, old.beneficiary_name, old.added_by, old.added_at) then
    raise exception 'bank_account_fixed: a bank account is replaced, never edited' using errcode = 'P0001';
  end if;
  if old.removed_at is not null and new.removed_at is distinct from old.removed_at then
    raise exception 'bank_account_removed: a removed bank account stays removed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists counterparty_bank_accounts_guard on public.counterparty_bank_accounts;
create trigger counterparty_bank_accounts_guard before update on public.counterparty_bank_accounts
  for each row execute function public.counterparty_bank_accounts_guard();

alter table public.payment_intents drop constraint if exists payment_intents_payout_route_check;
alter table public.payment_intents
  add constraint payment_intents_payout_route_check check (payout_route in ('cctp', 'gateway', 'escrow', 'bank'));

create or replace function public.bank_payouts_ready(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.bank_payouts_ready(uuid) from public, anon, authenticated;
grant execute on function public.bank_payouts_ready(uuid) to vestiarion_tenant, service_role;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- drop function if exists public.bank_payouts_ready(uuid);
-- drop table if exists public.counterparty_bank_accounts; drop table if exists public.workspace_payout_partners;
-- and the payout_route check without bank, once no intent holds it.
