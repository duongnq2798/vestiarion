import type { Metadata } from "next";
import { Link2, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectorConsent } from "@/components/ConnectorConsent";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { NativeCheckbox, NativeRadioGroup } from "@/components/ui/NativeChoice";
import { BrandMark } from "@/components/vx/BrandMarks";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { asanaSettingsFromEnv } from "@/lib/asana/settings";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { CONSENT_LABEL } from "@/lib/connectors/consent";
import { networkProfile } from "@/lib/network";

export const metadata: Metadata = { title: "Connect Asana" };
export const dynamic = "force-dynamic";

type ConnectPageProps = {
  searchParams: Promise<{ org?: string | string[]; consent?: string | string[]; error?: string | string[] }>;
};

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin of a workspace connects Asana to it.",
  not_set_up: "Asana is not set up on this deployment yet.",
};

/**
 * Connecting Asana (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2, A15). Reading this page has no side
 * effect. The person picks the workspace, among those they may manage integrations for (the one a Settings card names in
 * `?org=`, or the only one, picked already), reads what Vestiarion does with Asana's data and ticks I agree (real inputs
 * with labels); Continue to Asana posts to the connect route, which checks all of it again. The connection reads Asana as
 * the person who connects it.
 */
export default async function AsanaConnectPage({ searchParams }: ConnectPageProps) {
  const params = await searchParams;
  const org = one(params.org);
  const user = await verifySession(`/integrations/asana/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!asanaSettingsFromEnv()) notFound();
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
              title="Only an owner or admin connects Asana"
              body="Ask an owner or admin of your workspace to connect Asana, or sign in with the account that is one."
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
                  <BrandMark brand="asana-lockup" size={24} />
                </span>
                <span>Connect Asana</span>
              </h1>
              <p className="mt-3 text-sm text-ink-2">
                Pay contractors for work delivered in Asana. You link a milestone to its Asana task; when the task is completed, a person accepts the work
                against the milestone&apos;s criteria, and only then does the agent decide on pay, under every guardrail.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/asana/connect" className="mt-6 space-y-5">
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
                <ConnectorConsent provider="asana" title="What Vestiarion does with Asana's data" changed={one(params.consent) === "changed"} />
                <p className="text-sm text-ink-2">Asana asks you to allow access as yourself: Vestiarion sees the tasks you can see, and reads only the ones linked to milestones.</p>
                <NativeCheckbox
                  name="consent"
                  value="yes"
                  required
                  label={CONSENT_LABEL}
                  description="Connecting records your agreement, with its date, on the connection and in the workspace's signed ledger."
                />
                {one(params.consent) === "missing" && (
                  <p role="alert" className="text-sm text-refused">
                    Tick I agree to connect Asana.
                  </p>
                )}
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Continue to Asana
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
