-- Preserve how milestone evidence was checked. A boolean alone cannot tell an
-- auditor whether GitHub reported a merged PR, a person approved the work, or
-- a demo fixture arrived pre-verified.

alter table public.milestones
  add column if not exists verification_method text not null default 'unverified'
    check (verification_method in ('unverified', 'github', 'manual', 'seed')),
  add column if not exists verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'verified', 'not_merged', 'unavailable', 'failed')),
  add column if not exists verification_checked_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists verification_detail jsonb not null default '{}'::jsonb;

update public.milestones
   set verification_method = case when verified then 'seed' else 'unverified' end,
       verification_status = case when verified then 'verified' else 'unverified' end,
       verified_at = case when verified then coalesce(verified_at, created_at) else null end
 where verification_method = 'unverified'
   and verification_status = 'unverified';

comment on column public.milestones.verification_method is
  'github is API-derived, manual is a human ledger action, seed is demo-only provenance.';
comment on column public.milestones.verification_status is
  'Unavailable and failed retain the prior verified value instead of inventing an answer.';
