import type { ExternalBill, SourceStatus } from "./provider";

/**
 * One bill, one row, never two payables (docs/superpowers/specs/2026-10-12-xero-connector-design.md X9, X10): what to do
 * with a bill read from a provider, given the row kept for it. Pure.
 */

export type ReviewState = "review" | "added" | "dismissed";

/** What is kept of a bill already read. */
export interface StagedBill {
  id: string;
  externalVersion: string | null;
  sourceStatus: SourceStatus;
  reviewState: ReviewState;
}

export type BillPlan =
  | { kind: "ignore"; reason: "older" | "closed" | "outside" }
  | { kind: "insert" }
  /** Update the row's facts and what the provider says of it; `closedAfterAdded` once a bill already added is closed there. */
  | { kind: "update"; closedAfterAdded: boolean };

/** Due, or dated, on or after the window's first day (`YYYY-MM-DD`); a bill with neither day is let in, to say so. */
export function inWindow(bill: Pick<ExternalBill, "dueOn" | "issuedOn">, windowFrom: string): boolean {
  if (bill.dueOn === null && bill.issuedOn === null) return true;
  return (bill.dueOn !== null && bill.dueOn >= windowFrom) || (bill.issuedOn !== null && bill.issuedOn >= windowFrom);
}

const CLOSED: ReadonlySet<SourceStatus> = new Set(["paid", "voided", "deleted"]);

export function planBill(row: StagedBill | null, bill: ExternalBill, windowFrom: string): BillPlan {
  if (row === null) {
    if (bill.status !== "open") return { kind: "ignore", reason: "closed" };
    return inWindow(bill, windowFrom) ? { kind: "insert" } : { kind: "ignore", reason: "outside" };
  }
  // Versions are ISO instants in one format, so they compare as text: an equal or older one is already known.
  if (row.externalVersion !== null && bill.version <= row.externalVersion) return { kind: "ignore", reason: "older" };
  const closedAfterAdded = row.reviewState === "added" && !CLOSED.has(row.sourceStatus) && CLOSED.has(bill.status);
  return { kind: "update", closedAfterAdded };
}
