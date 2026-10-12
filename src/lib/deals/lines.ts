/**
 * A deal's lines as they stand (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D7, D9, D10, D14): what each
 * line is now, which may be released, which the agent releases on its day, and the deal's figures. Browser-safe and
 * pure: the deal page, the Deals section and the cycle read the same answers.
 */

export type LineStatus = "planned" | "released" | "superseded" | "cancelled";

export interface DealLine {
  id: string;
  position: number;
  /** A charge is invoiced to the customer; a credit (negative) is owed back to them and never released (D8). */
  kind: "charge" | "credit";
  label: string;
  invoiceOn: string;
  dueOn: string;
  /** In the deal's currency's minor units; negative for a credit. */
  amountMinor: number;
  roundingMinor: number;
  status: LineStatus;
  /** The version that added it, and the one that ended it (superseded or cancelled). */
  addedIn: number;
  endedIn: number | null;
  /** The line it replaces, when a version moved or changed one. */
  replaces: string | null;
  releasedAt: string | null;
  releasedVia: "person" | "schedule" | null;
  /** The receivable made from it, when one was: its id, its status, its due date. */
  receivable: { id: string; status: string; dueDate: string } | null;
}

export interface DealFacts {
  id: string;
  status: "active" | "cancelled";
  /** The current version. */
  version: number;
  totalMinor: number;
  currency: string;
  startsOn: string;
  termsDays: number;
  autoRelease: boolean;
  /** Every line the deal ever had, ended ones included. */
  lines: DealLine[];
}

/**
 * `planned`: not invoiced yet. `released`: a receivable, not due yet. `overdue`: a receivable past its due date.
 * `paid`: its receivable was paid. `not_made`: released, but its receivable was never made (a request that died), so it
 * is released again. `credit`: owed back to the customer. `superseded` and `cancelled`: ended by a later version.
 */
export type LineState = "planned" | "released" | "overdue" | "paid" | "not_made" | "credit" | "superseded" | "cancelled";

const PAID = new Set(["received", "paid"]);

/** The lines in force: neither superseded nor cancelled. */
export function inForce(lines: DealLine[]): DealLine[] {
  return lines.filter((line) => line.status === "planned" || line.status === "released");
}

const byDay = (a: DealLine, b: DealLine) => a.invoiceOn.localeCompare(b.invoiceOn) || a.position - b.position;

export function lineState(line: DealLine, today: string): LineState {
  if (line.status === "superseded" || line.status === "cancelled") return line.status;
  if (line.kind === "credit") return "credit";
  if (line.status === "planned") return "planned";
  if (!line.receivable) return "not_made";
  if (PAID.has(line.receivable.status)) return "paid";
  const due = (line.receivable.dueDate || line.dueOn).slice(0, 10);
  return due < today ? "overdue" : "released";
}

/** Why a line cannot be released now; null when it can (D10). */
export type ReleaseRefusal = "ended" | "credit" | "released" | "deal_cancelled";

export function releaseRefusal(deal: Pick<DealFacts, "status">, line: DealLine): ReleaseRefusal | null {
  if (line.status === "superseded" || line.status === "cancelled") return "ended";
  if (line.kind === "credit") return "credit";
  // Released and made: done. Released but never made: releasing it again makes the receivable.
  if (line.status === "released") return line.receivable ? "released" : null;
  if (deal.status === "cancelled") return "deal_cancelled";
  return null;
}

/**
 * What the agent releases at a cycle (D10): nothing unless the deal's switch is on; then every planned charge whose
 * invoice day has come, and any released line whose receivable was never made, in the order of their days.
 */
export function dueForRelease(deal: DealFacts, today: string): DealLine[] {
  if (!deal.autoRelease || deal.status !== "active") return [];
  return deal.lines
    .filter((line) => releaseRefusal(deal, line) === null && (line.status === "released" || line.invoiceOn <= today))
    .sort(byDay);
}

export interface DealSummary {
  /** What the lines in force add up to: the current version's total. */
  totalMinor: number;
  /** Charges made receivables. */
  releasedMinor: number;
  /** Of those, paid. */
  paidMinor: number;
  /** Released and not paid: money expected, never cash (D14). */
  outstandingMinor: number;
  /** Of that, past its due date. */
  overdueMinor: number;
  /** Charges not invoiced yet. */
  plannedMinor: number;
  /** Owed back to the customer: zero or negative. */
  creditMinor: number;
  /** The next planned charge by its invoice day; null when none is left. */
  next: DealLine | null;
}

export function dealSummary(deal: DealFacts, today: string): DealSummary {
  const lines = inForce(deal.lines);
  const sum = (rows: DealLine[]) => rows.reduce((total, line) => total + line.amountMinor, 0);
  const states = lines.map((line) => [line, lineState(line, today)] as const);
  const of = (...wanted: LineState[]) => states.filter(([, state]) => wanted.includes(state)).map(([line]) => line);
  const released = of("released", "overdue", "paid", "not_made");
  const paid = of("paid");
  const planned = of("planned");
  return {
    totalMinor: sum(lines),
    releasedMinor: sum(released),
    paidMinor: sum(paid),
    outstandingMinor: sum(released) - sum(paid),
    overdueMinor: sum(of("overdue")),
    plannedMinor: sum(planned),
    creditMinor: sum(of("credit")),
    next: [...planned].sort(byDay)[0] ?? null,
  };
}
