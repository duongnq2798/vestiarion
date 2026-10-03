import { platformAuth, platformDb, unwrap } from "../dal";
import { FOUNDING_ORG_ID } from "../dal/org-config";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { apiKeyRevokedEntry } from "./api-keys";
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
 * `created_by` on the records that stay. Migration 0069 revokes the API keys
 * the person created in the workspaces that stay, and each gets its
 * `api_key_revoked` entry there (member API keys design R6).
 */

export { DELETE_ACCOUNT_CONFIRMATION };

export type BlockedReason = "has_other_members" | "founding";

export interface AccountDeletionPlan {
  blocked: Array<{ slug: string; name: string; reason: BlockedReason }>;
  soleWorkspaces: Array<{ slug: string; name: string; live: boolean; paused: boolean; walletCount: number; hosted: boolean }>;
}

export type AccountDeletionErrorCode = "confirm_mismatch" | "blocked" | "workspace_refused" | "auth_failed";

const MESSAGES: Record<Exclude<AccountDeletionErrorCode, "workspace_refused">, string> = {
  confirm_mismatch: `Type ${DELETE_ACCOUNT_CONFIRMATION} exactly to confirm.`,
  blocked: "Make someone else an owner of each workspace listed, or delete it, first.",
  auth_failed: "Your workspaces were deleted, but your account was not; try again.",
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

/**
 * One workspace's refusal, named: the workspaces already deleted before it, if
 * any, so the person knows they are gone; its slug; `delete_org`'s fixed message.
 */
function workspaceRefused(slug: string, message: string, alreadyDeleted: string[] = []): AccountDeletionError {
  const deleted = alreadyDeleted.length > 0 ? `Deleted: ${alreadyDeleted.join(", ")}. ` : "";
  return new AccountDeletionError("workspace_refused", `${deleted}${slug}: ${message} Your account was not deleted.`);
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

/**
 * The person's active API keys in the workspaces that stay (member API keys
 * design R6). Deleting the account revokes them in the database (migration
 * 0069); each gets its `api_key_revoked` entry once the account is gone.
 */
async function keysLeftBehind(userId: string, deletedWithAccount: ReadonlySet<string>): Promise<Array<{ id: string; orgId: string }>> {
  const rows = unwrap(
    await platformDb().from("api_keys").select("id, org_id").eq("created_by", userId).is("revoked_at", null).order("created_at")
  ) as Array<{ id: string; org_id: string }>;
  return rows.filter((row) => !deletedWithAccount.has(row.org_id)).map((row) => ({ id: row.id, orgId: row.org_id }));
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

  // Read before anything is deleted, so a failure here leaves everything as it was.
  const keys = await keysLeftBehind(input.userId, new Set(soleIds.values()));

  // One at a time, stopping at the first refusal: the account stays, and so
  // does every workspace not yet reached.
  const deleted: string[] = [];
  for (const workspace of plan.soleWorkspaces) {
    const { error } = await platformDb().rpc("delete_org", { p_org_id: soleIds.get(workspace.slug), p_by: input.userId });
    if (error) {
      const refusal = deleteOrgRefusal(error);
      if (refusal) throw workspaceRefused(workspace.slug, refusal.message, deleted);
      throw new Error(error.message);
    }
    deleted.push(workspace.slug);
  }

  const { error } = await platformAuth().deleteUser(input.userId);
  if (error) {
    // Once a workspace is gone, the person needs to know that a retry will not
    // bring it back; before, the failure is the action's generic one.
    if (deleted.length > 0) throw new AccountDeletionError("auth_failed");
    throw new Error(error.message);
  }

  // The account is gone, and with it every key it created where it was a member (0069). Each workspace's ledger says
  // so, as the person who deleted it.
  for (const key of keys) {
    await appendLedgerEntryBestEffort(
      key.orgId,
      apiKeyRevokedEntry({ reason: "account_deleted", by: input.userId, keyId: key.id }),
      { enterScope: { userId: input.userId } }
    );
  }
}
