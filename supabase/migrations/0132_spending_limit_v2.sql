-- Version 2 of the spending limit contract (docs/superpowers/specs/2026-10-19-spending-limit-v2-cross-chain-design.md V9).
--
-- `version` says which contract carries the agent's payments: 1, every row so far, or 2, which also pays a payee on
-- another chain through CCTP. An owner upgrading from version 1 deploys version 2 first (`next_address`,
-- `next_deploy_tx_hash`), then approves it, which makes it the contract (`address`, `version` 2) and keeps the one it
-- replaced (`previous_address`) until the owner's wallet takes its approval back (`previous_revoke_tx_hash`).
--
-- Only new columns, with defaults: safe to run before or after the code that reads them, which reads rows whole.
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.spending_limit_contracts add column if not exists version smallint not null default 1;
alter table public.spending_limit_contracts add column if not exists next_address text;
alter table public.spending_limit_contracts add column if not exists next_deploy_tx_hash text;
alter table public.spending_limit_contracts add column if not exists previous_address text;
alter table public.spending_limit_contracts add column if not exists previous_revoke_tx_hash text;

alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_version_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_version_check check (version in (1, 2));
alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_next_address_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_next_address_check
  check (next_address is null or next_address ~ '^0x[0-9a-fA-F]{40}$');
alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_previous_address_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_previous_address_check
  check (previous_address is null or previous_address ~ '^0x[0-9a-fA-F]{40}$');
-- Only version 1 is upgraded, and only version 2 replaced one.
alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_upgrade_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_upgrade_check check (
  (next_address is null or version = 1) and (previous_address is null or version = 2)
);

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_upgrade_check;
-- alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_previous_address_check;
-- alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_next_address_check;
-- alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_version_check;
-- alter table public.spending_limit_contracts drop column if exists previous_revoke_tx_hash, drop column if exists previous_address,
--   drop column if exists next_deploy_tx_hash, drop column if exists next_address, drop column if exists version;
