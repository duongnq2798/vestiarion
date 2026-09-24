/**
 * The record that a cycle *started*, kept independently of whether it finished.
 *
 * `cycle_runs` used to be written once, at the very end. Everything before that
 * point — screening verdicts, reopened invoices, escalations, executed
 * payments, ledger entries — was already committed. A transient failure
 * therefore left the book moved and the telemetry insisting nothing had
 * happened: ledger entries with no cycle to attribute them to, an undercounted
 * eval, and an operator holding an error message with no way to tell how far
 * the run had got. That is not hypothetical; it happened during development,
 * when a network blip wrote four escalations and then killed the run.
 *
 * This applies the same discipline `payment_intents` already applies to the
 * payment leg: write the intent before acting, write the outcome after. A row
 * left in `running` is a crashed cycle — which is a fact worth having, and
 * strictly better than a cycle that leaves no evidence of itself at all.
 *
 * The stage ladder is a breadcrumb, not a state machine. It answers the only
 * question an operator actually has after a failure: how far did it get before
 * it fell over, and what had already been written by then.
 */

export const CYCLE_STAGES = [
  "reconcile",
  "compliance",
  "follow_up",
  "ap",
  "contractors",
  "treasury",
  "forecast",
] as const;

export type CycleStage = (typeof CYCLE_STAGES)[number];

export interface StageRecord {
  stage: CycleStage;
  status: "completed" | "failed";
  ms: number;
  error?: string;
}

/**
 * Tracks which stage is in flight and how long each took. Pure and in-memory:
 * the caller decides when to persist, because a journal that needed the
 * database to record a database failure would be useless exactly when it
 * mattered.
 */
export class CycleJournal {
  private records: StageRecord[] = [];
  private current: CycleStage | null = null;
  private startedAt = 0;

  /** Marks a stage as begun, closing the previous one as completed. */
  enter(stage: CycleStage, now: number = Date.now()): void {
    this.closeCurrent("completed", now);
    this.current = stage;
    this.startedAt = now;
  }

  /** Closes the final stage. Call once the cycle body has finished cleanly. */
  finish(now: number = Date.now()): void {
    this.closeCurrent("completed", now);
  }

  /** Closes the in-flight stage as the point of failure. */
  fail(error: unknown, now: number = Date.now()): void {
    this.closeCurrent("failed", now, messageOf(error));
  }

  private closeCurrent(status: StageRecord["status"], now: number, error?: string): void {
    if (this.current == null) return;
    const record: StageRecord = {
      stage: this.current,
      status,
      ms: Math.max(0, now - this.startedAt),
    };
    if (error) record.error = error;
    this.records.push(record);
    this.current = null;
  }

  /** The stage that was in flight, or the last one to fail. */
  failedStage(): CycleStage | null {
    return this.current ?? this.records.find((r) => r.status === "failed")?.stage ?? null;
  }

  stages(): StageRecord[] {
    return this.records.map((record) => ({ ...record }));
  }
}

/**
 * Error text fit for an operator and for a database column: never an empty
 * string, never a stack trace, never unbounded. "TypeError: fetch failed"
 * carries no cause, so the stage name beside it is doing most of the work.
 */
export function messageOf(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message || error.name
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const text = (raw ?? "").trim();
  if (text.length === 0) return "unknown error";
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
