import { platformAuth, platformDb, unwrap } from "../dal";
import { FOUNDING_ORG_ID } from "../dal/org-config";
import { DELETE_ACCOUNT_CONFIRMATION } from "./delete-account-phrase";
import { deleteOrgRefusal, deletionContext } from "./delete-workspace";

/**
 * Deleting your own account (docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md §6).
 *
 * Every function here takes the signed-in person's id from the caller's
 * session, never from a form. What happens to each workspace depends on
 * whether the person is its last owner (A2):
 *   - not the last owner (another owner exists, or the person is no owner at
 *     all): only the membership goes, through 0023's cascade;
 *   - the last owner and the only member: the workspace is deleted with the
 *     account, through `delete_org` and its refusals;
 *   - the last owner of a workspace with other members, or of the founding
 *     workspace: the account cannot be deleted until that changes.
 * Then the Supabase auth user is deleted with the service role (A3), and
 * 0023's foreign keys remove the memberships and sent invitations and clear
 * `created_by` on the records that stay.
 */

export { DELETE_ACCOUNT_CONFIRMATION };

export type BlockedReason = "has_other_members" | "founding";

export interface AccountDeletionPlan {
  blocked: Array<{ slug: string; name: string; reason: BlockedReason }>;
  soleWorkspaces: Array<{ slug: string; name: string; live: boolean; paused: boolean; walletCount: number; hosted: boolean }>;
}

export type AccountDeletionErrorCode = "confirm_mismatch" | "blocked" | "workspace_refused";

const MESSAGES: Record<Exclude<AccountDeletionErrorCode, "workspace_refused">, string> = {
  confirm_mismatch: `Type ${DELETE_ACCOUNT_CONFIRMATION} exactly to confirm.`,
  blocked: "Make someone else an owner of each workspace listed, or delete it, first.",
};

/** A refusal with a fixed message, safe to show. */
export class AccountDeletionError extends Error {
  constructor(
    readonly code: AccountDeletionErrorCode,
    message?: string
  ) {
    super(message ?? MESSAGES[code as keyof typeof MESSAGES]);
    this.name = "AccountDeletionError";
  }
}

/** One workspace's refusal, named: its slug, then `delete_org`'s fixed message. */
function workspaceRefused(slug: string, message: string): AccountDeletionError {
  return new AccountDeletionError("workspace_refused", `${slug}: ${message} Your account was not deleted.`);
}

interface MyMembership {
  org_id: string;
  role: string;
  orgs: { slug: string; name: string };
}

const byName = <T extends { name: string; slug: string }>(a: T, b: T) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);

async function planWithIds(userId: string): Promise<{ plan: AccountDeletionPlan; soleIds: Map<string, string> }> {
  const mine = unwrap(
    await platformDb().from("memberships").select("org_id, role, orgs!inner(slug, name)").eq("user_id", userId)
  ) as unknown as MyMembership[];
  const owned = mine.filter((membership) => membership.role === "owner");

  const everyone = owned.length
    ? (unwrap(
        await platformDb()
          .from("memberships")
          .select("org_id, user_id, role")
          .in("org_id", owned.map((membership) => membership.org_id))
      ) as Array<{ org_id: string; user_id: string; role: string }>)
    : [];

  const blocked: AccountDeletionPlan["blocked"] = [];
  const sole: Array<{ orgId: string; slug: string; name: string }> = [];
  for (const membership of owned) {
    const others = everyone.filter((row) => row.org_id === membership.org_id && row.user_id !== userId);
    // Not the last owner: only the membership goes.
    if (others.some((row) => row.role === "owner")) continue;
    const { slug, name } = membership.orgs;
    if (membership.org_id === FOUNDING_ORG_ID) blocked.push({ slug, name, reason: "founding" });
    else if (others.length > 0) blocked.push({ slug, name, reason: "has_other_members" });
    else sole.push({ orgId: membership.org_id, slug, name });
  }

  const soleWorkspaces: AccountDeletionPlan["soleWorkspaces"] = [];
  const soleIds = new Map<string, string>();
  for (const workspace of sole.sort(byName)) {
    const context = await deletionContext(workspace.orgId);
    soleWorkspaces.push({
      slug: workspace.slug,
      name: workspace.name,
      live: context.live,
      paused: context.paused,
      walletCount: context.walletCount,
      hosted: context.hosted,
    });
    soleIds.set(workspace.slug, workspace.orgId);
  }
  return { plan: { blocked: blocked.sort(byName), soleWorkspaces }, soleIds };
}

/** What deleting this person's account would do (A2). Slugs, names, counts and booleans only. */
export async function accountDeletionPlan(userId: string): Promise<AccountDeletionPlan> {
  return (await planWithIds(userId)).plan;
}

export async function deleteAccount(input: { userId: string; confirmText: string }): Promise<void> {
  if (input.confirmText !== DELETE_ACCOUNT_CONFIRMATION) throw new AccountDeletionError("confirm_mismatch");

  const { plan, soleIds } = await planWithIds(input.userId);
  if (plan.blocked.length > 0) throw new AccountDeletionError("blocked");

  // A live workspace with its agent running is refused before anything is
  // deleted, so the most likely refusal never leaves the account half done.
  const running = plan.soleWorkspaces.find((workspace) => workspace.live && !workspace.paused);
  if (running) throw workspaceRefused(running.slug, "Pause the agent first, so no cycle runs while the workspace is deleted.");

  // One at a time, stopping at the first refusal: the account stays, and so
  // does every workspace not yet reached.
  for (const workspace of plan.soleWorkspaces) {
    const { error } = await platformDb().rpc("delete_org", { p_org_id: soleIds.get(workspace.slug), p_by: input.userId });
    if (error) {
      const refusal = deleteOrgRefusal(error);
      if (refusal) throw workspaceRefused(workspace.slug, refusal.message);
      throw new Error(error.message);
    }
  }

  const { error } = await platformAuth().deleteUser(input.userId);
  if (error) throw new Error(error.message);
}
