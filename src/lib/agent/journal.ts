/**
 * The record that a cycle *started*, kept independently of whether it finished
 * — and the rule for which stages may still run once one of them has failed.
 *
 * `cycle_runs` used to be written once, at the very end. Everything before that
 * point — screening verdicts, reopened invoices, executed payments, ledger
 * entries — was already committed. A transient failure therefore left the book
 * moved and the telemetry insisting nothing had happened. That is not
 * hypothetical; it happened during development, when a network blip wrote four
 * escalations and then killed the run.
 *
 * Recording a failure was the first half. Surviving one is this half: a
 * screening blip used to take the treasury, the forecast and everything else
 * down with it, even though none of them depend on screening being fresh.
 *
 * The dependency rule is a safety rule, not a convenience one. A treasury agent
 * must **fail closed on anything that authorises money leaving the business,
 * and stay open on anything that only observes or records.** So a stale risk
 * verdict stops payments and releases — that is the whole point of screening —
 * while a sweep between the business's own accounts, and a read-only forecast,
 * are unaffected and still run.
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

/**
 * Which stages must have *succeeded* for a stage to be allowed to run.
 *
 *   reconcile   Nothing. In live mode it is what makes stored balances match
 *               the chain; if it failed, the agent does not know what it holds.
 *   compliance  Nothing. It is the source of risk truth, not a consumer of it.
 *   follow_up   compliance — it reopens invoices by comparing today's risk tier
 *               and limit against the ones a past decision rested on.
 *   ap          reconcile + compliance. Paying a counterparty needs both a
 *               current balance and a current risk verdict. Neither is
 *               negotiable; this is the fail-closed boundary.
 *   contractors reconcile + compliance, for the same reason.
 *   treasury    reconcile. Sweeping moves the business's own money between its
 *               own accounts, so it needs accurate balances but no counterparty
 *               screening at all.
 *   forecast    Nothing. It reads and records; it authorises nothing. It is the
 *               stage most worth keeping alive after a failure, because it is
 *               what tells a human where the cycle left the book.
 */
export const STAGE_REQUIRES: Record<CycleStage, readonly CycleStage[]> = {
  reconcile: [],
  compliance: [],
  follow_up: ["compliance"],
  ap: ["reconcile", "compliance"],
  contractors: ["reconcile", "compliance"],
  treasury: ["reconcile"],
  forecast: [],
};

export interface StageRecord {
  stage: CycleStage;
  status: "completed" | "failed" | "skipped";
  ms: number;
  error?: string;
  /** Why a stage never ran. Always the stage that actually failed. */
  skippedBecause?: string;
}

/** How the cycle as a whole ended. */
export type CycleOutcome = "completed" | "partial" | "failed";

/**
 * Tracks stage outcomes and answers whether the next stage may run.
 *
 * Pure and in-memory: the caller decides when to persist, because a journal
 * that needed the database in order to record a database failure would be
 * useless at exactly the moment it mattered.
 */
export class CycleJournal {
  private records = new Map<CycleStage, StageRecord>();

  /**
   * Whether a stage may run, and if not, which failure is responsible. The
   * reason names the stage that actually broke rather than the nearest
   * dependency, so a skipped forecast does not send an operator hunting
   * through a chain of consequences to find the cause.
   */
  gate(stage: CycleStage): { run: true } | { run: false; because: string } {
    for (const required of STAGE_REQUIRES[stage]) {
      const record = this.records.get(required);
      if (record?.status === "completed") continue;
      const cause =
        record?.status === "skipped" && record.skippedBecause
          ? record.skippedBecause
          : `${required} ${record?.status ?? "did not run"}`;
      return { run: false, because: cause };
    }
    return { run: true };
  }

  completed(stage: CycleStage, ms: number): void {
    this.records.set(stage, { stage, status: "completed", ms: Math.max(0, ms) });
  }

  failed(stage: CycleStage, error: unknown, ms: number): void {
    this.records.set(stage, {
      stage,
      status: "failed",
      ms: Math.max(0, ms),
      error: messageOf(error),
    });
  }

  skipped(stage: CycleStage, because: string): void {
    this.records.set(stage, { stage, status: "skipped", ms: 0, skippedBecause: because });
  }

  /** Every stage that threw, in cycle order. */
  failures(): StageRecord[] {
    return this.stages().filter((record) => record.status === "failed");
  }

  /** The first stage to fail — the cause, as opposed to its consequences. */
  failedStage(): CycleStage | null {
    return this.failures()[0]?.stage ?? null;
  }

  /**
   * `completed` only when every stage ran and succeeded. A cycle that skipped
   * work is `partial`, never `completed`: its counts are real but they stop
   * where the failure stopped them, and reading it as a clean run would
   * understate the book and hide the fault in the same glance.
   */
  outcome(): CycleOutcome {
    const records = this.stages();
    if (records.length === 0) return "failed";
    if (records.every((record) => record.status === "completed")) return "completed";
    return "partial";
  }

  /** One line an operator can act on, or null when nothing went wrong. */
  summary(): string | null {
    const failed = this.failures();
    if (failed.length === 0) return null;
    const skipped = this.stages().filter((record) => record.status === "skipped");
    const head = failed.map((record) => `${record.stage}: ${record.error}`).join("; ");
    return skipped.length === 0
      ? head
      : `${head} (skipped ${skipped.map((record) => record.stage).join(", ")})`;
  }

  stages(): StageRecord[] {
    return CYCLE_STAGES.flatMap((stage) => {
      const record = this.records.get(stage);
      return record ? [{ ...record }] : [];
    });
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
