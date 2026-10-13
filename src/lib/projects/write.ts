import { currentOrgId } from "../context";
import { db } from "../dal";
import { assertLedgerCanSign } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { minorToDecimal } from "../deals/money";
import { PROJECT_ACTIONS, PROJECT_CURRENCY, PROJECT_DIGITS, usdcMinor, type Project, type ProjectDraft } from "./model";
import { PROJECT_COLUMNS } from "./read";
import { projectsNotReady, reserveProjectBudget, type ReserveAnswer, type ReserveVia } from "./reserve";

/**
 * A workspace's projects, written (docs/superpowers/specs/2026-10-13-project-budgets-design.md P1-P4): making one,
 * changing its name, budget or buffer, archiving it, and putting a bill, a milestone or a deal in one, which sets the
 * bill's or milestone's money aside at once when the budget holds it. Every export runs inside an organization scope;
 * who may do it is the command's check. Each change is a signed entry (domain `ap`), written best effort after
 * `assertLedgerCanSign`, naming the bill or milestone as `subjectId` so its card keeps showing the agent's decision.
 */

export type ProjectErrorCode =
  | "not_ready"
  | "not_found"
  | "subject_not_found"
  | "name_taken"
  | "key_reused"
  | "archived"
  | "open_work"
  | "locked"
  | "usdc_only"
  | "payables_only"
  | "unchanged";

const MESSAGES: Record<ProjectErrorCode, string> = {
  not_ready: "Projects are not set up on this deployment yet.",
  not_found: "That project was not found. Reload the page to see the projects as they are now.",
  subject_not_found: "That bill, milestone or deal was not found. Reload the page to see the list as it is now.",
  name_taken: "Another active project has that name. Choose another.",
  key_reused: "This form was sent already, with other details. Reload the page and try again.",
  archived: "That project is archived, so nothing new is put in it.",
  open_work: "This project still has open bills or milestones. Pay, reject or move them before archiving it.",
  locked: "That bill or milestone is paid, or being paid, so it keeps its project.",
  usdc_only: "A project counts bills in USDC; this bill is in another currency.",
  payables_only: "A project holds bills to pay and milestones; money you are owed comes in through a deal.",
  unchanged: "Nothing changed.",
};

export class ProjectError extends Error {
  constructor(readonly code: ProjectErrorCode) {
    super(MESSAGES[code]);
    this.name = "ProjectError";
  }
}

type DbError = { code?: string; message?: string; details?: string } | null;

/** A refusal of 0111's triggers and constraints, in the words above; null for any other error. */
function refusalOf(error: DbError): ProjectErrorCode | null {
  if (!error) return null;
  if (projectsNotReady(error)) return "not_ready";
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (/projects_name_key/.test(text)) return "name_taken";
  if (/project_has_open_work/.test(text)) return "open_work";
  if (/project_archived/.test(text)) return "archived";
  if (/project_locked/.test(text)) return "locked";
  if (/project_usdc_only/.test(text)) return "usdc_only";
  if (/project_payables_only/.test(text)) return "payables_only";
  return null;
}

function failed(error: NonNullable<DbError>): never {
  const code = refusalOf(error);
  if (code) throw new ProjectError(code);
  throw new Error(error.message ?? "the project was not written");
}

interface ProjectRow {
  id: string;
  name: string;
  budget_minor: number | string;
  buffer_minor: number | string;
  status: "active" | "archived";
  created_at: string;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  budgetMinor: Number(row.budget_minor),
  bufferMinor: Number(row.buffer_minor),
  status: row.status,
  createdAt: row.created_at,
});

const figuresDetail = (project: Pick<Project, "name" | "budgetMinor" | "bufferMinor" | "status">) => ({
  name: project.name,
  currency: PROJECT_CURRENCY,
  budget: minorToDecimal(project.budgetMinor, PROJECT_DIGITS),
  budgetMinor: project.budgetMinor,
  buffer: minorToDecimal(project.bufferMinor, PROJECT_DIGITS),
  bufferMinor: project.bufferMinor,
  status: project.status,
});

