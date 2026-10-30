import type { Metadata } from "next";
import { Building2, SquareKanban } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { verifySession } from "@/lib/auth/session";
import { linearSettingsFromEnv } from "@/lib/linear/settings";

export const metadata: Metadata = { title: "Linear" };
export const dynamic = "force-dynamic";

/**
 * Linear for a signed-in person (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2), as Asana's launch
 * page: their workspace's Linear settings, at once when they have one workspace, and a pick when they have several. A
 * signed-out visitor signs in and comes back here. Not there unless Linear is configured. Headed by Linear's name beside
 * the product's icon for work tools: Linear's logo is not shipped yet (LN16).
 */
export default async function LinearIntegrationPage() {
  const user = await verifySession("/integrations/linear");
  if (!linearSettingsFromEnv()) notFound();
  const memberships = await membershipsOf(user.id);
  if (memberships.length === 1) redirect(`/o/${memberships[0].slug}/settings#linear`);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {memberships.length === 0 ? (
            <EmptyState
              icon={<Building2 />}
              titleAs="h1"
              title="Create a workspace first"
              body="Linear connects to a workspace. Create one, then connect Linear from its Settings."
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
                Linear
              </h1>
              <p className="mt-3 text-sm text-ink-2">Pick the workspace whose Linear settings you want.</p>
              <ul className="mt-6 divide-y divide-line rounded-lg border border-line">
                {memberships.map((membership) => (
                  <li key={membership.orgId} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="text-sm font-semibold text-ink">{membership.name}</span>
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/o/${membership.slug}/settings#linear`}>Linear settings</Link>
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
