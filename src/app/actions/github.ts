"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { removeInstallation } from "@/lib/github/installs";

export interface GitHubActionResult {
  ok: boolean;
  message: string;
}

const NOT_CONNECTED = "That GitHub account is not connected to this workspace.";

/**
 * Disconnects one GitHub account from the workspace (docs/superpowers/specs/2026-10-04-github-app-design.md G3): an
 * owner's or admin's. Vestiarion stops commenting on its pull requests and reading them with its token; GitHub keeps
 * the app installed until someone uninstalls it there, which is what takes its access away.
 */
export async function disconnectGitHubAction(_previous: GitHubActionResult, formData: FormData): Promise<GitHubActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  const raw = formData.get("installationId");
  const installationId = typeof raw === "string" && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
  if (installationId === null || !Number.isSafeInteger(installationId)) return { ok: false, message: NOT_CONNECTED };
  return inOrg(auth, async () => {
    try {
      const removed = await removeInstallation({ orgId: auth.membership.orgId, actorId: auth.user.id, installationId });
      if (!removed) return { ok: false, message: NOT_CONNECTED };
      revalidateOrgPages();
      return { ok: true, message: "GitHub is disconnected from this workspace. To take the app's access away, uninstall it on GitHub." };
    } catch (error) {
      console.error("disconnectGitHubAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
