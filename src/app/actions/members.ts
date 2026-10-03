"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { can, isOrgRole } from "@/lib/auth/roles";
import { inOrg } from "@/lib/dal/scope";
import {
  changeMemberRole,
  inviteMember,
  MemberError,
  removeMember,
  revokeInvitation,
} from "@/lib/platform/members";

export interface MemberActionResult {
  ok: boolean;
  message: string;
  link?: string;
  left?: boolean;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** A `MemberError` carries a message safe to show; anything else stays in the server log. */
function fail(error: unknown): MemberActionResult {
  if (error instanceof MemberError) return { ok: false, message: error.message };
  console.error("member action failed", error);
  return { ok: false, message: "That did not work. Try again in a moment." };
}

export async function inviteMemberAction(_previous: MemberActionResult, formData: FormData): Promise<MemberActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "members.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const email = formString(formData, "email");
    const role = formString(formData, "role");
    if (!isOrgRole(role)) return { ok: false, message: "Choose a role." };
    try {
      const result = await inviteMember({ actorId: auth.user.id, orgName: auth.membership.name, email, role });
      revalidateOrgPages();
      return {
        ok: true,
        link: result.link,
        message: result.emailed
          ? `Invitation sent to ${email}.`
          : "Email is not configured, so nothing was sent. Share this link with them; it is shown only once.",
      };
    } catch (error) {
      return fail(error);
    }
  });
}

export async function changeMemberRoleAction(_previous: MemberActionResult, formData: FormData): Promise<MemberActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "members.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const userId = formString(formData, "userId");
    const role = formString(formData, "role");
    if (!isOrgRole(role)) return { ok: false, message: "Choose a role." };
    try {
      await changeMemberRole({ actorId: auth.user.id, userId, role });
      revalidateOrgPages();
      return { ok: true, message: "Role updated." };
    } catch (error) {
      return fail(error);
    }
  });
}

/** What removing someone did, including the API keys their membership took with it (migration 0069). */
function removedMessage(revokedKeys: number): string {
  if (revokedKeys === 0) return "Member removed.";
  if (revokedKeys === 1) return "Member removed. The API key they created was revoked.";
  return `Member removed. The ${revokedKeys} API keys they created were revoked.`;
}

/**
 * Only `workspace.read` is required here — leaving is open to everyone. Inside
 * the scope, removing someone else still needs `members.manage`; the database
 * checks again regardless.
 */
export async function removeMemberAction(_previous: MemberActionResult, formData: FormData): Promise<MemberActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const userId = formString(formData, "userId");
    const isSelf = userId === auth.user.id;
    if (!isSelf && !can(auth.membership.role, "members.manage")) {
      return { ok: false, message: `Your role in this workspace (${auth.membership.role}) cannot do that.` };
    }
    try {
      const { revokedKeys } = await removeMember({ actorId: auth.user.id, userId });
      // Self-removal ends the viewer's own membership. Revalidating here would
      // refresh the current route within this same transition — the
      // membership gate then calls notFound() — which can unmount the
      // component whose effect is meant to redirect to /onboarding before
      // that effect gets to run. So the tree is left alone on self-removal;
      // the client redirects on `left: true` instead, from a component that
      // stays mounted through it. Removing someone else does not touch the
      // viewer's own membership, so it revalidates as usual.
      if (!isSelf) revalidateOrgPages();
      return { ok: true, message: isSelf ? "You left the workspace." : removedMessage(revokedKeys), left: isSelf };
    } catch (error) {
      return fail(error);
    }
  });
}

export async function revokeInvitationAction(_previous: MemberActionResult, formData: FormData): Promise<MemberActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "members.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const invitationId = formString(formData, "invitationId");
    try {
      await revokeInvitation({ actorId: auth.user.id, invitationId });
      revalidateOrgPages();
      return { ok: true, message: "Invitation revoked." };
    } catch (error) {
      return fail(error);
    }
  });
}
