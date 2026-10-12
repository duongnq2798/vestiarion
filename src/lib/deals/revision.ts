import { inForce, type DealFacts, type DealLine } from "./lines";
import { MAX_TOTAL_MINOR } from "./money";
import { addDays, checkLines, LABEL_MAX } from "./schedule";

/**
 * A change to a signed deal (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D7-D9): a new version that ends
 * planned lines and adds new ones. A released line, and the receivable made from it, is never part of a change: it
 * stays in force as it is, and the new total counts it. Browser-safe and pure: the deal page shows the change as the
 * person edits it, and the server plans it again from the deal as it is before `revise_deal` writes it.
 */

/** A line of the proposed schedule: a planned line kept or changed (by its id), or a new one. */
export interface ProposedLine {
  id?: string;
  kind: "charge" | "credit";
  label: string;
  invoiceOn: string;
  amountMinor: number;
}

export type RevisionChange =
  | { what: "added"; label: string; invoiceOn: string; amountMinor: number }
  | { what: "credit"; label: string; amountMinor: number }
  | { what: "removed"; lineId: string; label: string; amountMinor: number }
  | { what: "moved"; lineId: string; label: string; from: string; to: string }
  | { what: "amount"; lineId: string; label: string; fromMinor: number; toMinor: number }
  | { what: "renamed"; lineId: string; label: string; from: string };

export interface AddedLine {
  position: number;
  kind: "charge" | "credit";
  label: string;
  invoiceOn: string;
  dueOn: string;
  amountMinor: number;
  roundingMinor: 0;
  /** The planned line it replaces, when it is that line moved or changed. */
  replaces: string | null;
}

export interface Revision {
  kind: "revised" | "reopened" | "cancelled";
  fromVersion: number;
  toVersion: number;
  fromTotalMinor: number;
  toTotalMinor: number;
  differenceMinor: number;
  /** Planned lines this version ends: `superseded` when a new line replaces it, `cancelled` when it is gone. */
  end: Array<{ id: string; status: "superseded" | "cancelled" }>;
  add: AddedLine[];
  changes: RevisionChange[];
}

export type RevisionProblemCode = "status" | "total" | "released_line" | "unknown_line" | "credit" | "no_change" | "no_lines" | "line_count" | "line_label" | "line_date" | "line_amount" | "sum" | "too_small" | "starts_on" | "terms" | "deposit_pct" | "delivery_on" | "milestone_count" | "months" | "day_of_month";

export type RevisionResult = { ok: true; revision: Revision } | { ok: false; code: RevisionProblemCode; message: string };

const fail = (code: RevisionProblemCode, message: string): RevisionResult => ({ ok: false, code, message });

const latest = (a: string, b: string) => (a > b ? a : b);
const byPosition = (a: DealLine, b: DealLine) => a.position - b.position;

/**
 * The planned lines after the price changes to `totalMinor` (D8). Up: credits owed back are taken back first, from the
 * last, then one correcting line for the rest, on the last planned charge's invoice day, or today when none is left. Down:
 * planned charges are reduced from the last backwards (one reduced to nothing is dropped), and what the released lines
 * already exceed becomes a credit owed to the customer. Lines keep their ids, so the version shows each change.
 */
export function proposeCorrection(deal: DealFacts, totalMinor: number, today: string): ProposedLine[] {
  const planned = inForce(deal.lines).filter((line) => line.status === "planned").sort(byPosition);
  const proposal: ProposedLine[] = planned.map(({ id, kind, label, invoiceOn, amountMinor }) => ({ id, kind, label, invoiceOn, amountMinor }));
  const charges = proposal.filter((line) => line.kind === "charge");
  const credits = proposal.filter((line) => line.kind === "credit");
  const day = latest(today, deal.startsOn);
  let delta = totalMinor - deal.totalMinor;
  if (delta > 0) {
    for (const credit of [...credits].reverse()) {
      const back = Math.min(delta, -credit.amountMinor);
      credit.amountMinor += back;
      delta -= back;
    }
    if (delta > 0) proposal.push({ kind: "charge", label: "Price change", invoiceOn: charges.at(-1)?.invoiceOn ?? day, amountMinor: delta });
  } else if (delta < 0) {
    let cut = -delta;
    for (const charge of [...charges].reverse()) {
      const less = Math.min(cut, charge.amountMinor);
      charge.amountMinor -= less;
      cut -= less;
    }
    if (cut > 0) proposal.push({ kind: "credit", label: "Credit for price change", invoiceOn: day, amountMinor: -cut });
  }
  return proposal.filter((line) => line.amountMinor !== 0);
}

/**
 * The version that takes the deal to `totalMinor` with the planned lines `lines` (D7, D8): `revised` for an active deal,
 * `reopened` for a cancelled one. Each proposed line naming a planned line keeps it when nothing about it changed, and
 * otherwise ends it as `superseded` by a new line that `replaces` it; a planned line left out ends as `cancelled`; a line
 * with no id is added. Released lines are never in a proposal. The released lines and the proposed ones must add up to
 * the new total exactly, and released lines and credits together never go below zero.
 */
