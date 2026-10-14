import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DocsLink } from "@/components/DocsLink";
import { COMMISSIONS_SUB, CommissionsScreen } from "@/components/commissions/CommissionsScreen";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { billsHref, invoiceHref } from "@/lib/bills-view";
import { shellModes } from "@/lib/circle";
import { readCommissions, type CommissionsRead } from "@/lib/commissions/read";
import { inOrg } from "@/lib/dal/scope";
import { listMembers } from "@/lib/platform/members";
import { stats } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Commissions" };

/**
 * Commissions on money received (docs/superpowers/specs/2026-10-14-commissions-design.md C10): each partner's plan in
 * force, then each partner's commissions per currency (due now, held, in payables) with Create payable for an owner or
 * admin who is not that partner. Every member reads it. Before migration 0118 runs, it says commissions are not set up.
 */
export default async function CommissionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const [read, dashboardStats, canWrite] = await Promise.all([
      readCommissions().catch((error: unknown): CommissionsRead | null => {
        console.error("commissions: not read", error instanceof Error ? error.message : error);
        return null;
      }),
      stats(),
      viewerCan(slug, "records.write"),
    ]);
    const members = canWrite ? await listMembers(access.membership.orgId).catch(() => null) : null;
    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title="Commissions"
          sub={COMMISSIONS_SUB}
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="link">
                <Link href={orgHref(slug, billsHref({ tab: "receivables" }))}>
                  <ArrowLeft aria-hidden />
                  Receivables
                </Link>
              </Button>
              <DocsLink href="/docs/guides/commissions" topic="commissions" />
            </div>
          }
        />
        {read === null ? (
          <Callout tone="held">Commissions could not be read just now. Reload the page in a moment.</Callout>
        ) : !read.available ? (
          <Callout>Commissions are not set up on this deployment yet.</Callout>
        ) : (
          <CommissionsScreen
            orgSlug={slug}
            read={read}
            canWrite={canWrite}
            viewerId={access.user.id}
            members={members ? members.map(({ userId, email }) => ({ userId, email })) : null}
            now={new Date()}
            invoiceHref={(invoiceId) => orgHref(slug, invoiceHref(invoiceId))}
          />
        )}
      </ProductShell>
    );
  });
}
