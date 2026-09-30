# Event-Driven Cycles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace event (an invoice added, a milestone verified, a payable returned, an address confirmed, the agent resumed, funds arrived, sample data loaded) starts an agent cycle within seconds, after the response.

**Architecture:** `src/lib/agent/cycle-soon.ts` collects events per workspace in process and schedules one cycle per burst with `after()`. The cycle runs inside `withOrg`, waits for a running cycle to finish (up to 90 s), then calls `runAgentCycle` with a `trigger`, which `cycle_complete` records. The actions raise the events after their writes succeed.

**Tech Stack:** Next.js `after()`, Supabase via the DAL, Vitest with fake timers.

**Spec:** `docs/superpowers/specs/2026-09-30-event-driven-cycles-design.md`

## Global Constraints

- No migration. No new environment setting.
- An event never changes an action's result or delays its response. Outside a request it does nothing.
- A running cycle means `cycle_runs.status = 'running'` and `started_at` within `CYCLE_IN_PROGRESS_MS`. This constant is exported from `src/lib/agent/balances.ts` (15 minutes) and is used as is.
- The debounce is 2 s. The wait for a running cycle polls every 5 s and gives up at 90 s.
- A sandbox passes `dailyCap: SANDBOX_DAILY_CYCLES`. `AgentPausedError` and `SandboxCapReachedError` are dropped silently.
- `cycle_complete` detail gains `trigger` (`"event" | "manual" | "schedule"`), and `events` (sorted, unique) for event cycles.
- Commit messages are neutral. Only `src/app/actions/intake.ts` and `src/components/intake/InvoiceIntake.tsx` overlap with the A1 branch, so change only lines that are needed there.

## Review Focus

- A burst of events while a cycle for the same workspace is already scheduled: one cycle, with every kind.
- An event raised while the previous event cycle is running: a second cycle that waits, then runs, so the new invoice is decided.
- A receivable invoice: it raises nothing, because the agent has nothing to decide.
- A crashed cycle left `running`: the event cycle gives up after 90 s instead of hanging until `maxDuration`.
- An action that refuses (bad input, unauthorized): it raises nothing.

---

### Task 1: `trigger` on `runAgentCycle` and `cycle_complete`

**Files:** Modify `src/lib/agent/orchestrator.ts` (options, `CycleContext`, the `cycle_complete` detail), `src/app/actions/agent.ts` (pass `{ kind: "manual" }`) and `src/lib/agent/cron.ts` (`runScheduledCycle` passes `{ kind: "schedule" }`). Test: extend the test that asserts `cycle_complete` detail (`tests/cycle-report.test.ts` or the nearest full-cycle test).

- [ ] Write a failing test: the detail carries `trigger: "event", events: [...]` for an event trigger, `trigger: "manual"` for manual, and no `trigger` key when none is given.
- [ ] Run it and watch it fail.
- [ ] Implement:
  - `export type CycleTrigger = { kind: "schedule" } | { kind: "manual" } | { kind: "event"; events: string[] };`
  - `runAgentCycle(options: { triggeredBy?; dailyCap?; trigger?: CycleTrigger })`
  - `ctx.trigger`
  - in the detail: `...(trigger ? { trigger: trigger.kind } : {}), ...(trigger?.kind === "event" ? { events: trigger.events } : {})`
- [ ] Run it and watch it pass. Update `tests/agent-action.test.ts` and `tests/cron.test.ts` if they pin `runAgentCycle`'s arguments.
- [ ] Commit: "Record what started each agent cycle".

### Task 2: `src/lib/agent/cycle-soon.ts`

**Interfaces:**
- `CycleEventKind` is one of `"invoice_added" | "milestone_verified" | "payable_returned" | "address_confirmed" | "agent_resumed" | "funds_arrived" | "sample_loaded"`.
- `runCycleSoon(event: { orgId: string; userId: string; sandbox: boolean; kind: CycleEventKind }): void`.
- `raiseCycleEvent(access: { user: { id: string }; membership: { orgId: string; mode: "sandbox" | "live" } }, kind): void`.
- `resetCycleSoonForTests(): void`.

- [ ] Write failing tests (`tests/cycle-soon.test.ts`). Mock `next/server`'s `after` to capture callbacks, mock `@/lib/dal/scope`'s `withOrg` to run inside an org test context over a fake Supabase client, and mock `./orchestrator`'s `runAgentCycle`. Cases:
  - One event → one `after` → one cycle after 2 s, with `trigger { kind: "event", events: ["invoice_added"] }`, `triggeredBy` and no cap for a live workspace.
  - Three events in the burst → one `after`, events sorted and unique.
  - Two workspaces → two cycles.
  - An event after the debounce fired → a second `after`.
  - A running row → it waits, polls every 5 s, and runs once the row is gone.
  - Still running at 90 s → no cycle, and one `console.info`.
  - A sandbox → `dailyCap: SANDBOX_DAILY_CYCLES`.
  - `AgentPausedError` and `SandboxCapReachedError` → no `console.error`.
  - Another error → `console.error` naming the workspace id.
  - `after` throws → no throw, nothing pending, and a later event can still schedule.
- [ ] Run them and watch them fail.
- [ ] Implement the module as the spec describes (pending map; `after(() => runPending(orgId))` inside a try; `sleep` via `setTimeout`).
- [ ] Run them and watch them pass.
- [ ] Commit: "Start an agent cycle soon after a workspace event".

### Task 3: Raise the events from the actions

**Files:**
- `src/app/actions/intake.ts`: create (payable only), import (when any row is a payable), confirm address (when it confirmed).
- `src/app/actions/milestones.ts`: verify, when it verifies an unpaid milestone.
- `src/app/actions/approvals.ts`: return.
- `src/app/actions/agent.ts`: resume.
- `src/app/actions/treasury.ts` and `src/lib/agent/balances.ts`: the refresh result gains `rose: boolean` when refreshed; the event fires when it rose.
- `src/app/actions/sample-data.ts`: load.
- Copy:
  - the invoice form hint in `InvoiceIntake.tsx`;
  - the return message;
  - the sample-data message;
  - "Invoice added for X." gains "The agent will decide on it within a minute." for payables.
- Tests: extend each action's test file to mock `@/lib/agent/cycle-soon` and assert the event (or its absence), and update pinned messages.

- [ ] Write failing tests per action (raised with the right kind after success; not raised on refusal or for a receivable).
- [ ] Run them and watch them fail.
- [ ] Implement.
- [ ] Run the action test files and `tests/balance-refresh.test.ts`.
- [ ] Commit: "Raise agent cycle events from the actions that give it work".

### Task 4: Pages and docs

- [ ] Add `AutoRefresh intervalMs={20_000}` to `src/app/o/[slug]/console/page.tsx` and `src/app/o/[slug]/invoices/page.tsx`.
- [ ] Update the first-payment guide: the quoted form hint, and a paragraph saying that the agent decides within a minute of adding an invoice, without pressing Run cycle. `tests/docs-guides.test.ts` pins quoted UI strings; update it where the quote changed.
- [ ] Run `npm run verify` and watch it pass.
- [ ] Commit: "Refresh the console and invoices while the agent works, and say so in the guide".

### Task 5: Ship

- [ ] Final whole-branch review. Then PR, CI green, merge on the partner's word.
- [ ] In a live workspace, add an invoice without pressing Run cycle. A `cycle_complete` with `trigger: "event"` follows within 60 s. Record it in spec §8, and set roadmap row A2 to DONE.