export function planRevision(deal: DealFacts, change: { kind: "revised" | "reopened"; totalMinor: number; lines: ProposedLine[] }): RevisionResult {
  if (change.kind === "revised" && deal.status !== "active") return fail("status", "This deal was cancelled. Reopen it to change it.");
  if (change.kind === "reopened" && deal.status !== "cancelled") return fail("status", "Only a cancelled deal is reopened.");
  if (!Number.isSafeInteger(change.totalMinor) || change.totalMinor <= 0 || change.totalMinor > MAX_TOTAL_MINOR) {
    return fail("total", "Give the deal's new total, above zero. To stop the deal, cancel it.");
  }

  const current = inForce(deal.lines);
  const releasedLines = current.filter((line) => line.status === "released");
  const planned = new Map(current.filter((line) => line.status === "planned").map((line) => [line.id, line]));
  const named = new Set<string>();
  for (const proposed of change.lines) {
    if (proposed.id === undefined) continue;
    if (releasedLines.some((line) => line.id === proposed.id)) {
      return fail("released_line", "A released line stays as it is. Change the lines not invoiced yet, or add a correcting line.");
    }
    if (!planned.has(proposed.id) || named.has(proposed.id)) return fail("unknown_line", "This deal changed since you opened it. Reload the page to see it as it is now.");
    named.add(proposed.id);
  }
  if (change.kind === "reopened" && !change.lines.some((line) => line.kind === "charge")) return fail("no_lines", "Add the lines still to invoice.");

  const problem = checkLines(
    [
      ...releasedLines.map(({ label, invoiceOn, amountMinor, kind }) => ({ label, invoiceOn, amountMinor, kind })),
      ...change.lines.map(({ label, invoiceOn, amountMinor, kind }) => ({ label, invoiceOn, amountMinor, kind })),
    ],
    { totalMinor: change.totalMinor, currency: deal.currency, startsOn: deal.startsOn }
  );
  if (problem) return fail(problem.code, problem.message);
  const invoiced = releasedLines.reduce((sum, line) => sum + line.amountMinor, 0);
  const credited = change.lines.filter((line) => line.kind === "credit").reduce((sum, line) => sum + line.amountMinor, 0);
  if (invoiced + credited < 0) return fail("credit", "A credit is only for money already invoiced: it cannot be more than the released lines.");

  const end: Revision["end"] = [];
  const add: AddedLine[] = [];
  const changes: RevisionChange[] = [];
  let position = Math.max(0, ...deal.lines.map((line) => line.position));
  const added = (proposed: ProposedLine, replaces: string | null) =>
    add.push({
      position: (position += 1),
      kind: proposed.kind,
      label: proposed.label.trim(),
      invoiceOn: proposed.invoiceOn,
      dueOn: addDays(proposed.invoiceOn, deal.termsDays),
      amountMinor: proposed.amountMinor,
      roundingMinor: 0,
      replaces,
    });

  for (const line of [...planned.values()].sort(byPosition)) {
    const proposed = change.lines.find((candidate) => candidate.id === line.id);
    if (!proposed) {
      end.push({ id: line.id, status: "cancelled" });
      changes.push({ what: "removed", lineId: line.id, label: line.label, amountMinor: line.amountMinor });
      continue;
    }
    const label = proposed.label.trim();
    const same = proposed.kind === line.kind && label === line.label && proposed.invoiceOn === line.invoiceOn && proposed.amountMinor === line.amountMinor;
    if (same) continue;
    end.push({ id: line.id, status: "superseded" });
    added(proposed, line.id);
    if (proposed.invoiceOn !== line.invoiceOn) changes.push({ what: "moved", lineId: line.id, label, from: line.invoiceOn, to: proposed.invoiceOn });
    if (proposed.amountMinor !== line.amountMinor) changes.push({ what: "amount", lineId: line.id, label, fromMinor: line.amountMinor, toMinor: proposed.amountMinor });
    if (label !== line.label) changes.push({ what: "renamed", lineId: line.id, label, from: line.label });
  }
  for (const proposed of change.lines.filter((candidate) => candidate.id === undefined)) {
    added(proposed, null);
    const label = proposed.label.trim().slice(0, LABEL_MAX);
    changes.push(
      proposed.kind === "credit"
        ? { what: "credit", label, amountMinor: proposed.amountMinor }
        : { what: "added", label, invoiceOn: proposed.invoiceOn, amountMinor: proposed.amountMinor }
    );
  }

  if (change.kind === "revised" && end.length === 0 && add.length === 0 && change.totalMinor === deal.totalMinor) {
    return fail("no_change", "Nothing changed. Change the total or a line not invoiced yet.");
  }
  return {
    ok: true,
    revision: {
      kind: change.kind,
      fromVersion: deal.version,
      toVersion: deal.version + 1,
      fromTotalMinor: deal.totalMinor,
      toTotalMinor: change.totalMinor,
      differenceMinor: change.totalMinor - deal.totalMinor,
      end,
      add,
      changes,
    },
  };
}

/**
 * Cancelling a deal (D9): every planned charge ends as `cancelled`; released lines and credits stay, so the version's
 * total is what was invoiced less what is owed back.
 */
export function planCancel(deal: DealFacts): RevisionResult {
  if (deal.status !== "active") return fail("status", "This deal is cancelled already.");
  const current = inForce(deal.lines);
  const stopped = current.filter((line) => line.status === "planned" && line.kind === "charge").sort(byPosition);
  const toTotalMinor = current.filter((line) => !stopped.includes(line)).reduce((sum, line) => sum + line.amountMinor, 0);
  return {
    ok: true,
    revision: {
      kind: "cancelled",
      fromVersion: deal.version,
      toVersion: deal.version + 1,
      fromTotalMinor: deal.totalMinor,
      toTotalMinor,
      differenceMinor: toTotalMinor - deal.totalMinor,
      end: stopped.map((line) => ({ id: line.id, status: "cancelled" as const })),
      add: [],
      changes: stopped.map((line) => ({ what: "removed" as const, lineId: line.id, label: line.label, amountMinor: line.amountMinor })),
    },
  };
}
