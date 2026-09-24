-- A cycle that dies halfway used to leave no trace that it ran.
--
-- `cycle_runs` was written once, at the end. Everything before that point --
-- screening verdicts, reopened invoices, escalations, executed payments,
-- ledger entries -- was already committed by then. So a transient failure mid
-- cycle left the book moved and the telemetry claiming nothing had happened:
-- ledger entries with no cycle to attribute them to, an undercounted eval, and
-- an operator looking at an error message with no way to tell how far the run
-- had got. Observed for real during development, when an intermittent network
-- failure wrote four escalations and then killed the run.
--
-- The fix is the one `payment_intents` already applies to the payment leg:
-- record the intent before acting, record the outcome after. The row is opened
-- when the cycle starts and closed when it ends, whichever way it ends.
--
-- A whole-cycle database transaction is not an option and would be the wrong
-- shape anyway: the cycle makes Circle, LLM and Arc RPC calls between its
-- writes, so a transaction would have to be held open across a 45-second
-- settlement poll -- and rolling back the record of money that genuinely moved
-- is worse than no record at all.

alter table public.cycle_runs
  alter column finished_at drop not null,
  alter column duration_ms drop not null,
  alter column decision_count set default 0;

alter table public.cycle_runs
  add column if not exists status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  add column if not exists failed_stage text,
  add column if not exists error_message text,
  -- Per-stage outcome and duration, appended as the cycle proceeds, so a
  -- failed run says how far it got rather than only that it fell over.
  add column if not exists stages jsonb not null default '[]'::jsonb;

-- Rows written before this migration completed by definition: they only ever
-- existed because the final write succeeded.
update public.cycle_runs set status = 'completed' where status = 'running' and finished_at is not null;

comment on column public.cycle_runs.status is
  'running until the cycle closes. A row left running is a crashed cycle, not a missing one.';

create index if not exists cycle_runs_unfinished_idx
  on public.cycle_runs (started_at) where status = 'running';
