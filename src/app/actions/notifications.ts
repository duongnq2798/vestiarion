"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { platformDb } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { sendWeeklyBrief } from "@/lib/notifications/weekly-brief";

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

/**
 * Sends this week's brief at once to the viewer, and only to them (weekly brief W4). Gated on `approval.decide`: the brief
 * goes to those who decide payments. The address is the session's, never the form's, so nobody can have it sent to
 * someone else.
 */
export async function sendWeeklyBriefNowAction(_previous: NotifyEmailActionResult, formData: FormData): Promise<NotifyEmailActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  const email = auth.user.email;
  if (!email) return { ok: false, message: "Your account has no email address to send it to." };
  return inOrg(auth, async () => {
    const outcome = await sendWeeklyBrief({ only: { userId: auth.user.id, email } });
    if (outcome.sent > 0) return { ok: true, message: `Sent to ${email}.` };
    if (outcome.skipped === "too_soon") return { ok: false, message: "It went a few minutes ago. Try again shortly." };
    if (outcome.skipped === "no_email") return { ok: false, message: "Email is not set up on this deployment." };
    return { ok: false, message: "That did not work. Try again in a moment." };
  });
}
