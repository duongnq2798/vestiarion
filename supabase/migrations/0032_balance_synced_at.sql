-- When each account's balance was last read from the chain.
--
-- For a live-paying workspace, accounts.balance is written back from Circle by
-- the cycle's reconcile stage, and now also by the console's balance refresh.
-- balance_synced_at records when that read last completed, whether or not the
-- balance changed, so the console can say how fresh the figure is and the
-- refresh can hold off Circle for 30 seconds after a read. Null means the
-- balance has never been read from the chain (every sandbox account).
--
-- Grants: 0018 grants vestiarion_tenant select, insert, update and delete on
-- the whole accounts table, not column by column, so the new column is
-- covered by that grant with nothing to add here; the browser roles keep no
-- privileges (0003). The tenant isolation policies are per row and apply
-- unchanged.
--
-- Idempotent: scripts/migrate.ts re-runs every migration each time.

alter table public.accounts add column if not exists balance_synced_at timestamptz;

-- PostgREST must see the column before the first write that names it.
notify pgrst, 'reload schema';

-- Rollback:
-- alter table public.accounts drop column if exists balance_synced_at;
