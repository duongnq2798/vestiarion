import type { WalletHost } from "../config";
import { currentConfig } from "../context";
import { platformDb, unwrap } from "../dal";

/** Spec §6 "Abandoned sandboxes": a sandbox with no activity this long is deleted by the daily cleanup. */
export const SANDBOX_IDLE_DAYS = 60;

interface SandboxRow {
  id: string;
  wallet_host: WalletHost | null;
}

/**
 * Whether any account of the organization has a Circle wallet, read through
 * the platform's `orgs` table: the org comes back only if an embedded account
 * with a wallet matches (`!inner`).
 */
async function hasWallet(orgId: string): Promise<{ wallet: boolean; error?: string }> {
  const { data, error } = await platformDb()
    .from("orgs")
    .select("id, accounts!inner(id)")
    .eq("id", orgId)
    .not("accounts.circle_wallet_id", "is", null)
    .limit(1);
  if (error) return { wallet: false, error: error.message };
  return { wallet: (data ?? []).length > 0 };
}

/**
 * Whether the owner's own wallet deployed the workspace's contract (wallet treasury): the wallet may approve it, or
 * have approved it without the approval being recorded, so the sandbox is kept rather than deleted.
 */
async function hasDeployedContract(orgId: string): Promise<{ deployed: boolean; error?: string }> {
  const { data, error } = await platformDb()
    .from("orgs")
    .select("id, spending_limit_contracts!inner(id)")
    .eq("id", orgId)
    .not("spending_limit_contracts.address", "is", null)
    .limit(1);
  if (error) return { deployed: false, error: error.message };
  return { deployed: (data ?? []).length > 0 };
}

/**
 * Counts only. The response is printed into the scheduled workflow's log, and
 * sandbox slugs derive from people's workspace names, so per-organization
 * detail goes to the server log, by organization id.
 */
export interface CleanupResult {
  deleted: number;
  failed: number;
}

/**
 * The sandbox cleanup's counts, and how many workspaces hold a hosted slot
 * after it against `HOSTED_WORKSPACE_LIMIT` (hosted wallets H5): numbers only.
 * `hostedUsed` is null when the count could not be read, which is reported,
 * not counted as a failed deletion.
 */
export interface SandboxCleanupResult extends CleanupResult {
  hostedUsed: number | null;
  hostedLimit: number;
}

async function countHosted(): Promise<number | null> {
  const { count, error } = await platformDb().from("orgs").select("id", { count: "exact", head: true }).eq("wallet_host", "hosted");
  if (error || count === null) {
    console.error("could not count hosted workspaces", error?.message ?? "no count returned");
    return null;
  }
  return count;
}

/**
 * Deletes every sandbox organization that has been inactive since the
 * cutoff. Each organization is its own call to `delete_sandbox_org`
 * (migration 0022), so one organization's failure never stops the rest: it
 * is logged and counted in `failed` instead. `delete_sandbox_org` itself
 * re-checks `last_active_at` against the cutoff it is given, so a sandbox
 * that became active between the listing and the delete survives — that call
 * simply returns `false`, and the organization is counted nowhere.
 *
 * Hosted sandboxes are listed too (R6), so an abandoned one frees its place
 * under `HOSTED_WORKSPACE_LIMIT`. Each is first checked for a wallet: one with
 * a wallet may hold faucet funds its owner is using, so it is kept without a
 * call (counted nowhere), and one whose check fails is counted in `failed`.
 * `delete_sandbox_org`'s own `has_hosted_wallet` refusal stays the authority
 * for a wallet created between the check and the delete.
 *
 * A sandbox paying from its owner's own wallet is checked the same way for a
 * contract that wallet deployed: one is kept without a call, since the wallet
 * may have approved it, and `delete_sandbox_org` would refuse a recorded
 * approval anyway (`has_wallet_approval`, migration 0082), failing the run
 * every day. One whose check fails is counted in `failed`.
 *
 * Last, it counts the hosted workspaces left, so the run reports how close
 * the platform is to its hosted limit, freed slots included.
 */
export async function deleteAbandonedSandboxes(now: Date = new Date()): Promise<SandboxCleanupResult> {
  const cutoff = new Date(now.getTime() - SANDBOX_IDLE_DAYS * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const sandboxes = unwrap(
    await platformDb()
      .from("orgs")
      .select("id, wallet_host")
      .eq("mode", "sandbox")
      .lt("last_active_at", cutoffIso)
      .is("circle_api_key_enc", null)
  ) as unknown as SandboxRow[];

  let deleted = 0;
  let failed = 0;

  for (const org of sandboxes) {
    if (org.wallet_host === "hosted") {
      const check = await hasWallet(org.id);
      if (check.error) {
        failed += 1;
        console.error("could not check abandoned hosted sandbox for wallets", org.id, check.error);
        continue;
      }
      if (check.wallet) {
        console.log("kept abandoned hosted sandbox with wallets", org.id);
        continue;
      }
    }
    if (org.wallet_host === "external") {
      const check = await hasDeployedContract(org.id);
      if (check.error) {
        failed += 1;
        console.error("could not check abandoned sandbox for its wallet's contract", org.id, check.error);
        continue;
      }
      if (check.deployed) {
        console.log("kept abandoned sandbox with its wallet's contract", org.id);
        continue;
      }
    }
    const { data, error } = await platformDb().rpc("delete_sandbox_org", {
      p_org_id: org.id,
      p_inactive_before: cutoffIso,
    });
    if (error) {
      failed += 1;
      console.error("could not delete abandoned sandbox", org.id, error.message);
      continue;
    }
    if (data === true) {
      deleted += 1;
      console.log("deleted abandoned sandbox", org.id);
    }
  }

  const hostedUsed = await countHosted();
  const hostedLimit = currentConfig().hostedWorkspaceLimit;
  console.log("hosted workspaces", hostedUsed, "of", hostedLimit);
  return { deleted, failed, hostedUsed, hostedLimit };
}

/** W7: delivered and failed webhook rows are kept this long, then deleted by the daily cleanup. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

/**
 * Which finished deliveries expire, and from when: a delivered row from its
 * delivery, a failed one from its creation (it records no time of failure).
 * Pending and sending rows are never deleted here.
 */
const EXPIRING: { status: "delivered" | "failed"; since: "delivered_at" | "created_at" }[] = [
  { status: "delivered", since: "delivered_at" },
  { status: "failed", since: "created_at" },
];

/**
 * Deletes webhook deliveries that finished more than
 * `WEBHOOK_DELIVERY_RETENTION_DAYS` ago — delivered rows by `delivered_at`,
 * failed rows by `created_at` — and counts them. Best-effort: it never throws;
 * each failed delete is logged and counted in `failed`, does not stop the
 * other, and its rows are simply deleted by a later run.
 */
export async function deleteExpiredWebhookDeliveries(now: Date = new Date()): Promise<CleanupResult> {
  const cutoffIso = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;
  let failed = 0;
  for (const { status, since } of EXPIRING) {
    try {
      const { count, error } = await platformDb()
        .from("webhook_deliveries")
        .delete({ count: "exact" })
        .eq("status", status)
        .lt(since, cutoffIso);
      if (error) {
        console.error("could not delete expired webhook deliveries", error.message);
        failed += 1;
        continue;
      }
      deleted += count ?? 0;
    } catch (err) {
      console.error("could not delete expired webhook deliveries", (err as Error).message);
      failed += 1;
    }
  }
  if (deleted > 0) console.log("deleted expired webhook deliveries", deleted);
  return { deleted, failed };
}
