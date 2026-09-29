import { Flag } from "lucide-react";
import type { Metadata } from "next";
import AgentControls from "@/components/AgentControls";
import MilestoneVerification from "@/components/MilestoneVerification";
import { EmptyState } from "@/components/ui/EmptyState";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { milestoneDecision } from "@/components/vx/map";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries, listLedgerEntriesForTargets } from "@/lib/ledger";
import { listMilestones, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("contractors") };

export default async function ContractorsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const [milestones, headEntries, dashboardStats, canWrite] = await Promise.all([
      listMilestones(),
      listLedgerEntries(1),
      stats(),
      viewerCan(slug, "records.write"),
    ]);
    const entries = await listLedgerEntriesForTargets({ milestoneIds: milestones.map((milestone) => milestone.id) });
    const decisions = milestones.map((milestone) => milestoneDecision(milestone, entries));

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("contractors")}
          sub="Milestone pay follows verified work instead of a Net-30 calendar. Every release still passes risk and authority guardrails."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />
        {decisions.length === 0 ? (
          <EmptyState
            titleAs="h2"
            icon={<Flag />}
            title="No milestones yet"
            body="Contractor milestones appear here once they are recorded. Pay is released when the work is verified."
          />
        ) : (
          <div className="space-y-5">
            {decisions.map((decision, index) => (
              <div key={decision.id}>
                <DecisionCard decision={decision} orgSlug={slug} />
                {canWrite && (
                  <MilestoneVerification
                    orgSlug={slug}
                    milestoneId={milestones[index].id}
                    verified={milestones[index].verified}
                    disabled={milestones[index].status === "paid"}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </ProductShell>
    );
  });
}
