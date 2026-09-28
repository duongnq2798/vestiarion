import "server-only";
import { membershipFor, type OrgMembership } from "./membership";
import { can, type Permission } from "./roles";
import { getSessionUser, type SessionUser } from "./session";

export type Authorization =
  | { ok: true; user: SessionUser; membership: OrgMembership }
  | { ok: false; message: string };

/**
 * For server actions. The slug arrives from the form and is only a claim about
 * which workspace the person means; membership and role are checked here
 * every time, against the §7 permission map.
 */
export async function authorize(orgSlug: unknown, permission: Permission): Promise<Authorization> {
  if (typeof orgSlug !== "string" || !orgSlug) return { ok: false, message: "Missing workspace." };
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const membership = await membershipFor(user.id, orgSlug);
  if (!membership) {
    return { ok: false, message: "Only an owner of this workspace can do that." };
  }
  if (!can(membership.role, permission)) {
    return { ok: false, message: `Your role in this workspace (${membership.role}) cannot do that.` };
  }
  return { ok: true, user, membership };
}

/** For pages deciding whether to render mutating controls at all. */
export async function viewerCan(orgSlug: string, permission: Permission): Promise<boolean> {
  return (await authorize(orgSlug, permission)).ok;
}
