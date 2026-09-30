-- When a counterparty's address was last changed by a person, and when a
-- person last confirmed it.
--
-- Changing where a payee is paid is the classic payment-redirection fraud, so
-- an edit sets address_changed_at, and the agent holds every payment to that
-- counterparty until address_confirmed_at is later: a person approved a
-- payment to the new address, or confirmed it on the Counterparties page.
-- Both are null for a counterparty whose address was set when it was added,
-- which is never held for this reason.
--
-- The edit is a compare-and-set on the old address, and the confirmation one
-- on the address shown to the person, both run by the tenant role through
-- PostgREST.
--
-- Grants: 0018 grants vestiarion_tenant select, insert, update and delete on
-- the whole counterparties table, not column by column, so the new columns
-- are covered with nothing to add here; the browser roles keep no privileges
-- (0003). The tenant isolation policies are per row and apply unchanged.
--
-- Idempotent: scripts/migrate.ts re-runs every migration each time.

alter table public.counterparties add column if not exists address_changed_at timestamptz;
alter table public.counterparties add column if not exists address_confirmed_at timestamptz;

-- PostgREST must see the columns before the first write that names one.
notify pgrst, 'reload schema';

-- Rollback:
-- alter table public.counterparties drop column if exists address_confirmed_at;
-- alter table public.counterparties drop column if exists address_changed_at;
