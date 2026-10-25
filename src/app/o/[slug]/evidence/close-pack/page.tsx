import type { Metadata } from "next";
import { ClosePackView } from "@/components/ClosePackView";
import { DocsLink } from "@/components/DocsLink";
import { Callout } from "@/components/ui/Callout";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { requireMembership } from "@/lib/auth/membership";
import { shellModes } from "@/lib/circle";
import { closePackMonthFrom } from "@/lib/close-pack/month";
import { readClosePack } from "@/lib/close-pack/read";
import { inOrg } from "@/lib/dal/scope";
import { stats } from "@/lib/queries";
import { takeClosePackPageToken } from "@/lib/rate-limit";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Monthly close pack" };

type ClosePackPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string | string[] }>;
};

/**
 * The monthly close pack as a page (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP11, CP14): for any
 * member, inside the Audit log. It opens on last month; `?month=YYYY-MM` reads once, and a month given twice or one that
 * does not read shows last month and says so. A member reads it ten times at once, then once every 6 seconds, since each
 * read checks every cited entry's signature. Read-only: opening or printing it writes no ledger entry.
 */
export default async function ClosePackPage({ params, searchParams }: ClosePackPageProps) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const now = new Date();
    const { month, unreadable } = closePackMonthFrom(await searchParams, now);
    const allowed = takeClosePackPageToken(access.user.id);
    const [pack, dashboardStats] = await Promise.all([
      allowed ? readClosePack({ month, workspace: { slug: access.membership.slug, name: access.membership.name }, now }) : null,
      stats(),
    ]);

    return (
      <ProductShell
        network={access.membership.network}
        day={dashboardStats.day}
        clockMode={dashboardStats.clockMode}
        lastCycleAt={dashboardStats.lastCycleAt}
        chainModes={shellModes()}
        status={await shellStatus()}
      >
        <PageHead
          title="Monthly close pack"
          sub="Every payment settled in the month, one row each: the bill, who approved it, what was checked, the transaction, and the signed entry that records it."
          right={
            <div className="print:hidden">
              <DocsLink href="/docs/guides/accountants#the-monthly-close-pack" topic="the monthly close pack" />
            </div>
          }
        />
        {unreadable && (
          <Callout tone="held" className="mb-6 print:hidden">
            That month could not be read, so this shows last month. Choose a month with the Month field.
          </Callout>
        )}
        {pack ? <ClosePackView pack={pack} /> : <Callout tone="held">The close pack was read many times in a row. Try again in a minute.</Callout>}
      </ProductShell>
    );
  });
}
