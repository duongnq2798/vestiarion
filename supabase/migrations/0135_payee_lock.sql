-- The payee lock (docs/superpowers/specs/2026-10-20-payee-lock-design.md PL1).
--
-- approval_policies (0076), one row per workspace, gains the workspace's payee lock: `payee_lock`, off by default, so a
-- workspace that never turns it on works as before; and `payee_lock_cooling_hours`, how long a changed payout address
-- waits before it can be paid, confirmed or not, from 0 (no wait) to 168 (a week). An owner changes both through the
-- app, which records each change in the ledger as `payee_lock_changed`. The table's grants and tenant policies are
-- 0076's and stay as they are.
--
-- Additive, and idempotent throughout: scripts/migrate.ts re-runs every migration each time.

alter table public.approval_policies add column if not exists payee_lock boolean not null default false;
alter table public.approval_policies add column if not exists payee_lock_cooling_hours integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'approval_policies_payee_lock_cooling_hours_check' and conrelid = 'public.approval_policies'::regclass
  ) then
    alter table public.approval_policies
      add constraint approval_policies_payee_lock_cooling_hours_check
      check (payee_lock_cooling_hours between 0 and 168);
  end if;
end $$;
