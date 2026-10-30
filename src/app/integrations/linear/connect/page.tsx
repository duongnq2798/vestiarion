import type { Metadata } from "next";
import { Link2, Lock, SquareKanban } from "lucide-react";
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
import { linearSettingsFromEnv } from "@/lib/linear/settings";
import { networkProfile } from "@/lib/network";

export const metadata: Metadata = { title: "Connect Linear" };
export const dynamic = "force-dynamic";

type ConnectPageProps = {
  searchParams: Promise<{ org?: string | string[]; consent?: string | string[]; error?: string | string[] }>;
};

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin of a workspace connects Linear to it.",
  not_set_up: "Linear is not set up on this deployment yet.",
};

/**
 * Connecting Linear (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2, LN16), as Asana's connect page.
 * Reading this page has no side effect. The person picks the workspace, among those they may manage integrations for
 * (the one a Settings card names in `?org=`, or the only one, picked already), reads what Vestiarion does with Linear's
 * data and ticks I agree (real inputs with labels); Continue to Linear posts to the connect route, which checks all of
 * it again. The connection reads Linear as the person who connects it, with read access only. Headed by Linear's name
 * beside the product's icon for work tools: Linear's logo is not shipped yet.
 */
export default async function LinearConnectPage({ searchParams }: ConnectPageProps) {
  const params = await searchParams;
  const org = one(params.org);
  const user = await verifySession(`/integrations/linear/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!linearSettingsFromEnv()) notFound();
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
              title="Only an owner or admin connects Linear"
              body="Ask an owner or admin of your workspace to connect Linear, or sign in with the account that is one."
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
                  <SquareKanban aria-hidden className="size-6 text-ink-2" />
                </span>
                <span>Connect Linear</span>
              </h1>
              <p className="mt-3 text-sm text-ink-2">
                Pay contractors for work delivered in Linear. You link a milestone to its Linear issue; when the issue is done, a person accepts the work
                against the milestone&apos;s criteria, and only then does the agent decide on pay, under every guardrail.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/linear/connect" className="mt-6 space-y-5">
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
                <ConnectorConsent provider="linear" title="What Vestiarion does with Linear's data" changed={one(params.consent) === "changed"} />
                <p className="text-sm text-ink-2">
                  Linear asks you to allow read access as yourself: Vestiarion sees the issues you can see, and reads only the ones linked to milestones.
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
                    Tick I agree to connect Linear.
                  </p>
                )}
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Continue to Linear
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
