"use server";

import "server-only";

import { redirect } from "next/navigation";
import { orgHref } from "@/lib/auth/org-paths";
import { getSessionUser } from "@/lib/auth/session";
import { createWorkspace, WorkspaceLimitError } from "@/lib/platform/workspace";

export interface CreateWorkspaceResult {
  ok: boolean;
  message: string;
}

/**
 * Not an organization action: there is no organization to authorize against
 * yet, so the session is the gate. Only the limit is worth saying in words;
 * anything else may carry a database or configuration message, which stays in
 * the server log rather than reaching the browser.
 */
export async function createWorkspaceAction(_previous: CreateWorkspaceResult, formData: FormData): Promise<CreateWorkspaceResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const name = formData.get("name");
  if (typeof name !== "string" || !name.trim()) return { ok: false, message: "Give the workspace a name." };
  let slug: string;
  try {
    ({ slug } = await createWorkspace({ userId: user.id, name }));
  } catch (error) {
    if (error instanceof WorkspaceLimitError) return { ok: false, message: error.message };
    console.error("workspace creation failed", error);
    return { ok: false, message: "The workspace could not be created. Try again in a moment." };
  }
  // `redirect` throws to navigate, so it stays outside the `try` above.
  redirect(orgHref(slug, "/console"));
}
