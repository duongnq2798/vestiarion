import type { OrgDb } from "../dal";

/**
 * Setting a bill's or milestone's money aside in its project (docs/superpowers/specs/2026-10-13-project-budgets-design.md
 * P3, P4): one call to migration 0111's `reserve_project_budget`, which locks the bill or milestone, then the project, so
 * two decisions at once never set aside the same money. Until 0111 runs, no bill or milestone can be in a project, and
 * the answer is `not_ready`.
 */

export type ReserveVia = "entry" | "assignment" | "agent";

/** The project's figures as the reservation found them, before it, in USDC cents. */
export interface ReservedFigures {
  projectId: string;
  projectName: string;
  neededMinor: number;
  budgetMinor: number;
  bufferMinor: number;
  reservedMinor: number;
  paidMinor: number;
  availableMinor: number;
}

export type ReserveAnswer =
  | ({ state: "reserved"; already: boolean; reservationId: string } & ReservedFigures)
  | ({ state: "over" } & ReservedFigures)
  | ({ state: "archived" } & ReservedFigures)
  | { state: "no_project" }
  | { state: "settled"; projectId: string }
  | { state: "not_found" }
  | { state: "not_ready" };

type PostgrestError = { code?: string; message?: string } | null;

/** PostgREST's or Postgres's word that 0111's tables, columns or functions are not there yet. */
export function projectsNotReady(error: PostgrestError): boolean {
  if (!error) return false;
  if (["PGRST202", "PGRST205", "PGRST204", "PGRST200", "42P01", "42703", "42883"].includes(error.code ?? "")) return true;
  return /project/.test(error.message ?? "") && /schema cache|does not exist|could not find/i.test(error.message ?? "");
}

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value));

function figuresOf(raw: Record<string, unknown>): ReservedFigures {
  return {
    projectId: String(raw.projectId),
    projectName: String(raw.projectName ?? ""),
    neededMinor: num(raw.neededMinor),
    budgetMinor: num(raw.budgetMinor),
    bufferMinor: num(raw.bufferMinor),
    reservedMinor: num(raw.reservedMinor),
    paidMinor: num(raw.paidMinor),
    availableMinor: num(raw.availableMinor),
  };
}

/** The function's answer, read strictly: anything it does not say is an error, never a reservation. */
export function reserveAnswerOf(raw: unknown): ReserveAnswer {
  const value = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  switch (value?.state) {
    case "reserved":
      if (typeof value.reservationId !== "string") break;
      return { state: "reserved", already: value.already === true, reservationId: value.reservationId, ...figuresOf(value) };
    case "over":
      return { state: "over", ...figuresOf(value) };
    case "archived":
      return { state: "archived", ...figuresOf(value) };
    case "no_project":
      return { state: "no_project" };
    case "settled":
      return { state: "settled", projectId: String(value.projectId) };
    case "not_found":
      return { state: "not_found" };
  }
  throw new Error("reserve_project_budget answered something it never says");
}

/** Sets the money of one bill or milestone aside in its project, or says why it did not. A failed call throws. */
export async function reserveProjectBudget(
  orgDb: OrgDb,
  subject: { invoiceId: string } | { milestoneId: string },
  via: ReserveVia,
  by: string | null
): Promise<ReserveAnswer> {
  const answer = await orgDb.rpc("reserve_project_budget", {
    p_invoice_id: "invoiceId" in subject ? subject.invoiceId : null,
    p_milestone_id: "milestoneId" in subject ? subject.milestoneId : null,
    p_via: via,
    p_by: by,
  });
  if (projectsNotReady(answer.error)) return { state: "not_ready" };
  if (answer.error) throw new Error(answer.error.message ?? "reserve_project_budget failed");
  return reserveAnswerOf(answer.data);
}
