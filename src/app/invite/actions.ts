"use server";

import "server-only";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import type { OrgRole } from "@/lib/auth/roles";
import { firstStepHref } from "@/lib/onboarding/role-checklists";
import { acceptInvitation, acceptInvitationById, MemberError } from "@/lib/platform/members";

export interface AcceptInvitationResult {
  ok: boolean;
  message: string;
}

/** The token is 32 random bytes, base64url-encoded (43 characters, unpadded); the range leaves room for that to change. */
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

const INVITATION_ID = z.string().uuid();

/**
 * Accepting an invitation happens before there is any membership to
 * authorize against — the invitation itself names the organization and the
 * role — so the session is the gate, exactly as `createWorkspaceAction`
 * gates on the session rather than on `authorize`. `redirect` stays outside
 * the `try`, since it works by throwing. The person lands on their role's
 * first step (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md R6).
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
  let role: OrgRole;
  try {
    ({ slug, role } = await acceptInvitation({ token, userId: user.id }));
  } catch (error) {
    if (error instanceof MemberError) return { ok: false, message: error.message };
    console.error("invitation acceptance failed", error);
    return { ok: false, message: "This invitation could not be accepted. Try again in a moment." };
  }
  // Their role's first step (onboarding by role R6): Approvals, the accountant console, or the console.
  redirect(firstStepHref(role, slug));
}

/**
 * Accepts a pending invitation listed on /onboarding (migration 0024's
 * `pending_invitations_for`), by its id rather than the token from a link.
 * The session is the gate for the same reason as `acceptInvitationAction`.
 */
export async function acceptInvitationByIdAction(
  _previous: AcceptInvitationResult,
  formData: FormData
): Promise<AcceptInvitationResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };

  const invitationId = formData.get("invitationId");
  if (typeof invitationId !== "string" || !INVITATION_ID.safeParse(invitationId).success) {
    return { ok: false, message: "This invitation link is not valid." };
  }

  let slug: string;
  let role: OrgRole;
  try {
    ({ slug, role } = await acceptInvitationById({ invitationId, userId: user.id }));
  } catch (error) {
    if (error instanceof MemberError) return { ok: false, message: error.message };
    console.error("invitation acceptance failed", error);
    return { ok: false, message: "This invitation could not be accepted. Try again in a moment." };
  }
  // Their role's first step (onboarding by role R6): Approvals, the accountant console, or the console.
  redirect(firstStepHref(role, slug));
}