/** One project of the workspace in scope, or null. */
export async function projectById(projectId: string): Promise<Project | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return null;
  const read = await db().from("projects").select(PROJECT_COLUMNS).eq("id", projectId).limit(1);
  if (read.error) failed(read.error);
  const row = ((read.data ?? []) as unknown as ProjectRow[])[0];
  return row ? toProject(row) : null;
}

/** Makes a project, once per key (P1). */
export async function createProject(input: { actorId: string; draft: ProjectDraft; idempotencyKey: string }): Promise<{ project: Project; created: boolean }> {
  const { actorId, draft, idempotencyKey } = input;
  // An unreadable signing key refuses the project before anything is written, rather than leave it unsigned.
  assertLedgerCanSign();
  const inserted = await db()
    .from("projects")
    .upsert(
      { name: draft.name, budget_minor: draft.budgetMinor, buffer_minor: draft.bufferMinor, idempotency_key: idempotencyKey, created_by: actorId, updated_by: actorId },
      { onConflict: "org_id,idempotency_key", ignoreDuplicates: true }
    )
    .select(PROJECT_COLUMNS);
  if (inserted.error) failed(inserted.error);
  const row = ((inserted.data ?? []) as unknown as ProjectRow[])[0];
  if (row) {
    const project = toProject(row);
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "human",
      domain: "ap",
      action: PROJECT_ACTIONS.created,
      summary: `Made the project ${project.name}, with a budget of ${usdcMinor(project.budgetMinor)}`,
      detail: { by: actorId, projectId: project.id, ...figuresDetail(project) },
    });
    return { project, created: true };
  }
  // The same form again: the project it made, when it is this one.
  const again = await db().from("projects").select(PROJECT_COLUMNS).eq("idempotency_key", idempotencyKey).limit(1);
  if (again.error) failed(again.error);
  const existing = ((again.data ?? []) as unknown as ProjectRow[])[0];
  if (!existing) throw new Error("the project was neither made nor found");
  const project = toProject(existing);
  if (project.name !== draft.name || project.budgetMinor !== draft.budgetMinor || project.bufferMinor !== draft.bufferMinor) throw new ProjectError("key_reused");
  return { project, created: false };
}

export type ProjectChange = { kind: "figures"; draft: ProjectDraft } | { kind: "status"; status: "active" | "archived" };

/** Changes a project's name, budget or buffer, or archives or reopens it (P2). Reservations already made stay. */
export async function changeProject(input: { actorId: string; projectId: string; change: ProjectChange }): Promise<{ before: Project; after: Project }> {
  const { actorId, projectId, change } = input;
  const before = await projectById(projectId);
  if (!before) throw new ProjectError("not_found");
  const values =
    change.kind === "figures"
      ? { name: change.draft.name, budget_minor: change.draft.budgetMinor, buffer_minor: change.draft.bufferMinor }
      : { status: change.status };
  const same =
    change.kind === "figures"
      ? before.name === change.draft.name && before.budgetMinor === change.draft.budgetMinor && before.bufferMinor === change.draft.bufferMinor
      : before.status === change.status;
  if (same) throw new ProjectError("unchanged");
  assertLedgerCanSign();
  const updated = await db()
    .from("projects")
    .update({ ...values, updated_by: actorId, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .select(PROJECT_COLUMNS);
  if (updated.error) failed(updated.error);
  const row = ((updated.data ?? []) as unknown as ProjectRow[])[0];
  if (!row) throw new ProjectError("not_found");
  const after = toProject(row);
  const summary =
    change.kind === "status"
      ? `${change.status === "archived" ? "Archived" : "Reopened"} the project ${after.name}`
      : `Changed the project ${after.name}: budget ${usdcMinor(after.budgetMinor)}, buffer ${usdcMinor(after.bufferMinor)}`;
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: PROJECT_ACTIONS.changed,
    summary,
    detail: { by: actorId, projectId, before: figuresDetail(before), after: figuresDetail(after) },
  });
  return { before, after };
}

