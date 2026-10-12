import type { Metadata } from "next";
import { Clock, Link2, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { verifySession } from "@/lib/auth/session";
import { CONSENT_LABEL, consentStatement } from "@/lib/connectors/consent";
import { pendingChoice } from "@/lib/connectors/token-store";
import { withOrg } from "@/lib/dal/scope";
import { networkProfile } from "@/lib/network";
import { xeroSettingsFromEnv } from "@/lib/xero/settings";

export const metadata: Metadata = { title: "Connect Xero" };
export const dynamic = "force-dynamic";

type ConnectPageProps = {
  searchParams: Promise<{ org?: string | string[]; choose?: string | string[]; consent?: string | string[]; error?: string | string[] }>;
};

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin of a workspace connects Xero to it.",
  not_set_up: "Xero is not set up on this deployment yet.",
  expired: "The time to pick an organisation ran out. Start again.",
  pick: "Pick one of the organisations Xero listed.",
};

/**
 * Connecting Xero (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4, X12). Reading this page has no side
 * effect. The person picks the workspace, among those they may manage integrations for, reads what Vestiarion does with
 * Xero's data and ticks I agree; Continue to Xero posts to the connect route, which checks all of it again. After Xero,
 * when it authorized several organisations, the person picks one here, from the pending grant only they can read.
 */
export default async function XeroConnectPage({ searchParams }: ConnectPageProps) {
  const params = await searchParams;
  const org = one(params.org);
  const choose = one(params.choose);
  const user = await verifySession(`/integrations/xero/connect${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  if (!xeroSettingsFromEnv()) notFound();
  const workspaces = (await membershipsOf(user.id)).filter((membership) => can(membership.role, "integrations.manage"));
  const chosen = workspaces.find((membership) => membership.slug === org) ?? (workspaces.length === 1 ? workspaces[0] : null);
  const error = ERRORS[one(params.error)] ?? null;
  const pending =
    choose && chosen && /^[0-9a-f-]{36}$/.test(choose)
      ? await withOrg(chosen.orgId, () => pendingChoice(chosen.orgId, choose, user.id), { userId: user.id }).catch(() => null)
      : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-lg">
          {workspaces.length === 0 ? (
            <EmptyState
              icon={<Lock />}
              titleAs="h1"
              title="Only an owner or admin connects Xero"
              body="Ask an owner or admin of your workspace to connect Xero, or sign in with the account that is one."
              action={
                <Button asChild variant="secondary">
                  <Link href="/onboarding">Your workspaces</Link>
                </Button>
              }
            />
          ) : choose && !pending ? (
            <EmptyState
              icon={<Clock />}
              titleAs="h1"
              title="The time to pick an organisation ran out"
              body="Start again: Xero asks you once more which organisation to connect."
              action={
                <Button asChild>
                  <Link href={`/integrations/xero/connect${chosen ? `?org=${chosen.slug}` : ""}`}>Connect Xero</Link>
                </Button>
              }
            />
          ) : pending && chosen ? (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Pick the Xero organisation</h1>
              <p className="mt-3 text-sm text-ink-2">
                Xero gave access to more than one organisation. Pick the one whose bills come into{" "}
                <strong className="font-semibold text-ink">{chosen.name}</strong>. The others stay authorised in Xero until you remove them there, under
                Settings, Connected apps.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/xero/choose" className="mt-6 space-y-5">
                <input type="hidden" name="org" value={chosen.slug} />
                <input type="hidden" name="choice" value={pending.id} />
                <RadioGroup
                  legend="Organisation"
                  name="organisation"
                  required
                  options={pending.choices.map((choice) => ({ value: choice.externalOrgId, label: choice.name }))}
                />
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Connect this organisation
                </Button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Connect Xero</h1>
              <p className="mt-3 text-sm text-ink-2">
                Bring your approved bills in from Xero. Each one waits for you on Bills & receivables and becomes a payable only when you add it.
              </p>
              {error && (
                <p role="alert" className="mt-4 text-sm text-refused">
                  {error}
                </p>
              )}
              <form method="post" action="/api/integrations/xero/connect" className="mt-6 space-y-5">
                {workspaces.length === 1 ? (
                  <>
                    <input type="hidden" name="org" value={workspaces[0].slug} />
                    <p className="text-sm text-ink-2">
                      Workspace: <strong className="font-semibold text-ink">{workspaces[0].name}</strong>
                    </p>
                  </>
                ) : (
                  <RadioGroup
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
                <Callout title="What Vestiarion does with Xero's data">
                  <ul className="list-disc space-y-1 pl-5">
                    {consentStatement("xero").map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Callout>
                <Checkbox
                  name="consent"
                  value="yes"
                  required
                  label={CONSENT_LABEL}
                  description="Connecting records your agreement, with its date, on the connection and in the workspace's signed ledger."
                />
                {one(params.consent) === "missing" && (
                  <p role="alert" className="text-sm text-refused">
                    Tick I agree to connect Xero.
                  </p>
                )}
                <Button type="submit" icon={<Link2 aria-hidden />}>
                  Continue to Xero
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
