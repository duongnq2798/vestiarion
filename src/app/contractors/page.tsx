import AgentControls from "@/components/AgentControls";
import MilestoneVerification from "@/components/MilestoneVerification";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { milestoneDecision } from "@/components/vx/map";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { hasAgentControlSession } from "@/lib/agent-session";
import { listLedgerEntries } from "@/lib/ledger";
import { listMilestones, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ContractorsPage() {
  const [milestones, entries, dashboardStats, canMutate] = await Promise.all([
    listMilestones(),
    listLedgerEntries(300),
    stats(),
    hasAgentControlSession(),
  ]);
  const decisions = milestones.map((milestone) => milestoneDecision(milestone, entries));

  return (
    <ProductShell active="contractors" day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt}>
      <PageHead
        title="Contractors"
        sub="Milestone pay follows verified work instead of a Net-30 calendar. Every release still passes risk and authority guardrails."
        right={<AgentControls nextDay={dashboardStats.day + 1} headSeq={entries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
      />
      <div className="space-y-5">
        {decisions.map((decision, index) => (
          <div key={decision.id}>
            <DecisionCard decision={decision} />
            {canMutate && (
              <MilestoneVerification
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
