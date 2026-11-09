import type { Metadata } from "next";
import { Building2, SquareKanban } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { verifySession } from "@/lib/auth/session";
import { jiraSettingsFromEnv } from "@/lib/jira/settings";

export const metadata: Metadata = { title: "Jira" };
export const dynamic = "force-dynamic";

/**
 * Jira for a signed-in person (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1, JR2), as Linear's launch
 * page: their workspace's Jira settings, at once when they have one workspace, and a pick when they have several. A
 * signed-out visitor signs in and comes back here. Where Jira is not configured, the page says so, rather than nothing
 * (JR1). Headed by Jira's name beside the product's icon for work tools: no Atlassian logo is shipped (JR22).
 */
export default async function JiraIntegrationPage() {
  const user = await verifySession("/integrations/jira");
  const on = jiraSettingsFromEnv() !== null;
  const memberships = on ? await membershipsOf(user.id) : [];
  if (on && memberships.length === 1) redirect(`/o/${memberships[0].slug}/settings#jira`);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {!on ? (
            <EmptyState
              icon={<SquareKanban />}
              titleAs="h1"
              title="Jira is not set up yet"
              body="Jira is not set up on this deployment yet."
              action={
                <Button asChild variant="secondary">
                  <Link href="/onboarding">Your workspaces</Link>
                </Button>
              }
            />
          ) : memberships.length === 0 ? (
            <EmptyState
              icon={<Building2 />}
              titleAs="h1"
              title="Create a workspace first"
              body="Jira connects to a workspace. Create one, then connect Jira from its Settings."
              action={
                <Button asChild>
                  <Link href="/onboarding">Create a workspace</Link>
                </Button>
              }
            />
          ) : (
            <>
              <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
                <SquareKanban aria-hidden className="size-6 shrink-0 text-ink-2" />
                Jira
              </h1>
              <p className="mt-3 text-sm text-ink-2">Pick the workspace whose Jira settings you want.</p>
              <ul className="mt-6 divide-y divide-line rounded-lg border border-line">
                {memberships.map((membership) => (
                  <li key={membership.orgId} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="text-sm font-semibold text-ink">{membership.name}</span>
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/o/${membership.slug}/settings#jira`}>Jira settings</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </main>
      <SiteFooter compact />
    </div>
  );
}
