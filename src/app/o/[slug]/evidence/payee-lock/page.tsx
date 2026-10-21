import type { Metadata } from "next";
import { DocsLink } from "@/components/DocsLink";
import { PayeeLockEvidenceView } from "@/components/PayeeLockEvidenceView";
import { Callout } from "@/components/ui/Callout";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { requireMembership } from "@/lib/auth/membership";
import { shellModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { parsePeriod, type Period } from "@/lib/payee-lock-evidence";
import { readPayeeLockEvidence } from "@/lib/payee-lock-evidence-read";
import { payeeLockQuestions } from "@/lib/payee-lock-evidence-report";
import { stats } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Payee lock evidence" };

type PayeeLockEvidencePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
};

const DAY = 86_400_000;
const first = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

/** The period links: the last 30 days, this calendar year and all time, each in whole UTC days. */
function presets(now: Date): Array<{ label: string; period: Period }> {
  const today = now.toISOString().slice(0, 10);
  return [
    { label: "Last 30 days", period: { from: new Date(now.getTime() - 29 * DAY).toISOString().slice(0, 10), to: today } },
    { label: "This year", period: { from: `${today.slice(0, 4)}-01-01`, to: today } },
    { label: "All time", period: { from: null, to: null } },
  ];
}

/**
 * The payee lock's evidence pack as a page (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md EP7): for
 * any member, as the file is. A period that cannot be read shows all time and says so. Read-only; it writes no ledger
 * entry.
 */
export default async function PayeeLockEvidencePage({ params, searchParams }: PayeeLockEvidencePageProps) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const query = await searchParams;
    const asked = parsePeriod(first(query.from), first(query.to));
    const period = asked ?? { from: null, to: null };
    const [pack, dashboardStats] = await Promise.all([
      readPayeeLockEvidence({ workspace: { slug: access.membership.slug, name: access.membership.name }, period }),
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
              <DocsLink href="/docs/guides/first-payment#payee-lock" topic="the payee lock's evidence pack" />
            </div>
          }
        />
        {asked === null && (
          <Callout tone="held" className="mb-6 print:hidden">
            That period could not be read, so this shows all time. Choose days with the From and To fields.
          </Callout>
        )}
        <PayeeLockEvidenceView pack={pack} questions={payeeLockQuestions(pack)} slug={access.membership.slug} presets={presets(new Date())} />
      </ProductShell>
    );
  });
}
