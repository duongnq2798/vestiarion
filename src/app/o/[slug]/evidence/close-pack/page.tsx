import type { Metadata } from "next";
import { ClosePackView } from "@/components/ClosePackView";
import { SheetsExport } from "@/components/close-pack/SheetsExport";
import { DocsLink } from "@/components/DocsLink";
import { Callout } from "@/components/ui/Callout";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { requireMembership } from "@/lib/auth/membership";
import { shellModes } from "@/lib/circle";
import { closePackMonthFrom } from "@/lib/close-pack/month";
import { readClosePack } from "@/lib/close-pack/read";
import { logClosePackTiming, msSince } from "@/lib/close-pack/timing";
import { inOrg } from "@/lib/dal/scope";
import { closePackSheetsView } from "@/lib/googlesheets/panel";
import { shellClock } from "@/lib/queries";
import { takeClosePackPageToken } from "@/lib/rate-limit";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";
/**
 * Export to Google Sheets, a Server Action of this page, starts no call to Google after 90 seconds (close pack Sheets
 * GS12). 300, as Bills, counterparties and the report set, rather than a duration of its own (close pack page speed CS9).
 */
export const maxDuration = 300;

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
 *
 * Its reads go at once (docs/superpowers/specs/2026-10-26-close-pack-page-speed-design.md CS2, CS4): the pack, the
 * header's clock, shadow mode and screening, and the Google Sheets view, all inside the workspace's scope. It logs one
 * timing line (CS7).
 */
export default async function ClosePackPage({ params, searchParams }: ClosePackPageProps) {
  const started = performance.now();
  const { slug } = await params;
  const access = await requireMembership(slug);
  const authed = performance.now();
  return inOrg(access, async () => {
    const scoped = performance.now();
    const now = new Date();
    const { month, unreadable } = closePackMonthFrom(await searchParams, now);
    const allowed = takeClosePackPageToken(access.user.id);
    const [pack, clock, status, sheets] = await Promise.all([
      allowed ? readClosePack({ month, workspace: { slug: access.membership.slug, name: access.membership.name }, now }) : null,
      shellClock(),
      shellStatus(),
      // Best effort: a read that fails is hidden and logged, so the month still shows (close pack Sheets GS5).
      closePackSheetsView({ month, role: access.membership.role }),
    ]);
    logClosePackTiming("page", { auth: authed - started, scope: scoped - authed, reads: msSince(scoped), total: msSince(started), pack: allowed });

    return (
      <ProductShell
        network={access.membership.network}
        day={clock.day}
        clockMode={clock.clockMode}
        lastCycleAt={clock.lastCycleAt}
        chainModes={shellModes()}
        status={status}
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
        {/* Export to Google Sheets is made from the month and the workspace, not the pack, so a render with no read keeps its answer (close pack Sheets GS5). */}
        <ClosePackView
          pack={pack}
          sheets={<SheetsExport key={month.key} orgSlug={access.membership.slug} month={month.key} view={sheets} />}
          refused={<Callout tone="held">The close pack was read many times in a row. Try again in a minute.</Callout>}
        />
      </ProductShell>
    );
  });
}
