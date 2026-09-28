"use server";

import "server-only";

import { redirect } from "next/navigation";
import { orgHref } from "@/lib/auth/org-paths";
import { getSessionUser } from "@/lib/auth/session";
import { acceptInvitation, MemberError } from "@/lib/platform/members";

export interface AcceptInvitationResult {
  ok: boolean;
  message: string;
}

/** The token is 32 random bytes, base64url-encoded (43 characters, unpadded); the range leaves room for that to change. */
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * Accepting an invitation happens before there is any membership to
 * authorize against — the invitation itself names the organization and the
 * role — so the session is the gate, exactly as `createWorkspaceAction`
 * gates on the session rather than on `authorize`. `redirect` stays outside
 * the `try`, since it works by throwing.
 */
export async function acceptInvitationAction(
  _previous: AcceptInvitationResult,
  formData: FormData
): Promise<AcceptInvitationResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };

  const token = formData.get("token");
  if (typeof token !== "string" || !TOKEN.test(token)) {
    return { ok: false, message: "This invitation link is not valid." };
  }

  let slug: string;
  try {
    ({ slug } = await acceptInvitation({ token, userId: user.id }));
  } catch (error) {
    if (error instanceof MemberError) return { ok: false, message: error.message };
    console.error("invitation acceptance failed", error);
    return { ok: false, message: "This invitation could not be accepted. Try again in a moment." };
  }
  redirect(orgHref(slug, "/console"));
}
