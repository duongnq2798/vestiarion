-- Which source produced a counterparty's current verdict.
--
-- counterparties.last_screening_mode is 'live' (OpenSanctions) or 'simulate'
-- (the bundled list), written beside last_screened_at by every screen. The
-- sweep re-screens a counterparty whose verdict came from another source than
-- the one in use, however fresh: turning live screening on then re-checks the
-- whole book at the next sweep, instead of trusting bundled-list verdicts for
-- up to a day (seen 2026-09-30: the first live-mode sweep re-screened 0 of 3).
-- Null means the source is not known, and is re-checked once.
--
-- Filled for existing rows from each counterparty's latest *complete* check;
-- a failed check never produced a verdict. Idempotent: the fill only touches
-- rows still null. (0040 is the EURC branch's; this file does not depend on it.)

alter table public.counterparties add column if not exists last_screening_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.counterparties'::regclass and conname = 'counterparties_last_screening_mode_check'
  ) then
    alter table public.counterparties
      add constraint counterparties_last_screening_mode_check check (last_screening_mode in ('live', 'simulate'));
  end if;
end $$;

update public.counterparties c
   set last_screening_mode = latest.screening_mode
  from (
    select distinct on (counterparty_id) counterparty_id, screening_mode
      from public.compliance_checks
     where status = 'complete'
     order by counterparty_id, created_at desc
  ) latest
 where c.id = latest.counterparty_id
   and c.last_screening_mode is null;

-- Rollback:
-- alter table public.counterparties drop constraint if exists counterparties_last_screening_mode_check;
-- alter table public.counterparties drop column if exists last_screening_mode;
