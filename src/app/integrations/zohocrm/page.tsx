import type { Metadata } from "next";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { BrandName, PROVIDER_MARKS } from "@/components/vx/BrandMarks";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { membershipsOf } from "@/lib/auth/membership";
import { verifySession } from "@/lib/auth/session";
import { zohoCrmSettingsFromEnv } from "@/lib/zohocrm/settings";

export const metadata: Metadata = { title: "Zoho CRM" };
export const dynamic = "force-dynamic";

/**
 * Zoho CRM for a signed-in person (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C4): their workspace's
 * Zoho CRM settings, at once when they have one workspace, and a pick when they have several. A signed-out visitor signs
 * in and comes back here. Not there unless the Zoho client is configured. Headed by Zoho CRM's mark and name.
 */
export default async function ZohoCrmIntegrationPage() {
  const user = await verifySession("/integrations/zohocrm");
  if (!zohoCrmSettingsFromEnv()) notFound();
  const memberships = await membershipsOf(user.id);
  if (memberships.length === 1) redirect(`/o/${memberships[0].slug}/settings#zohocrm`);

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
              body="Zoho CRM connects to a workspace. Create one, then connect Zoho CRM from its Settings."
              action={
                <Button asChild>
                  <Link href="/onboarding">Create a workspace</Link>
                </Button>
              }
            />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
                <BrandName brand={PROVIDER_MARKS.zohocrm} name="Zoho CRM" size={24} className="gap-3" />
              </h1>
              <p className="mt-3 text-sm text-ink-2">Pick the workspace whose Zoho CRM settings you want.</p>
              <ul className="mt-6 divide-y divide-line rounded-lg border border-line">
                {memberships.map((membership) => (
                  <li key={membership.orgId} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="text-sm font-semibold text-ink">{membership.name}</span>
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/o/${membership.slug}/settings#zohocrm`}>Zoho CRM settings</Link>
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
