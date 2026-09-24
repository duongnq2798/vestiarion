-- A cycle can now survive a stage failing, so it needs a word for what it then
-- is: neither completed nor failed.
--
-- 'partial' means the cycle ran to the end but did not do all of it — a stage
-- threw, and the stages that depend on it were skipped. Its counts are real and
-- they stop where the failure stopped them. Calling that 'completed' would
-- understate the book; calling it 'failed' would hide the work that did happen
-- and the payments that really settled.

alter table public.cycle_runs
  drop constraint if exists cycle_runs_status_check;

alter table public.cycle_runs
  add constraint cycle_runs_status_check
    check (status in ('running', 'completed', 'partial', 'failed'));

comment on column public.cycle_runs.status is
  'running until closed. completed = every stage succeeded. partial = the cycle finished its pass with a stage failed or skipped. failed = it stopped. A row left running is a crashed cycle.';
