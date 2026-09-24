-- The cheapest honest eval this architecture can have.
--
-- Every LLM decision already evaluates the rule-based heuristic alongside it,
-- because the heuristic is the fallback. Recording what that written policy
-- would have decided turns it into a *reference policy*: the disagreement rate
-- between a stated rule set and a model's judgement, measured on the real book
-- rather than on a fixture set, and sensitive to a prompt edit, a model swap or
-- silent provider drift the moment it happens.
--
-- Null, not zero, for cycles recorded before this column existed. Backfilling a
-- zero would assert perfect agreement on decisions that were never compared.

alter table cycle_runs
  add column if not exists reference_disagreement_count integer
    check (reference_disagreement_count is null or reference_disagreement_count >= 0);

comment on column cycle_runs.reference_disagreement_count is
  'Model decisions in this cycle that chose a different action from the rule-based policy. Null for cycles run before the comparison existed.';
