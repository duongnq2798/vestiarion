import AgentControls from "@/components/AgentControls";
import MilestoneVerification from "@/components/MilestoneVerification";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { milestoneDecision } from "@/components/vx/map";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { viewerCanMutate } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { listLedgerEntries, listLedgerEntriesForTargets } from "@/lib/ledger";
import { listMilestones, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ContractorsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requireMembership(slug);
  const [milestones, headEntries, dashboardStats, canMutate] = await Promise.all([
    listMilestones(),
    listLedgerEntries(1),
    stats(),
    viewerCanMutate(slug),
  ]);
  const entries = await listLedgerEntriesForTargets({ milestoneIds: milestones.map((milestone) => milestone.id) });
  const decisions = milestones.map((milestone) => milestoneDecision(milestone, entries));

  return (
    <ProductShell active="contractors" day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} orgSlug={slug}>
      <PageHead
        title="Contractors"
        sub="Milestone pay follows verified work instead of a Net-30 calendar. Every release still passes risk and authority guardrails."
        right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
      />
      <div className="space-y-5">
        {decisions.map((decision, index) => (
          <div key={decision.id}>
            <DecisionCard decision={decision} orgSlug={slug} />
            {canMutate && (
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
    </ProductShell>
  );
}
