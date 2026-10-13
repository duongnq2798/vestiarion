import { usdcMinor, type ProjectDraft } from "../projects/model";
import { assignToProject as writeAssign, changeProject as writeChange, createProject as writeCreate, ProjectError, reservationWords, type ProjectSubject } from "../projects/write";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * A project's commands (docs/superpowers/specs/2026-10-13-project-budgets-design.md P1-P3): making one and changing its
 * figures or status, an owner's or admin's (`agent.budget`, as the agent's spending limit is); putting a bill, a
 * milestone or a deal in one, a record (`records.write`). The console runs them.
 */

/** A refusal in the project's own words; a form sent again with other details refreshes the page. Anything else is logged. */
function refusalOf(error: unknown, what: string, actor: Actor): Refused {
  if (error instanceof ProjectError) return refused(error.code, error.message, ["key_reused", "not_found", "subject_not_found"].includes(error.code) ? { changed: true } : {});
  console.error(what, actor.orgId, error instanceof Error ? error.message : "unknown error");
  return refused("failed", TRY_AGAIN);
}

/** Makes a project. The same form again makes no second one. */
export async function addProject(actor: Actor, input: { draft: ProjectDraft; idempotencyKey: string }): Promise<CommandOutcome<{ projectId: string }>> {
  const refusal = gate(actor, "project.create");
  if (refusal) return refusal;
  try {
    const { project, created } = await writeCreate({ actorId: actor.userId, draft: input.draft, idempotencyKey: input.idempotencyKey });
    return done(created ? `Made ${project.name}, with a budget of ${usdcMinor(project.budgetMinor)}.` : `${project.name} was made already.`, { projectId: project.id });
  } catch (error) {
    return refusalOf(error, "making a project failed", actor);
  }
}

/** Changes a project's name, budget or buffer, or archives or reopens it. */
export async function changeProjectCommand(
  actor: Actor,
  input: { projectId: string; change: { kind: "figures"; draft: ProjectDraft } | { kind: "status"; status: "active" | "archived" } }
): Promise<CommandOutcome> {
  const refusal = gate(actor, "project.change");
  if (refusal) return refusal;
  try {
    const { after } = await writeChange({ actorId: actor.userId, projectId: input.projectId, change: input.change });
    if (input.change.kind === "status") return done(after.status === "archived" ? `Archived ${after.name}.` : `Reopened ${after.name}.`);
    return done(`Saved ${after.name}: a budget of ${usdcMinor(after.budgetMinor)}, ${after.bufferMinor > 0 ? `${usdcMinor(after.bufferMinor)} kept back` : "no buffer"}.`);
  } catch (error) {
    return refusalOf(error, "changing a project failed", actor);
  }
}

const SUBJECT_WORDS: Record<ProjectSubject["kind"], string> = { bill: "The bill", milestone: "The milestone", deal: "The deal" };

/** Puts a bill, a milestone or a deal in a project, or takes it out of one, setting its money aside when the budget holds it. */
export async function assignToProjectCommand(
  actor: Actor,
  input: { subject: ProjectSubject; projectId: string | null; atEntry?: boolean }
): Promise<CommandOutcome<{ reserved: boolean }>> {
  const refusal = gate(actor, "project.assign");
  if (refusal) return refusal;
  try {
    const { project, reservation } = await writeAssign({ actorId: actor.userId, subject: input.subject, projectId: input.projectId, via: input.atEntry ? "entry" : "assignment" });
    const what = SUBJECT_WORDS[input.subject.kind];
    if (!project) return done(`${what} is out of its project.`, { reserved: false });
    const words = reservationWords(reservation);
    return done(`${what} is in ${project.name}.${words ? ` ${words}` : ""}`, { reserved: reservation?.state === "reserved" });
  } catch (error) {
    return refusalOf(error, "putting something in a project failed", actor);
  }
}
