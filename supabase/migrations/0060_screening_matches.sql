-- Review every screening match (docs/superpowers/specs/2026-10-02-review-every-match-design.md R2).
--
-- counterparties.risk_matches: every match of the counterparty's latest live screening that no one has
-- dismissed, best first, at most 25, each { id, caption, score, topics }. The card lists them, and Not this
-- person dismisses the ones it listed in one review. Null for a clear verdict, a bundled one, or one made
-- before this migration.
--
-- Idempotent throughout.

alter table public.counterparties add column if not exists risk_matches jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'counterparties_risk_matches_check' and conrelid = 'public.counterparties'::regclass) then
    alter table public.counterparties add constraint counterparties_risk_matches_check
      check (risk_matches is null or (jsonb_typeof(risk_matches) = 'array' and jsonb_array_length(risk_matches) between 1 and 25));
  end if;
end $$;

notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
-- alter table public.counterparties drop constraint if exists counterparties_risk_matches_check;
-- alter table public.counterparties drop column if exists risk_matches;
