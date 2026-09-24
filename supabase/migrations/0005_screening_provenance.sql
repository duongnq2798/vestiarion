-- Preserve enough screening evidence to audit a live provider verdict or an
-- outage without conflating "service failed" with "counterparty is clear".

alter table public.counterparties
  add column if not exists jurisdiction text;

alter table public.compliance_checks
  add column if not exists raw_score numeric(7, 6)
    check (raw_score is null or (raw_score >= 0 and raw_score <= 1)),
  add column if not exists matched_entity_id text,
  add column if not exists screening_mode text not null default 'simulate'
    check (screening_mode in ('live', 'simulate')),
  add column if not exists status text not null default 'complete'
    check (status in ('complete', 'failed'));

comment on column public.compliance_checks.raw_score is
  'OpenSanctions identity-match confidence, not a risk score.';
comment on column public.compliance_checks.matched_entity_id is
  'Canonical OpenSanctions entity id selected for analyst review.';
comment on column public.compliance_checks.status is
  'Failed means the previous counterparty verdict was retained unchanged.';
