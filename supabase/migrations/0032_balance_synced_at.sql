-- When each account's balance was last read from the chain, and the console
-- refresh's claim on it.
--
-- For a live-paying workspace, accounts.balance is written back from Circle by
-- the cycle's reconcile stage, and now also by the console's balance refresh.
-- balance_synced_at records when that read last completed, whether or not the
-- balance changed, so the console can say how fresh the figure is and the
-- refresh can hold off Circle for 30 seconds after a read. Null means the
-- balance has never been read from the chain (every sandbox account). It is
-- written separately from the balance, best effort, so a failure to record it
-- never stops a balance being written.
--
-- balance_refresh_claimed_at is the console refresh's claim on the operating
-- account: a refresh asks Circle only after an update that sets it wins, and
-- that update matches only while the column is null or older than 30
-- seconds. So at most one request asks Circle per 30 seconds, whether the
-- last read succeeded or not, and two tabs opened together make one call.
--
-- Grants: 0018 grants vestiarion_tenant select, insert, update and delete on
-- the whole accounts table, not column by column, so the new columns are
-- covered by that grant with nothing to add here; the browser roles keep no
-- privileges (0003). The tenant isolation policies are per row and apply
-- unchanged.
--
-- Idempotent: scripts/migrate.ts re-runs every migration each time.

alter table public.accounts add column if not exists balance_synced_at timestamptz;
alter table public.accounts add column if not exists balance_refresh_claimed_at timestamptz;

-- PostgREST must see the columns before the first write that names one.
notify pgrst, 'reload schema';

-- Rollback:
-- alter table public.accounts drop column if exists balance_refresh_claimed_at;
-- alter table public.accounts drop column if exists balance_synced_at;
