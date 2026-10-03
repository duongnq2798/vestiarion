import { platformDb, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { UserInstallation } from "./app";

/**
 * The GitHub App installations a workspace connected (docs/superpowers/specs/2026-10-04-github-app-design.md G2, G3,
 * G6), in the platform table `github_installations`. Connecting again keeps one row and updates it. Every change is a
 * ledger entry with ids and the account's login only: nothing secret is ever stored here (G7).
 */

export interface GitHubInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  connectedAt: string;
}

const coverage = (selection: "all" | "selected") => (selection === "all" ? "all repositories" : "selected repositories");

/** Connects an installation GitHub said the person can reach, and records it. */
export async function saveInstallation(input: { orgId: string; connectedBy: string; installation: UserInstallation }): Promise<void> {
  const { orgId, connectedBy, installation } = input;
  unwrap(
    await platformDb()
      .from("github_installations")
      .upsert(
        {
          org_id: orgId,
          installation_id: installation.id,
          account_login: installation.accountLogin,
          account_type: installation.accountType,
          repository_selection: installation.repositorySelection,
          connected_by: connectedBy,
          connected_at: new Date().toISOString(),
        },
        { onConflict: "org_id,installation_id" }
      )
  );
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "github_connected",
    summary: `Connected GitHub: ${installation.accountLogin}'s installation of the app, for ${coverage(installation.repositorySelection)}`,
    detail: {
      by: connectedBy,
      installationId: installation.id,
      account: installation.accountLogin,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
    },
  });
}

/** The workspace's connected installations, oldest first. */
export async function githubInstallations(orgId: string): Promise<GitHubInstallation[]> {
  const rows = unwrap(
    await platformDb()
      .from("github_installations")
      .select("installation_id, account_login, account_type, repository_selection, connected_at")
      .eq("org_id", orgId)
      .order("connected_at", { ascending: true })
  ) as Array<{ installation_id: number | string; account_login: string; account_type: string; repository_selection: string; connected_at: string }>;
  return rows.map((row) => ({
    installationId: Number(row.installation_id),
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection === "all" ? "all" : "selected",
    connectedAt: row.connected_at,
  }));
}

/** Removes the workspace's link to an installation, and records it; false when it had none. GitHub keeps the app installed. */
export async function removeInstallation(input: { orgId: string; actorId: string; installationId: number }): Promise<boolean> {
  const removed = unwrap(
    await platformDb()
      .from("github_installations")
      .delete()
      .eq("org_id", input.orgId)
      .eq("installation_id", input.installationId)
      .select("installation_id, account_login")
  ) as Array<{ installation_id: number; account_login: string }>;
  const row = removed[0];
  if (!row) return false;
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "system",
    action: "github_disconnected",
    summary: `Disconnected GitHub: ${row.account_login}'s installation of the app`,
    detail: { by: input.actorId, installationId: input.installationId, account: row.account_login },
  });
  return true;
}
