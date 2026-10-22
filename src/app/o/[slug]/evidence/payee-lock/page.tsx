import type { Metadata } from "next";
import { DocsLink } from "@/components/DocsLink";
import { PayeeLockEvidenceView } from "@/components/PayeeLockEvidenceView";
import { Callout } from "@/components/ui/Callout";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { requireMembership } from "@/lib/auth/membership";
import { shellModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import type { Period } from "@/lib/payee-lock-evidence";
import { readPayeeLockEvidence } from "@/lib/payee-lock-evidence-read";
import { evidencePeriodFrom, last30Days, payeeLockQuestions } from "@/lib/payee-lock-evidence-report";
import { stats } from "@/lib/queries";
import { takeEvidencePageToken } from "@/lib/rate-limit";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Payee lock evidence" };

type PayeeLockEvidencePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string | string[]; to?: string | string[]; all?: string | string[] }>;
};

/** The period links: the last 30 days, this calendar year and all time, each in whole UTC days. */
function presets(now: Date): Array<{ label: string; period: Period }> {
  const today = now.toISOString().slice(0, 10);
  return [
    { label: "Last 30 days", period: last30Days(now) },
    { label: "This year", period: { from: `${today.slice(0, 4)}-01-01`, to: today } },
    { label: "All time", period: { from: null, to: null } },
  ];
}

/**
 * The payee lock's evidence pack as a page (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md EP7): for
 * any member, as the file is. It opens on the last 30 days; a period that cannot be read shows those and says so. A
 * member reads it twenty times at once, then once every 3 seconds. Read-only; it writes no ledger entry.
 */
export default async function PayeeLockEvidencePage({ params, searchParams }: PayeeLockEvidencePageProps) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const now = new Date();
    const { period, unreadable } = evidencePeriodFrom(await searchParams, now);
    const allowed = takeEvidencePageToken(access.user.id);
    const [pack, dashboardStats] = await Promise.all([
      allowed ? readPayeeLockEvidence({ workspace: { slug: access.membership.slug, name: access.membership.name }, period }) : null,
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
          title="Payee lock evidence"
          sub="Every payout address change: who entered it, how it was checked and by whom, what was held back, and the first payment, each fact resting on signed ledger entries."
          right={
            <div className="print:hidden">
              <DocsLink href="/docs/guides/evidence-and-receipts" topic="the payee lock's evidence pack" />
            </div>
          }
        />
        {unreadable && (
          <Callout tone="held" className="mb-6 print:hidden">
            That period could not be read, so this shows the last 30 days. Choose days with the From and To fields.
          </Callout>
        )}
        {pack ? (
          <PayeeLockEvidenceView pack={pack} questions={payeeLockQuestions(pack)} slug={access.membership.slug} presets={presets(now)} />
        ) : (
          <Callout tone="held">The evidence pack was read many times in a row. Try again in a minute.</Callout>
        )}
      </ProductShell>
    );
  });
}
