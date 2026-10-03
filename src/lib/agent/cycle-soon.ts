import { after } from "next/server";
import { withOrg } from "../dal/scope";
import { CycleRunningError, hasRunningCycle } from "./cycle-running";
import { runAgentCycle } from "./orchestrator";
import { AgentPausedError } from "./pause";
import { SANDBOX_DAILY_CYCLES, SandboxCapReachedError } from "./sandbox-cap";

/**
 * Event-driven cycles (docs/superpowers/specs/2026-09-30-event-driven-cycles-design.md).
 *
 * Something that gives the agent a decision to make — an invoice added, a
 * payable handed back, an address confirmed — starts a cycle within seconds,
 * instead of waiting for the six-hourly schedule. The cycle runs after the
 * response (E1), so the action that raised the event is never slower and its
 * result never changes; outside a request `after` throws and nothing happens.
 *
 * Events for one workspace within a short moment share one cycle (E2), and a
 * cycle already running is waited for rather than overlapped (E3): the cycle's
 * AP stage does not claim invoices, so two at once could each record a
 * decision for the same payable; `runAgentCycle` itself refuses to start
 * beside one, for every trigger. A paused agent or a sandbox that has used its
 * daily cycles drops the event quietly (E4).
 *
 * The debounce is per instance (R1). Two instances can each start a cycle for
 * one burst; the running check narrows that, and a payment's idempotency key
 * keeps it from paying twice.
 */

export type CycleEventKind =
  | "invoice_added"
  | "milestone_verified"
  | "milestone_added"
  | "payable_returned"
  | "details_added"
  | "address_confirmed"
  | "match_dismissed"
  | "payment_received"
  | "limit_raised"
  | "recurring_added"
  | "budget_raised"
  | "cash_returned"
  | "agent_resumed"
  | "sample_loaded";

export interface CycleEvent {
  orgId: string;
  userId: string;
  sandbox: boolean;
  kind: CycleEventKind;
}

const DEBOUNCE_MS = 2_000;
const RUNNING_POLL_MS = 5_000;
const RUNNING_WAIT_MS = 90_000;

interface Pending {
  userId: string;
  sandbox: boolean;
  kinds: Set<CycleEventKind>;
}

/** The workspaces with a cycle scheduled on this instance and not yet started. */
const pending = new Map<string, Pending>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SKIPPED = "event cycle skipped: a cycle is still running";

/** Schedules a cycle for the event's workspace after the response, or adds the event to the one already scheduled. */
export function runCycleSoon(event: CycleEvent): void {
  const held = pending.get(event.orgId);
  if (held) {
    held.kinds.add(event.kind);
    return;
  }
  try {
    after(() => runPending(event.orgId));
    pending.set(event.orgId, { userId: event.userId, sandbox: event.sandbox, kinds: new Set([event.kind]) });
  } catch {
    // No request scope (a script, a test): the schedule picks the work up.
  }
}

/** `runCycleSoon` for an action that has authorized its caller. */
export function raiseCycleEvent(
  access: { user: { id: string }; membership: { orgId: string; mode: "sandbox" | "live" } },
  kind: CycleEventKind
): void {
  runCycleSoon({ orgId: access.membership.orgId, userId: access.user.id, sandbox: access.membership.mode === "sandbox", kind });
}

async function runPending(orgId: string): Promise<void> {
  await sleep(DEBOUNCE_MS);
  const entry = pending.get(orgId);
  pending.delete(orgId);
  if (!entry) return;
  try {
    // The wait and the cycle each enter the workspace's scope: the cycle reads
    // the workspace (and its signing key) when it starts, not before the wait.
    if (!(await withOrg(orgId, waitForRunningCycle, { userId: entry.userId }))) {
      console.info(SKIPPED, orgId);
      return;
    }
    await withOrg(
      orgId,
      () =>
        runAgentCycle({
          triggeredBy: entry.userId,
          dailyCap: entry.sandbox ? SANDBOX_DAILY_CYCLES : undefined,
          trigger: { kind: "event", events: [...entry.kinds].sort() },
        }),
      { userId: entry.userId }
    );
  } catch (error) {
    // Another cycle started between the wait and this one's start: it decides the same work.
    if (error instanceof CycleRunningError) {
      console.info(SKIPPED, orgId);
      return;
    }
    if (error instanceof AgentPausedError || error instanceof SandboxCapReachedError) return;
    console.error("event cycle failed", orgId, error instanceof Error ? error.message : String(error));
  }
}

/** True once the workspace has no cycle running; false if one still is after 90 seconds. */
async function waitForRunningCycle(): Promise<boolean> {
  const deadline = Date.now() + RUNNING_WAIT_MS;
  for (;;) {
    if (!(await hasRunningCycle())) return true;
    if (Date.now() + RUNNING_POLL_MS > deadline) return false;
    await sleep(RUNNING_POLL_MS);
  }
}

/** Test seam: forget scheduled cycles that will never run under test. */
export function resetCycleSoonForTests(): void {
  pending.clear();
}
