import type { Metadata } from "next";
import { Link2, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectorConsent } from "@/components/ConnectorConsent";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { NativeCheckbox, NativeRadioGroup } from "@/components/ui/NativeChoice";
import { BrandMark, PROVIDER_MARKS } from "@/components/vx/BrandMarks";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { CONSENT_LABEL } from "@/lib/connectors/consent";
import { networkProfile } from "@/lib/network";
import { zohoCrmSettingsFromEnv } from "@/lib/zohocrm/settings";

export const metadata: Metadata = { title: "Connect Zoho CRM" };
export const dynamic = "force-dynamic";

type ConnectPageProps = {
  searchParams: Promise<{ org?: string | string[]; consent?: string | string[]; error?: string | string[] }>;
};

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin of a workspace connects Zoho CRM to it.",
  not_set_up: "Zoho CRM is not set up on this deployment yet.",
};

/**
 * Connecting Zoho CRM (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C4, C11). Reading this page has no
 * side effect. The person picks the workspace, among those they may manage integrations for (the one a Settings card
 * names in `?org=`, or the only one, picked already), reads what Vestiarion does with Zoho CRM's data and ticks I agree
 * (real inputs with labels); Continue to Zoho CRM posts to the connect route, which checks all of it again. Zoho asks the
 * person to sign in in their own data center and allow Vestiarion to read.
 */
export default async function ZohoCrmConnectPage({ searchParams }: ConnectPageProps) {
  const params = await searchParams;
  const org = one(params.org);
  const user = await verifySession(`/integrations/zohocrm/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!zohoCrmSettingsFromEnv()) notFound();
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
              title="Only an owner or admin connects Zoho CRM"
              body="Ask an owner or admin of your workspace to connect Zoho CRM, or sign in with the account that is one."
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
                  <BrandMark brand={PROVIDER_MARKS.zohocrm} size={24} />
                </span>
                <span>Connect Zoho CRM</span>
              </h1>
              <p className="mt-3 text-sm text-ink-2">
                Bring your won deals in from Zoho CRM, with their accounts and contacts. Each won deal waits for you on Bills & receivables, and becomes a
                deal with its collection schedule only when you plan it.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/zohocrm/connect" className="mt-6 space-y-5">
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
                <ConnectorConsent provider="zohocrm" title="What Vestiarion does with Zoho CRM's data" changed={one(params.consent) === "changed"} />
                <p className="text-sm text-ink-2">
                  Zoho asks you to sign in in your own data center and allow Vestiarion to read. Connect as a Zoho CRM administrator to bring every deal
                  in.
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
                    Tick I agree to connect Zoho CRM.
                  </p>
                )}
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Continue to Zoho CRM
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
