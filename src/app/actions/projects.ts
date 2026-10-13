"use server";

import "server-only";

import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { addProject, assignToProjectCommand, changeProjectCommand } from "@/lib/commands/projects";
import { inOrg } from "@/lib/dal/scope";
import { parseProjectForm, type ProjectFormField } from "@/lib/projects/model";

/**
 * Projects (docs/superpowers/specs/2026-10-13-project-budgets-design.md P1-P3): making one and changing its budget,
 * buffer or status, by an owner or admin (`agent.budget`, as the agent's spending limit); putting a bill, a milestone or
 * a deal in one, by someone who may enter records (`records.write`). Through the commands, inside the workspace's scope.
 */

export interface ProjectActionResult {
  ok: boolean;
  message: string;
  /** The field a refusal is about, on the project form. */
  field?: ProjectFormField;
  projectId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formString(formData: FormData, key: string, max = 400): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.slice(0, max) : "";
}

function readForm(formData: FormData) {
  return parseProjectForm({ name: formString(formData, "name", 400), budget: formString(formData, "budget", 40), buffer: formString(formData, "buffer", 40) });
}

/** Makes a project: a name, a budget and a buffer. The same form sent twice makes one project. */
export async function createProjectAction(_previous: ProjectActionResult, formData: FormData): Promise<ProjectActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.budget");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const read = readForm(formData);
    if (!read.ok) return { ok: false, message: read.message, field: read.field };
    const key = formString(formData, "idempotencyKey", 120);
    if (key.length < 8) return { ok: false, message: "Reload the page and try again." };
    const outcome = await addProject(consoleActor(auth), { draft: read.draft, idempotencyKey: key });
    return { ...consoleAnswer(outcome), ...(outcome.ok ? { projectId: outcome.projectId } : {}) };
  });
}

/** Changes a project's name, budget or buffer. What is already set aside stays. */
export async function changeProjectAction(_previous: ProjectActionResult, formData: FormData): Promise<ProjectActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.budget");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const projectId = formString(formData, "projectId", 64);
    if (!UUID.test(projectId)) return { ok: false, message: "That project was not found." };
    const read = readForm(formData);
    if (!read.ok) return { ok: false, message: read.message, field: read.field };
    return consoleAnswer(await changeProjectCommand(consoleActor(auth), { projectId, change: { kind: "figures", draft: read.draft } }));
  });
}

/** Archives a project once nothing open is left in it, or reopens one. */
export async function setProjectStatusAction(_previous: ProjectActionResult, formData: FormData): Promise<ProjectActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.budget");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const projectId = formString(formData, "projectId", 64);
    const status = formString(formData, "status", 20);
    if (!UUID.test(projectId)) return { ok: false, message: "That project was not found." };
    if (status !== "active" && status !== "archived") return { ok: false, message: "Reload the page and try again." };
    return consoleAnswer(await changeProjectCommand(consoleActor(auth), { projectId, change: { kind: "status", status } }));
  });
}

/**
 * Puts a bill, a milestone or a deal in a project, or takes it out (`projectId` empty): `subject` is `bill:<id>`,
 * `milestone:<id>` or `deal:<id>`.
 */
export async function assignToProjectAction(_previous: ProjectActionResult, formData: FormData): Promise<ProjectActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const [kind, id = ""] = formString(formData, "subject", 100).split(":");
    if ((kind !== "bill" && kind !== "milestone" && kind !== "deal") || !UUID.test(id)) return { ok: false, message: "Choose a bill, a milestone or a deal." };
    const projectText = formString(formData, "projectId", 64);
    const projectId = projectText === "" || projectText === "none" ? null : projectText;
    if (projectId !== null && !UUID.test(projectId)) return { ok: false, message: "That project was not found." };
    return consoleAnswer(await assignToProjectCommand(consoleActor(auth), { subject: { kind, id }, projectId }));
  });
}
