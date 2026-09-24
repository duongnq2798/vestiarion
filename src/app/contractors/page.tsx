import AgentControls from "@/components/AgentControls";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { milestoneDecision } from "@/components/vx/map";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { listLedgerEntries } from "@/lib/ledger";
import { listMilestones, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ContractorsPage() {
  const [milestones, entries, dashboardStats] = await Promise.all([
    listMilestones(),
    listLedgerEntries(300),
    stats(),
  ]);
  const decisions = milestones.map((milestone) => milestoneDecision(milestone, entries));

  return (
    <ProductShell active="contractors" day={dashboardStats.day}>
      <PageHead
        title="Contractors"
        sub="Milestone pay follows verified work instead of a Net-30 calendar. Every release still passes risk and authority guardrails."
        right={<AgentControls nextDay={dashboardStats.day + 1} headSeq={entries[0]?.seq ?? 0} />}
      />
      <div className="space-y-4">
        {decisions.map((decision) => <DecisionCard key={decision.id} decision={decision} />)}
      </div>
    </ProductShell>
  );
}
