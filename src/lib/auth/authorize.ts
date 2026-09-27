import "server-only";
import { membershipFor, type OrgMembership } from "./membership";
import { canMutate } from "./roles";
import { getSessionUser, type SessionUser } from "./session";

export type Authorization =
  | { ok: true; user: SessionUser; membership: OrgMembership }
  | { ok: false; message: string };

/**
 * For server actions. The slug arrives from the form and is only a claim about
 * which workspace the person means; membership and role are checked here
 * every time.
 */
export async function authorizeMutation(orgSlug: unknown): Promise<Authorization> {
  if (typeof orgSlug !== "string" || !orgSlug) return { ok: false, message: "Missing workspace." };
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has ended. Sign in again." };
  const membership = await membershipFor(user.id, orgSlug);
  if (!membership || !canMutate(membership.role)) {
    return { ok: false, message: "Only an owner of this workspace can do that." };
  }
  return { ok: true, user, membership };
}

/** For pages deciding whether to render mutating controls at all. */
export async function viewerCanMutate(orgSlug: string): Promise<boolean> {
  return (await authorizeMutation(orgSlug)).ok;
}
