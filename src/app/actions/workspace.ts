"use server";

import "server-only";

import { redirect } from "next/navigation";
import { authorize } from "@/lib/auth/authorize";
import { inOrg } from "@/lib/dal/scope";
import { deleteWorkspace, DeleteWorkspaceError } from "@/lib/platform/delete-workspace";

/**
 * Deleting a workspace (docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md
 * §1, W1, W6), owner only. On success the owner is sent to `/onboarding`,
 * which lists their other workspaces; on failure the result is only ever
 * `{ ok: false, message }` with a fixed message.
 */

export interface DeleteWorkspaceActionResult {
  ok: boolean;
  message: string;
}

const GENERIC = "Something went wrong; try again.";

/** Form fields: `orgSlug`, `confirmSlug`. */
export async function deleteWorkspaceAction(_previous: DeleteWorkspaceActionResult, formData: FormData): Promise<DeleteWorkspaceActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const confirmSlug = formData.get("confirmSlug");
    try {
      await deleteWorkspace({
        orgId: auth.membership.orgId,
        actorId: auth.user.id,
        confirmSlug: typeof confirmSlug === "string" ? confirmSlug : "",
      });
    } catch (error) {
      if (error instanceof DeleteWorkspaceError) return { ok: false, message: error.message };
      // Logged by the action's name alone: a database message may name the workspace or the host.
      console.error("workspace: deleteWorkspaceAction failed");
      return { ok: false, message: GENERIC };
    }
    // `redirect` throws to navigate, so it stays outside the `try` above. The
    // deleted workspace's pages are not revalidated: re-rendering them now
    // would only meet a membership that no longer exists.
    redirect("/onboarding");
  });
}
