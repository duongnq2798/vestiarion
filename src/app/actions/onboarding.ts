"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { recordOnboardingMarks } from "@/lib/onboarding/read";
import { checklistRoleOf, DISMISSED, isChecklistRole } from "@/lib/onboarding/role-checklists";

/**
 * A role's checklist dismissed for good, and the agent's limits kept as they are (docs/superpowers/specs/2026-10-13-role-
 * onboarding-evidence-access-design.md R1, R4). Each is a mark in `onboarding_marks` (migration 0114), for the session's
 * person in the workspace the form names, checked against their membership every time. Best effort, as a checklist is:
 * before 0114 runs, the pages offer neither button, and a form sent anyway saves nothing.
 */

/**
 * Dismisses the checklist of the role the person holds in the workspace: an owner's or admin's, an approver's, or an
 * accountant's (sent from the accountant console with the workspace its steps open; it stays dismissed there).
 */
export async function dismissChecklistAction(formData: FormData): Promise<void> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return;
  return inOrg(auth, async () => {
    const role = formData.get("role");
    // Only the checklist this person sees: a form naming another role's is a stale page, or a forged one.
    if (!isChecklistRole(role) || role !== checklistRoleOf(auth.membership.role)) return;
    await recordOnboardingMarks(auth.user.id, [DISMISSED[role]]);
    revalidateOrgPages();
    revalidatePath("/accountant");
  });
}

/**
 * Keeps the agent's limits as they are (R1): "Set or confirm the limits" on the owner's checklist. Taken by whoever may
 * change them (`agent.budget`), and recorded for the workspace: the limits are its own, not one person's.
 */
export async function confirmLimitsAction(formData: FormData): Promise<void> {
  const auth = await authorize(formData.get("orgSlug"), "agent.budget");
  if (!auth.ok) return;
  return inOrg(auth, async () => {
    await recordOnboardingMarks(auth.user.id, ["limits_confirmed"]);
    revalidateOrgPages();
  });
}
