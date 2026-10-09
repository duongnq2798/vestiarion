import type { Metadata } from "next";
import { DocsLink } from "@/components/DocsLink";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { WorkspaceReport } from "@/components/vx/WorkspaceReport";
import { sectionTitle } from "@/components/vx/nav";
import { requireMembership } from "@/lib/auth/membership";
import { shellModes } from "@/lib/circle";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { stats } from "@/lib/queries";
import { workspaceNetwork } from "@/lib/workspace-network";
import { buildReport } from "@/lib/workspace-report";
import { readReportFacts } from "@/lib/workspace-report-read";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("report") };

/**
 * The workspace report (docs/superpowers/specs/2026-10-09-workspace-report-design.md R1): every member reads what the
 * agent did with the workspace's real bills. A read that fails throws to the section's error state (R7): a report with
 * rows missing would understate what happened.
 */
export default async function ReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const [facts, dashboardStats] = await Promise.all([readReportFacts(db(), workspaceNetwork().id, { sandbox: access.membership.mode === "sandbox" }), stats()]);
    const report = buildReport(facts);

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()}>
        <PageHead
          title={sectionTitle("report")}
          sub="What the agent did with this workspace's real bills since it opened: what it paid and with what proof, what it stopped and why, and how often a person stepped in."
          right={<DocsLink href="/docs/guides/report" topic="reading the report" />}
        />
        <WorkspaceReport slug={slug} report={report} />
      </ProductShell>
    );
  });
}
