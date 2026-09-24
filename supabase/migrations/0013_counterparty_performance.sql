-- Replace the original assumed 0.850 with measured, disclosed history.
-- Existing values are all the untouched default: no code read or wrote this
-- column before this migration, so retaining them would preserve fiction.
alter table public.counterparties
  alter column performance_score drop default,
  alter column performance_score drop not null;

alter table public.counterparties
  add column if not exists performance_inputs jsonb;

update public.counterparties
   set performance_score = null,
       performance_inputs = null
 where performance_inputs is null;

comment on column public.counterparties.performance_score is
  'Share of disclosed ledger-history observations completed without intervention; null means no history yet.';
comment on column public.counterparties.performance_inputs is
  'Exact ledger-derived counts used to calculate performance_score.';

-- Rollback (restores the former assumption, so use only if old code requires it):
-- update public.counterparties set performance_score = 0.850 where performance_score is null;
-- alter table public.counterparties alter column performance_score set default 0.850;
-- alter table public.counterparties alter column performance_score set not null;
-- alter table public.counterparties drop column performance_inputs;
