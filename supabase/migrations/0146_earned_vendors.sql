-- Earned vendors (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11, AL21).
--
-- 1. approval_policies.earned_vendor_streak: how many agreed verdicts in a row, in shadow mode, make a vendor an
--    earned vendor (AL11, AL12). Null, the default, is no rule: no vendor is earned. 5 to 50: under 5 the report says
--    too few to tell (autonomy ladder AL4).
-- 2. approval_policies.earned_vendor_payments: whether the agent pays an earned vendor on Arc testnet without waiting
--    for a verdict (AL21, AL22). Off by default, and never on without a rule. Read only from step 3.
--
-- No status is stored: it is worked out from the verdicts and the decisions, and each change is a signed ledger entry
-- (AL15). The table's grants and tenant policies are 0076's and stay as they are.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.approval_policies
  add column if not exists earned_vendor_streak smallint,
  add column if not exists earned_vendor_payments boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'approval_policies_earned_vendor_streak_check' and conrelid = 'public.approval_policies'::regclass
  ) then
    alter table public.approval_policies
      add constraint approval_policies_earned_vendor_streak_check
      check (earned_vendor_streak is null or earned_vendor_streak between 5 and 50);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'approval_policies_earned_vendor_payments_check' and conrelid = 'public.approval_policies'::regclass
  ) then
    alter table public.approval_policies
      add constraint approval_policies_earned_vendor_payments_check
      check (not earned_vendor_payments or earned_vendor_streak is not null);
  end if;
end $$;

comment on column public.approval_policies.earned_vendor_streak is
  'Agreed verdicts in a row, in shadow mode, that make a vendor earned; null = no rule (earned vendors AL11).';
comment on column public.approval_policies.earned_vendor_payments is
  'Whether the agent pays an earned vendor on Arc testnet without a verdict; needs a rule (earned vendors AL21).';

-- PostgREST reads the new columns at once, so the first Settings save is not refused as before 0146.
notify pgrst, 'reload schema';

-- Down (by hand, never by migrate.ts):
--   alter table public.approval_policies drop constraint if exists approval_policies_earned_vendor_payments_check;
--   alter table public.approval_policies drop constraint if exists approval_policies_earned_vendor_streak_check;
--   alter table public.approval_policies drop column if exists earned_vendor_payments;
--   alter table public.approval_policies drop column if exists earned_vendor_streak;
