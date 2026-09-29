"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { platformDb } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";

export interface NotifyEmailActionResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * The viewer's own switch for the waiting-decision digest (spec N6). Gated on
 * `workspace.read`, not `members.manage`: this changes only the caller's own
 * membership, and the update below filters on the session's user id, taken
 * from `auth`, never from the form — so nobody can be made to change someone
 * else's switch by adding a `userId` field.
 */
export async function setNotifyEmailAction(_previous: NotifyEmailActionResult, formData: FormData): Promise<NotifyEmailActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const on = formString(formData, "on");
    if (on !== "true" && on !== "false") return { ok: false, message: "Choose a value." };
    const result = await platformDb()
      .from("memberships")
      .update({ notify_email: on === "true" })
      .eq("org_id", auth.membership.orgId)
      .eq("user_id", auth.user.id);
    if (result.error) {
      console.error("setNotifyEmailAction failed", result.error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
    revalidateOrgPages();
    return { ok: true, message: on === "true" ? "Emails on." : "Emails off." };
  });
}