export type ProjectSubject = { kind: "bill" | "milestone" | "deal"; id: string };

const TABLE = { bill: "invoices", milestone: "milestones", deal: "deals" } as const;
const SUBJECT_WORDS = { bill: "invoice", milestone: "milestone", deal: "deal" } as const;

/** What a reservation found, as the entry and the person's message say it. */
export function reservationWords(answer: ReserveAnswer | null): string | null {
  if (!answer) return null;
  switch (answer.state) {
    case "reserved":
      return `${usdcMinor(answer.neededMinor)} set aside in it.`;
    case "over":
      return `Its budget has ${usdcMinor(Math.max(0, answer.availableMinor))} left to set aside, less than the ${usdcMinor(answer.neededMinor)} this needs: nothing was set aside, and the agent holds it for a person when it comes to pay it.`;
    case "archived":
      return "The project is archived, so nothing was set aside.";
    default:
      return null;
  }
}

function reservationDetail(answer: ReserveAnswer | null): Record<string, unknown> | null {
  if (!answer) return null;
  if (answer.state === "reserved" || answer.state === "over" || answer.state === "archived") {
    return { state: answer.state, neededMinor: answer.neededMinor, availableMinor: answer.availableMinor, reservedMinor: answer.reservedMinor, paidMinor: answer.paidMinor };
  }
  return { state: answer.state };
}

/**
 * Puts a bill, a milestone or a deal in a project, or takes it out of one (`projectId` null), then sets a bill's or
 * milestone's money aside in the project when its budget holds it (P3, P4). The database releases what was set aside in
 * the project it leaves, in the same transaction. A reservation that fails leaves the bill in the project with nothing
 * set aside: the agent asks again when it comes to pay it.
 */
export async function assignToProject(input: {
  actorId: string;
  subject: ProjectSubject;
  projectId: string | null;
  via?: Extract<ReserveVia, "entry" | "assignment">;
}): Promise<{ project: Project | null; previousProjectId: string | null; reservation: ReserveAnswer | null }> {
  const { actorId, subject, projectId } = input;
  const project = projectId ? await projectById(projectId) : null;
  if (projectId && !project) throw new ProjectError("not_found");
  if (project && project.status !== "active") throw new ProjectError("archived");
  const current = await db().from(TABLE[subject.kind]).select("id, project_id").eq("id", subject.id).limit(1);
  if (current.error) failed(current.error);
  const row = ((current.data ?? []) as Array<{ id: string; project_id: string | null }>)[0];
  if (!row) throw new ProjectError("subject_not_found");
  if (row.project_id === projectId) throw new ProjectError("unchanged");
  assertLedgerCanSign();
  const updated = await db().from(TABLE[subject.kind]).update({ project_id: projectId }).eq("id", subject.id).select("id");
  if (updated.error) failed(updated.error);
  if ((updated.data ?? []).length === 0) throw new ProjectError("subject_not_found");

  let reservation: ReserveAnswer | null = null;
  if (projectId && subject.kind !== "deal") {
    try {
      reservation = await reserveProjectBudget(db(), subject.kind === "bill" ? { invoiceId: subject.id } : { milestoneId: subject.id }, input.via ?? "assignment", actorId);
    } catch (error) {
      console.error("project budget not reserved at assignment", subject.id, error instanceof Error ? error.message : error);
    }
  }
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: PROJECT_ACTIONS.assigned,
    summary: project ? `Put a ${SUBJECT_WORDS[subject.kind]} in the project ${project.name}` : `Took a ${SUBJECT_WORDS[subject.kind]} out of its project`,
    detail: {
      by: actorId,
      subject: SUBJECT_WORDS[subject.kind],
      subjectId: subject.id,
      projectId,
      projectName: project?.name ?? null,
      previousProjectId: row.project_id,
      ...(input.via === "entry" ? { via: "entry" } : {}),
      reservation: reservationDetail(reservation),
    },
  });
  return { project, previousProjectId: row.project_id, reservation };
}
