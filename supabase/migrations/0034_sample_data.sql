-- Sample data (docs/superpowers/specs/2026-09-30-sample-data-design.md).
--
-- A counterparty loaded as an example is marked, so removing the sample removes
-- exactly what was loaded (S2). Its invoices, milestones and compliance checks
-- are sample because it is, and leave with it through the existing cascades.
-- Additive: the default keeps every existing counterparty a real one, and code
-- that does not know the column never reads it.
--
-- Grants: 0018 grants vestiarion_tenant select, insert, update and delete on
-- counterparties at table level, which covers the new column.
alter table public.counterparties add column if not exists sample boolean not null default false;

-- One sample set per workspace (S3): a second load, however concurrent, fails
-- on the counterparty insert instead of doubling the sample. A person's own
-- counterparty is outside the index, so any name stays free for real use.
create unique index if not exists counterparties_one_sample_set
  on public.counterparties (org_id, name)
  where sample;
