import type { Metadata } from "next";
import { Folder, Link2, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectorConsent } from "@/components/ConnectorConsent";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { NativeCheckbox, NativeRadioGroup } from "@/components/ui/NativeChoice";
import { NativeSubmitButton } from "@/components/ui/NativeSubmitButton";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { CONSENT_LABEL } from "@/lib/connectors/consent";
import { googleDriveSettingsFromEnv } from "@/lib/googledrive/settings";
import { networkProfile } from "@/lib/network";

export const metadata: Metadata = { title: "Connect Google Drive" };
export const dynamic = "force-dynamic";

type ConnectPageProps = {
  searchParams: Promise<{ org?: string | string[]; consent?: string | string[]; error?: string | string[] }>;
};

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin of a workspace connects Google Drive to it.",
  not_set_up: "Google Drive is not set up on this deployment yet.",
};

/**
 * Connecting Google Drive (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD1, GD2, GD16), as Google
 * Sheets' connect page. Reading this page has no side effect. The person picks the workspace, among those they may
 * manage integrations for (the one the Settings card names in `?org=`, or the only one, picked already), reads what
 * Vestiarion does with the Google Drive and ticks I agree (real inputs with labels); Continue to Google posts to the
 * connect route, which checks all of it again. The page says plainly that Google shows its unverified-app screen until
 * Google verifies the read-only Drive permission. Google Drive is named in words beside a plain folder icon: no Google
 * mark without Google's permission.
 */
export default async function GoogleDriveConnectPage({ searchParams }: ConnectPageProps) {
  const params = await searchParams;
  const org = one(params.org);
  const user = await verifySession(`/integrations/googledrive/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!googleDriveSettingsFromEnv()) notFound();
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
              title="Only an owner or admin connects Google Drive"
              body="Ask an owner or admin of your workspace to connect Google Drive, or sign in with the account that is one."
              action={
                <Button asChild variant="secondary">
                  <Link href="/onboarding">Your workspaces</Link>
                </Button>
              }
            />
          ) : (
            <>
              <h1 className="flex items-start gap-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
                <span className="flex h-8 shrink-0 items-center text-ink-2">
                  <Folder aria-hidden className="size-6" />
                </span>
                <span>Connect Google Drive</span>
              </h1>
              <p className="mt-3 text-sm text-ink-2">
                Bring bills in from one Google Drive folder. Each PDF added to it is read into a bill that waits on Bills &amp; receivables until a person
                adds it. Vestiarion asks Google for one permission: to read your Drive. It reads only the folder you choose, and writes nothing.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/googledrive/connect" className="mt-6 space-y-5">
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
                <ConnectorConsent provider="googledrive" title="What Vestiarion does with your Google Drive" changed={one(params.consent) === "changed"} />
                <Callout tone="held" title="Google warns you first">
                  Google has not verified Vestiarion&apos;s permission to read Drive yet, so it shows a &quot;Google hasn&apos;t verified this app&quot;
                  screen before you allow it. To go on, choose Advanced, then the link to go to Vestiarion. Until then, Google also lets at most 100
                  people allow it. The warning goes once Google verifies the permission.
                </Callout>
                <p className="text-sm text-ink-2">
                  Google asks you to allow access as yourself: Vestiarion reads the folder with the access of the Google account you choose there, so the
                  folder must be that account&apos;s, or shared with it.
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
                    Tick I agree to connect Google Drive.
                  </p>
                )}
                <NativeSubmitButton icon={<Link2 aria-hidden />}>
                  Continue to Google
                </NativeSubmitButton>
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
