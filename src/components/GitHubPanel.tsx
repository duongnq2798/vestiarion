"use client";

import { GitPullRequest, Unplug } from "lucide-react";
import { disconnectGitHubAction, type GitHubActionResult } from "@/app/actions/github";
import { networkProfile, type Network } from "@/lib/network";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { GitHubInstallation } from "@/lib/github/installs";

const INITIAL: GitHubActionResult = { ok: false, message: "" };

/** What GitHub's way back from connecting says, by the code it carries in `?github=` (GitHub App design G2). */
export const GITHUB_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "GitHub is connected. A milestone paid for a pull request in its repositories now gets a comment on it." },
  cancelled: { tone: "error", text: "Connecting GitHub was cancelled. Nothing changed." },
  requested: { tone: "error", text: "GitHub asked an owner of that account to approve the app. Connect again once they have." },
  forbidden: { tone: "error", text: "Only an owner or admin connects GitHub, from their own browser." },
  not_yours: { tone: "error", text: "GitHub did not list that installation as one your account can reach, so it was not connected." },
  failed: { tone: "error", text: "GitHub did not finish connecting. Try again in a moment." },
};

/** "Oct 4", the UTC day it was connected. */
function connectedOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Disconnect({ orgSlug, installationId }: { orgSlug: string; installationId: number }) {
  const { state, formProps } = useActionForm(disconnectGitHubAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="installationId" value={installationId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
        Disconnect
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

/**
 * The GitHub section of Settings (docs/superpowers/specs/2026-10-04-github-app-design.md G2, G3, G4, G5). An owner or
 * admin connects a GitHub account by installing the app on the repositories they choose, through the install route.
 * Once connected, a milestone paid for a pull request in those repositories gets a comment on it, and the GitHub check
 * reads their private pull requests too. Each connected account can be disconnected here; uninstalling the app on
 * GitHub is what takes its access away. Nothing secret is shown.
 */
export default function GitHubPanel({
  orgSlug,
  installations,
  canManage,
  notice,
  network,
}: {
  orgSlug: string;
  installations: GitHubInstallation[];
  canManage: boolean;
  notice: string | null;
  /** The workspace's network, whose transaction the comment links (mainnet copy C1). */
  network: Network;
}) {
  const told = notice ? GITHUB_NOTICES[notice] : undefined;
  return (
    <section aria-labelledby="github-title" id="github">
      <SectionHeader id="github-title" title="GitHub" />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        <p className="max-w-prose text-sm text-ink-2">
          Install the Vestiarion app on the repositories your contributors work in. A milestone paid for a pull request there gets a
          comment on that pull request, with the amount and the {networkProfile(network).label} transaction, and the agent can verify pull requests in
          private repositories too.
        </p>
        {installations.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {installations.map((installation) => (
              <li key={installation.installationId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 text-sm">
                  <p className="font-semibold text-ink">{installation.accountLogin}</p>
                  <p className="text-ink-3">
                    {installation.repositorySelection === "all" ? "all repositories" : "selected repositories"} · connected{" "}
                    {connectedOn(installation.connectedAt)}
                  </p>
                </div>
                {canManage && <Disconnect orgSlug={orgSlug} installationId={installation.installationId} />}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <div className="space-y-2">
            <Button asChild size="sm" variant={installations.length > 0 ? "secondary" : undefined}>
              <a href={`/api/github/install?org=${orgSlug}`}>
                <GitPullRequest aria-hidden />
                {installations.length > 0 ? "Connect another account" : "Connect GitHub"}
              </a>
            </Button>
            {installations.length > 0 && (
              <p className="max-w-prose text-xs leading-5 text-ink-3">
                Disconnecting stops the comments here. To take the app&apos;s access away, uninstall it on GitHub, under the account&apos;s
                Settings, Applications.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-3">An owner or admin connects GitHub.</p>
        )}
      </Card>
    </section>
  );
}
