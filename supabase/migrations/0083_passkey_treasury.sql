-- A passkey wallet as the treasury (docs/superpowers/specs/2026-10-07-passkey-treasury-design.md K3, K8, K12).
--
-- A workspace paying from its owner's own wallet (0082) now says which kind of wallet signs for it: a browser wallet
-- such as MetaMask (`wallet`, the default, as every such row so far), or a Circle Smart Account owned by a passkey
-- (`passkey`). A passkey treasury also records its recovery: the address registered as a recovery owner, or when the
-- owner chose to go without one.
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.spending_limit_contracts add column if not exists treasury_signer text not null default 'wallet';
alter table public.spending_limit_contracts add column if not exists recovery_address text;
alter table public.spending_limit_contracts add column if not exists recovery_skipped_at timestamptz;

alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_treasury_signer_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_treasury_signer_check
  check (treasury_signer in ('wallet', 'passkey'));
alter table public.spending_limit_contracts drop constraint if exists spending_limit_contracts_recovery_address_check;
alter table public.spending_limit_contracts add constraint spending_limit_contracts_recovery_address_check
  check (recovery_address is null or recovery_address ~ '^0x[0-9a-fA-F]{40}$');

notify pgrst, 'reload schema';
