import type { Metadata } from "next";
import { Link2, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { NativeCheckbox, NativeRadioGroup } from "@/components/ui/NativeChoice";
import { BrandMark } from "@/components/vx/BrandMarks";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { CONSENT_LABEL, consentStatement } from "@/lib/connectors/consent";
import { hubspotSettingsFromEnv } from "@/lib/hubspot/settings";
import { HUBSPOT_WRITE_STEPS } from "@/lib/hubspot/write-steps";
import { networkProfile } from "@/lib/network";

export const metadata: Metadata = { title: "Connect HubSpot" };
export const dynamic = "force-dynamic";

type ConnectPageProps = {
  searchParams: Promise<{ org?: string | string[]; consent?: string | string[]; error?: string | string[]; write?: string | string[] }>;
};

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin of a workspace connects HubSpot to it.",
  not_set_up: "HubSpot is not set up on this deployment yet.",
};

/**
 * Connecting HubSpot (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H4, H14). Reading this page has no
 * side effect. The person picks the workspace, among those they may manage integrations for (the one a Settings card
 * names in `?org=`, or the only one, picked already), reads what Vestiarion does with HubSpot's data and ticks I agree
 * (real inputs with labels); Continue to HubSpot posts to the connect route, which checks all of it again.
 * HubSpot asks which account to install the app in; one account is connected per workspace. Write receipts to HubSpot
 * (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3) is the person's own choice here, ticked when a Settings
 * card sent them to allow writing (`?write=1`): HubSpot is then asked for its write scopes too, and writing is turned on
 * once it grants them.
 */
export default async function HubSpotConnectPage({ searchParams }: ConnectPageProps) {
  const params = await searchParams;
  const org = one(params.org);
  const user = await verifySession(`/integrations/hubspot/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!hubspotSettingsFromEnv()) notFound();
  const workspaces = (await membershipsOf(user.id)).filter((membership) => can(membership.role, "integrations.manage"));
  const chosen = workspaces.find((membership) => membership.slug === org) ?? (workspaces.length === 1 ? workspaces[0] : null);
  const error = ERRORS[one(params.error)] ?? null;
  const write = one(params.write) === "1";

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {workspaces.length === 0 ? (
            <EmptyState
              icon={<Lock />}
              titleAs="h1"
              title="Only an owner or admin connects HubSpot"
              body="Ask an owner or admin of your workspace to connect HubSpot, or sign in with the account that is one."
              action={
                <Button asChild variant="secondary">
                  <Link href="/onboarding">Your workspaces</Link>
                </Button>
              }
            />
          ) : (
            <>
              <h1 className="flex items-start gap-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
                <span className="flex h-8 shrink-0 items-center">
                  <BrandMark brand="hubspot" size={24} />
                </span>
                <span>Connect HubSpot</span>
              </h1>
              <p className="mt-3 text-sm text-ink-2">
                Bring your customers and won deals in from HubSpot. Each won deal waits for you on Bills & receivables, and becomes a deal with its
                collection schedule only when you plan it.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/hubspot/connect" className="mt-6 space-y-5">
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
                <Callout title="What Vestiarion does with HubSpot's data">
                  <ul className="list-disc space-y-1 pl-5">
                    {consentStatement("hubspot").map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Callout>
                <p className="text-sm text-ink-2">One HubSpot account connects to one Vestiarion workspace at a time.</p>
                <NativeCheckbox
                  name="write"
                  value="yes"
                  defaultChecked={write}
                  label="Write receipts to HubSpot"
                  description={
                    <>
                      HubSpot is asked to let Vestiarion write, too: each deal planned from HubSpot then gets what was collected from payments confirmed on
                      Arc, what is still owed, the last receipt, the reconciliation status and a link to it, in a Vestiarion property group.
                      {" Payments on Arc testnet or in shadow mode are written only to a HubSpot developer test account or sandbox."}
                      <span className="mt-1.5 block font-medium text-ink-2">
                        {HUBSPOT_WRITE_STEPS.tick} {HUBSPOT_WRITE_STEPS.locked}
                      </span>
                    </>
                  }
                />
                <NativeCheckbox
                  name="consent"
                  value="yes"
                  required
                  label={CONSENT_LABEL}
                  description="Connecting records your agreement, with its date, on the connection and in the workspace's signed ledger."
                />
                {one(params.consent) === "missing" && (
                  <p role="alert" className="text-sm text-refused">
                    Tick I agree to connect HubSpot.
                  </p>
                )}
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Continue to HubSpot
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
