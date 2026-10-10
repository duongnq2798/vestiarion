import type { Metadata } from "next";
import { DocsLink } from "@/components/DocsLink";
import { ActualsComparison } from "@/components/vx/ActualsComparison";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { WorkspaceReport } from "@/components/vx/WorkspaceReport";
import { sectionTitle } from "@/components/vx/nav";
import { readActualsFacts } from "@/lib/actual-payments";
import { compareActuals } from "@/lib/actual-payments-compare";
import { actualsCsvTemplate } from "@/lib/actual-payments-csv";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { shellModes } from "@/lib/circle";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { listMembers } from "@/lib/platform/members";
import { stats } from "@/lib/queries";
import { workspaceNetwork } from "@/lib/workspace-network";
import { buildReport } from "@/lib/workspace-report";
import { readReportFacts } from "@/lib/workspace-report-read";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("report") };

/**
 * The workspace report (docs/superpowers/specs/2026-10-09-workspace-report-design.md R1): every member reads what the
 * agent did with the workspace's real bills, and, bill by bill, what the business recorded paying beside it
 * (docs/superpowers/specs/2026-10-10-actual-payments-design.md). A read that fails throws to the section's error state
 * (R7): a report with rows missing would understate what happened. Before migration 0090 runs, the comparison says so
 * and the rest of the report is unchanged.
 */
export default async function ReportPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ actuals?: string | string[] }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const query = await searchParams;
    const [facts, actuals, dashboardStats, canRecord] = await Promise.all([
      readReportFacts(db(), workspaceNetwork().id, { sandbox: access.membership.mode === "sandbox" }),
      readActualsFacts(db()),
      stats(),
      viewerCan(slug, "records.write"),
    ]);
    const report = buildReport(facts);
    const comparison = actuals.available ? compareActuals(facts, actuals.facts) : null;
    // Who recorded each, by email, as Approvals names approvers. Best effort: a name that cannot be read is a member's.
    const members = comparison?.rows.some((row) => row.actual?.recordedBy)
      ? Object.fromEntries(
          (
            await listMembers(access.membership.orgId).catch((error: unknown) => {
              console.error("report: members not read", error instanceof Error ? error.message : error);
              return [];
            })
          ).map((member) => [member.userId, member.email])
        )
      : {};
    const notRecorded = comparison?.rows.filter((row) => row.actual === null && row.agent.stance !== "none") ?? [];
    const templateCsv =
      canRecord && notRecorded.length > 0
        ? actualsCsvTemplate(notRecorded.map((row) => ({ id: row.invoiceId, memo: null, payee: row.payee, amount: row.bill.amount, currency: row.bill.currency, bill: null, dueDate: row.dueDate, current: null })))
        : null;

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()}>
        <PageHead
          title={sectionTitle("report")}
          sub="What the agent did with this workspace's bills since it opened: what it paid and with what proof, what it stopped and why, and how often a person stepped in."
          right={<DocsLink href="/docs/guides/report" topic="reading the report" />}
        />
        <WorkspaceReport
          slug={slug}
          report={report}
          actuals={<ActualsComparison slug={slug} comparison={comparison} canRecord={canRecord && comparison !== null} members={members} templateCsv={templateCsv} showAll={query.actuals === "all"} />}
        />
      </ProductShell>
    );
  });
}
