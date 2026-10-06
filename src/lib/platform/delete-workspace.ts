import type { WalletHost } from "../config";
import { NoOrgScopeError, currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { FOUNDING_ORG_ID } from "../dal/org-config";
import { withOrg } from "../dal/scope";

/**
 * Deleting a workspace, owner initiated
 * (docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md §1).
 *
 * The owner confirms by typing the workspace's slug; `delete_org` (migration
 * 0031) does the rest in one transaction: it refuses the founding workspace,
 * anyone but an owner (re-checked there), a live workspace whose agent is not
 * paused, and one with a cycle or a payment in progress, writes the tombstone,
 * and deletes every row of the organization. No ledger entry is written: the ledger is deleted, and the tombstone is the record.
 */

export type DeleteWorkspaceErrorCode =
  | "slug_mismatch"
  | "founding_org"
  | "not_owner"
  | "pause_first"
  | "cycle_running"
  | "payment_in_progress"
  | "org_not_found";

const MESSAGES: Record<DeleteWorkspaceErrorCode, string> = {
  slug_mismatch: "Type the workspace's slug exactly to confirm.",
  founding_org: "The founding workspace cannot be deleted.",
  not_owner: "Only an owner can delete this workspace.",
  pause_first: "Pause the agent first, so no cycle runs while the workspace is deleted.",
  cycle_running: "A cycle started in the last 15 minutes has not finished; try again shortly.",
  payment_in_progress: "A payment is being made; try again in a few minutes.",
  org_not_found: "This workspace no longer exists.",
};

/** A refusal with a fixed message, safe to show. */
export class DeleteWorkspaceError extends Error {
  constructor(readonly code: DeleteWorkspaceErrorCode) {
    super(MESSAGES[code]);
    this.name = "DeleteWorkspaceError";
  }
}

/**
 * A `delete_org` refusal (`code: …`) as its fixed-message error, or null for
 * anything else. Shared with account deletion, which runs `delete_org` too.
 */
export function deleteOrgRefusal(error: { message: string }): DeleteWorkspaceError | null {
  const code = /^([a-z_]+):/.exec(error.message)?.[1];
  // slug_mismatch is this module's own check; the database never raises it.
  if (code && Object.hasOwn(MESSAGES, code) && code !== "slug_mismatch") return new DeleteWorkspaceError(code as DeleteWorkspaceErrorCode);
  return null;
}

function raise(error: { message: string }): never {
  throw deleteOrgRefusal(error) ?? new Error(error.message);
}

interface OrgFacts {
  slug: string;
  mode: "sandbox" | "live";
  agent_paused_at: string | null;
  wallet_host: WalletHost | null;
}

async function orgFacts(orgId: string): Promise<OrgFacts | null> {
  const result = await platformDb().from("orgs").select("slug, mode, agent_paused_at, wallet_host").eq("id", orgId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data as OrgFacts | null;
}

export async function deleteWorkspace(input: { orgId: string; actorId: string; confirmSlug: string }): Promise<void> {
  const org = await orgFacts(input.orgId);
  if (!org) throw new DeleteWorkspaceError("org_not_found");
  if (input.confirmSlug !== org.slug) throw new DeleteWorkspaceError("slug_mismatch");

  const { error } = await platformDb().rpc("delete_org", { p_org_id: input.orgId, p_by: input.actorId });
  if (error) raise(error);
}

/** What the delete dialog needs to say: counts and booleans only, no address or id. */
export interface DeletionContext {
  slug: string;
  isFounding: boolean;
  live: boolean;
  paused: boolean;
  walletCount: number;
  hosted: boolean;
}

function scopedOrgId(): string | null {
  try {
    return currentOrgId();
  } catch (error) {
    if (error instanceof NoOrgScopeError) return null;
    throw error;
  }
}

export async function deletionContext(orgId: string): Promise<DeletionContext> {
  const org = await orgFacts(orgId);
  if (!org) throw new DeleteWorkspaceError("org_not_found");
  const countWallets = async () => {
    const accounts = unwrap(await db().from("accounts").select("circle_wallet_id")) as Array<{ circle_wallet_id: string | null }>;
    return accounts.filter((account) => account.circle_wallet_id).length;
  };
  const walletCount = scopedOrgId() === orgId ? await countWallets() : await withOrg(orgId, countWallets);
  return {
    slug: org.slug,
    isFounding: orgId === FOUNDING_ORG_ID,
    live: org.mode === "live",
    paused: org.agent_paused_at !== null,
    walletCount,
    hosted: org.wallet_host === "hosted",
  };
}
