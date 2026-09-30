# Event-driven agent cycles

Date: 2026-09-30. Status: approved for implementation (decided under the standing autonomy grant;
rulings carry their cost if wrong).

## 1. Why

The agent decides only when a cycle runs, and a cycle runs every six hours from the scheduler or
when a person presses "Run cycle". An invoice added at 09:00 waits until the next slot, often
hours, before the agent looks at it. That makes the agent read as a batch job on a timer.

After this change, the workspace's own events start a cycle: something that gives the agent a
decision to make starts one within seconds. The six-hourly schedule stays as the sweeper for
everything time alone changes, such as due dates, re-screening and reserve moves.

## 2. Events

| Event | Raised by | Why the agent has something to do |
|---|---|---|
| `invoice_added` | `createInvoiceAction`, `importInvoicesAction` (one per import) | a new payable to decide |
| `milestone_verified` | `manualMilestoneVerificationAction`, when it verifies | a milestone ready to release |
| `payable_returned` | `returnInvoiceAction` | a person handed the payable back to the agent |
| `address_confirmed` | `confirmCounterpartyAddressAction` | payments held on an unconfirmed address may proceed |
| `agent_resumed` | `resumeAgentAction` | work that waited while the agent was paused |
| `sample_loaded` | `loadSampleDataAction` | sample payables to decide |

Some actions are not events. Approve-and-pay and reject finish the payable themselves. Adding a
counterparty or changing a limit gives the agent nothing to decide. Neither does funds arriving: a
cycle decides only pending and matched payables, so one held for want of funds is not decided again
by a cycle.

## 3. Behaviour

- **E1: after the response.** The action raises the event after its write succeeds. The cycle runs
  in `after()`, so it never delays the action's response or changes its result. Outside a request,
  such as a script or a test, `after` throws and nothing happens.
- **E2: one cycle per burst.** Events for the same workspace on one instance within 2 seconds share
  one cycle, and the cycle records every event kind that led to it, without duplicates.
- **E3: one cycle at a time.** If the workspace already has a cycle running (`status = 'running'`,
  started within `CYCLE_IN_PROGRESS_MS`, the 15 minutes the console's balance refresh already uses
  for the same question), the event cycle waits for it, checking every 5 seconds for up to 90 seconds. If it is still running after
  that, the event cycle does not start, and the schedule or the next event picks up the work.
  - Cause: the cycle's AP stage does not claim invoices, so two overlapping cycles could each
    record a decision for the same payable.
  - What already guards money: the payment intent's idempotency key stops a double payment.
  - Every cycle refuses to open its run beside a running one (`CycleRunningError`, checked in
    `runAgentCycle`): **Run cycle now** says so, the schedule skips the workspace, and an event
    cycle that loses the race drops quietly.
- **E4: the same limits as the button.** A paused agent refuses the cycle in `begin_cycle_run`, and
  the event is dropped. A sandbox cycle counts against the daily cap (`SANDBOX_DAILY_CYCLES`)
  exactly as "Run cycle" does, and reaching the cap drops the event. Neither case is an error.
- **E5: who and why.** The cycle runs in the workspace's scope with the acting person as
  `triggeredBy`.
  - `cycle_complete` ledger detail gains `trigger`: `"event"`, `"manual"` for "Run cycle", or
    `"schedule"` for the cron.
  - An event cycle's detail also gains `events`, the kinds that led to it.
  - Scripts pass no trigger and record none.
- **E6: budget.** The work fits Vercel Fluid's default `maxDuration` of 300 s, which webhook
  dispatch-soon relies on as well: 2 s debounce, at most 90 s of waiting, and the cycle itself
  (measured p50 16 s, max 56 s on live workspaces over 4 days).
- **E7: failures stay quiet.** A failed event cycle is logged with the workspace id and nothing else.
  Its run row records the failure, as for any cycle.
- **E8: people see it.**
  - The success messages say the agent will look at the change within a minute.
  - The console and invoices pages re-read their data every 20 seconds (`AutoRefresh`), so the
    agent's decision appears without a reload.

## 4. Rulings

- **R1: an in-process debounce, no queue table.** Two instances can each start a cycle for one
  burst. E3's check narrows this, and payment idempotency keeps it from costing money. Cost if
  wrong: an occasional duplicate decision entry, and then a table-backed claim (migration 0039,
  reserved).
- **R2: sandbox workspaces react too**, within their daily cap. A new user who adds an invoice sees
  the agent decide at once, which is the first-run experience the product needs. Cost if wrong: a
  busy sandbox reaches its cap sooner, and the cap's message already explains that.
- **R3: the trigger is recorded in the ledger detail, not in a `cycle_runs` column.** No migration,
  and the signed record is where an auditor looks. Cost if wrong: counting event cycles means
  reading ledger details, not a column.

## 5. Pieces

- `src/lib/agent/cycle-soon.ts`:
  - `runCycleSoon({ orgId, userId, sandbox, kind })`;
  - the per-workspace pending map, the debounce, and the wait for a running cycle;
  - `withOrg(orgId, …, { userId })` inside `after`.
- `src/lib/agent/orchestrator.ts`: `runAgentCycle` takes an optional `trigger`, and
  `cycle_complete` records it.
- `src/app/actions/agent.ts` passes `manual` and `src/lib/agent/cron.ts` passes `schedule`.
- The seven actions in §2 raise their event. Their success copy changes where it names what
  happens next.
- `AutoRefresh` on `/o/[slug]/console` and `/o/[slug]/invoices`.
- Docs: the agent-cycle and first-payment guides say that a cycle starts on these events.

## 6. Tests

- `cycle-soon`, with `after` mocked and fake timers:
  - one cycle per burst, with the union of event kinds;
  - a separate cycle per workspace;
  - waits for a running cycle, then runs;
  - gives up after 90 s;
  - drops paused and capped workspaces quietly;
  - logs other failures;
  - does nothing without a request scope;
  - passes the sandbox cap and the trigger.
- Orchestrator: `cycle_complete` detail carries `trigger`, and `events` for an event cycle.
- Each action raises its event only after a successful write, and never when it refuses.

## 7. Rollout

No migration and no new setting. After deploy:

1. In a live workspace, add an invoice and do not press "Run cycle".
2. A `cycle_complete` with `trigger: "event"`, `events: ["invoice_added"]` follows within 60 seconds,
   and the invoice has a signed decision.
3. Record the times here.

## 8. Rollout record

(pending)
