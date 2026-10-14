import type { Metadata } from "next";
import { Link2, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { NativeCheckbox, NativeRadioGroup } from "@/components/ui/NativeChoice";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { CONSENT_LABEL, consentStatement } from "@/lib/connectors/consent";
import { networkProfile } from "@/lib/network";
import { pipedriveSettingsFromEnv } from "@/lib/pipedrive/settings";

export const metadata: Metadata = { title: "Connect Pipedrive" };
export const dynamic = "force-dynamic";

type ConnectPageProps = {
  searchParams: Promise<{ org?: string | string[]; consent?: string | string[]; error?: string | string[] }>;
};

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin of a workspace connects Pipedrive to it.",
  not_set_up: "Pipedrive is not set up on this deployment yet.",
};

/**
 * Connecting Pipedrive (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4, P14). Reading this page has
 * no side effect. The person picks the workspace, among those they may manage integrations for (the one a Settings card
 * names in `?org=`, or the only one, picked already), reads what Vestiarion does with Pipedrive's data and ticks I agree
 * (real inputs with labels); Continue to Pipedrive posts to the connect route, which checks all of it again. Pipedrive
 * asks the person to install the app in their company, with all of its scopes or none. Writing is not asked for here:
 * the Settings card's switch turns it on (P11).
 */
export default async function PipedriveConnectPage({ searchParams }: ConnectPageProps) {
  const params = await searchParams;
  const org = one(params.org);
  const user = await verifySession(`/integrations/pipedrive/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!pipedriveSettingsFromEnv()) notFound();
  const workspaces = (await membershipsOf(user.id)).filter((membership) => can(membership.role, "integrations.manage"));
  const chosen = workspaces.find((membership) => membership.slug === org) ?? (workspaces.length === 1 ? workspaces[0] : null);
  const error = ERRORS[one(params.error)] ?? null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {workspaces.length === 0 ? (
            <EmptyState
              icon={<Lock />}
              titleAs="h1"
              title="Only an owner or admin connects Pipedrive"
              body="Ask an owner or admin of your workspace to connect Pipedrive, or sign in with the account that is one."
              action={
                <Button asChild variant="secondary">
                  <Link href="/onboarding">Your workspaces</Link>
                </Button>
              }
            />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Connect Pipedrive</h1>
              <p className="mt-3 text-sm text-ink-2">
                Bring your won deals in from Pipedrive, with their organizations and persons. Each won deal waits for you on Bills & receivables, and becomes a
                deal with its collection schedule only when you plan it.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/pipedrive/connect" className="mt-6 space-y-5">
                {workspaces.length === 1 ? (
                  <>
                    <input type="hidden" name="org" value={workspaces[0].slug} />
                    <p className="text-sm text-ink-2">
                      Workspace: <strong className="font-semibold text-ink">{workspaces[0].name}</strong>
                    </p>
                  </>
                ) : (
                  <NativeRadioGroup
                    legend="Workspace"
                    name="org"
                    required
                    defaultValue={chosen?.slug}
                    options={workspaces.map((membership) => ({
                      value: membership.slug,
                      label: membership.name,
                      description: networkProfile(membership.network).label,
                    }))}
                  />
                )}
                <Callout title="What Vestiarion does with Pipedrive's data">
                  <ul className="list-disc space-y-1 pl-5">
                    {consentStatement("pipedrive").map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Callout>
                <p className="text-sm text-ink-2">
                  One Pipedrive company connects to one Vestiarion workspace at a time. Pipedrive asks you to install Vestiarion in your company: connect as a
                  Pipedrive admin to bring every deal in.
                </p>
                <NativeCheckbox
                  name="consent"
                  value="yes"
                  required
                  label={CONSENT_LABEL}
                  description="Connecting records your agreement, with its date, on the connection and in the workspace's signed ledger."
                />
                {one(params.consent) === "missing" && (
                  <p role="alert" className="text-sm text-refused">
                    Tick I agree to connect Pipedrive.
                  </p>
                )}
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Continue to Pipedrive
                </Button>
              </form>
              <p className="mt-4 text-sm text-ink-3">Signed in as {user.email ?? "you"}.</p>
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
