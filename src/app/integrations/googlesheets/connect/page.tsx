import type { Metadata } from "next";
import { FileSpreadsheet, Link2, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectorConsent } from "@/components/ConnectorConsent";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { NativeCheckbox, NativeRadioGroup } from "@/components/ui/NativeChoice";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { CONSENT_LABEL } from "@/lib/connectors/consent";
import { googleSheetsSettingsFromEnv } from "@/lib/googlesheets/settings";
import { networkProfile } from "@/lib/network";

export const metadata: Metadata = { title: "Connect Google Sheets" };
export const dynamic = "force-dynamic";

type ConnectPageProps = {
  searchParams: Promise<{ org?: string | string[]; consent?: string | string[]; error?: string | string[] }>;
};

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin of a workspace connects Google Sheets to it.",
  not_set_up: "Google Sheets is not set up on this deployment yet.",
};

/**
 * Connecting Google Sheets (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS2, GS3, GS4, GS18,
 * "The connect page"). Reading this page has no side effect. The person picks the workspace, among those they may manage
 * integrations for (the one the Settings card names in `?org=`, or the only one, picked already), reads what Vestiarion
 * does with the Google Drive and ticks I agree (real inputs with labels); Continue to Google posts to the connect route,
 * which checks all of it again. Google Sheets is named in words beside a neutral icon: no Google mark without Google's
 * permission.
 */
export default async function GoogleSheetsConnectPage({ searchParams }: ConnectPageProps) {
  const params = await searchParams;
  const org = one(params.org);
  const user = await verifySession(`/integrations/googlesheets/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!googleSheetsSettingsFromEnv()) notFound();
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
              title="Only an owner or admin connects Google Sheets"
              body="Ask an owner or admin of your workspace to connect Google Sheets, or sign in with the account that is one."
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
                  <FileSpreadsheet aria-hidden className="size-6" />
                </span>
                <span>Connect Google Sheets</span>
              </h1>
              <p className="mt-3 text-sm text-ink-2">
                Send a month&apos;s close pack to a spreadsheet in your Google Drive: one row per payment, each with the signed ledger entry that records it.
                Vestiarion asks Google for one permission: to make spreadsheets and change only the ones it made.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/googlesheets/connect" className="mt-6 space-y-5">
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
                <ConnectorConsent provider="googlesheets" title="What Vestiarion does with your Google Drive" changed={one(params.consent) === "changed"} />
                <p className="text-sm text-ink-2">
                  Google asks you to allow access as yourself: the spreadsheets go to the Drive of the Google account you choose there, and only that account
                  can open them until it shares them.
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
                    Tick I agree to connect Google Sheets.
                  </p>
                )}
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Continue to Google
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
