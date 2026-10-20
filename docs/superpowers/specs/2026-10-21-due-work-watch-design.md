# The due-work watch

Date: 2026-10-21. Status: accepted.

## Why

A cycle starts within seconds when a person or a service gives the agent something to decide (event-driven cycles,
`2026-09-30-event-driven-cycles-design.md`). Work that becomes due only because time passed waits for the next
scheduled tick, which runs at 17 minutes past every sixth hour UTC.

**The payee lock's wait.** It ends at whatever time the address changed plus the lock's hours. On Oct 20, two Arc
testnet payables whose wait ended at 15:14 and 15:32 UTC would have waited until the 18:17 tick: about 3 hours past
the time the guide and the Contractors card say they can be paid. They were paid only because someone pressed
**Run cycle now**.

**A tick that misses a workspace.** On Oct 17 the tick ran out of time before the last workspaces in slug order. One
customer workspace missed three ticks in a row, about 18 hours with no scheduled cycle. The tick now runs four
workspaces at once (`CRON_CONCURRENCY`), and one not started 180 seconds in is left to the next tick. So a skip is
rarer, but it still costs 6 hours when it happens. A tick that fails, or that Supabase Cron never calls, costs the
same.

## What

**DW1. Every 5 minutes.** `POST /api/agent/due-watch` is called by Supabase Cron (`supabase/cron/watches.sql`):
- with the agent's bearer token, like the tick and the other watches;
- rate-limited in its own bucket;
- `maxDuration` 300 seconds.

`.github/workflows/due-watch.yml` runs it by hand.

**DW2. Live workspaces only.** Each live workspace is read in its own scope:
- a paused agent, or payments switched off for the platform, skips it, as in the tick;
- sandbox workspaces stay with the cycles a member runs.

**DW3. The reference point.** The watch compares due times with the start of the workspace's latest cycle (`cycle_runs.started_at`):
- any trigger and any status counts;
- a workspace that has never run a cycle has none.

A time already covered by a cycle that started after it is not due again, so the watch never repeats a cycle for the
same work.

**DW4. A missed scheduled cycle.**
- T is the most recent scheduled tick: 17 minutes past hour 0, 6, 12 or 18 UTC, at or before now.
- The cycle is due when it is at least 15 minutes after T and no cycle has started in the workspace at or after T.
- It then runs the scheduled cycle (`runScheduledCycle`): the cycle, the digest of decisions waiting, the escalations,
  and the Monday brief, exactly as the tick does.
- The 15 minutes leave the tick its own start window (180 seconds) with room to spare, so the watch never races the
  tick.

**DW5. A payee lock wait that ended.** It is due when all of these hold:
- the workspace's payee lock is on, with a wait of more than 0 hours;
- a counterparty's address change was confirmed (`address_confirmed_at` at or after `address_changed_at`);
- that change's wait ended (`address_changed_at` plus the hours) after the reference point and at or before now;
- the counterparty has something the wait held back:
  - a payable still open (not `paid`, `received` or `rejected`), or
  - a verified milestone with no transfer yet.

The watch then runs one cycle with the event `payee_lock_wait_ended`. The cycle's follow-up stage reopens the held
payables (`coolingOff` turns false), and the contractor stage decides the milestones.

An unconfirmed address is left out: it cannot be paid yet, and confirming it starts a cycle of its own.

**DW6. One cycle per workspace per run.**
- When both are due, the scheduled cycle runs, because it does everything the event cycle would.
- A cycle already running is reported as `running`. If it started before the due time, the next run finds the work
  still due, since the reference point is still earlier.
- The watch writes nothing itself, calls no model, and runs no cycle where nothing is due.

**DW7. Time budget.**
- Up to four workspaces are checked at once, as in the tick.
- No workspace's check or cycle starts more than 180 seconds into the run. One left over is skipped, since nothing was
  written, and the next run picks it up 5 minutes later.

**DW8. What the workspace sees.**
- After the wait ends, a payment is decided within about 5 minutes, not within a minute. The Contractors card's
  "Payee lock wait" line says "within five minutes after that".
- The guide says the same.
- A `cycle_complete` entry's `events` can include `payee_lock_wait_ended`.

## Not in this change

- Other times that pass without an event (a recurring bill's due day, a scheduled payment's day) keep the tick:
  - the first cycle of the day makes or pays them;
  - DW4 covers a tick that missed.
- No change to the tick's own period or to the event-driven cycles.

## Tests

`tests/due-watch.test.ts` covers:
- the reference point, including a workspace with no cycle;
- a missed tick before and after the 15 minutes;
- a lock wait that ended before or after the latest cycle, unconfirmed, with nothing open, or with the lock off or
  set to 0 hours;
- precedence when both are due;
- running, paused, payments off, a failure in one workspace, the time budget.

`tests/supabase-cron.test.ts` covers the new job. `tests/due-watch-route.test.ts` covers the bearer, the rate limit and
the response.
