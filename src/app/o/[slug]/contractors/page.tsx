import { Flag } from "lucide-react";
import type { Metadata } from "next";
import AgentControls from "@/components/AgentControls";
import { EscrowPanel } from "@/components/EscrowPanel";
import { AutoRefresh } from "@/components/AutoRefresh";
import MilestoneIntake from "@/components/intake/MilestoneIntake";
import MilestoneVerification from "@/components/MilestoneVerification";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { milestoneDecision } from "@/components/vx/map";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { chainModes } from "@/lib/circle";
import { readEscrowContract } from "@/lib/circle/escrow-setup";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries, listLedgerEntriesForTargets } from "@/lib/ledger";
import { listCounterparties, listMilestones, stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("contractors") };

export default async function ContractorsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const live = access.membership.mode === "live";
    const [milestones, counterparties, headEntries, dashboardStats, canWrite, canManageTreasury, escrow] = await Promise.all([
      listMilestones(),
      listCounterparties(),
      listLedgerEntries(1),
      stats(),
      viewerCan(slug, "records.write"),
      viewerCan(slug, "treasury.manage"),
      // A live workspace's escrow (milestone escrow E2). Best effort: a read that fails shows no panel.
      live
        ? readEscrowContract().catch((error: unknown) => {
            console.error("contractors: escrow not loaded", error instanceof Error ? error.message : error);
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    const entries = await listLedgerEntriesForTargets({ milestoneIds: milestones.map((milestone) => milestone.id) });
    const decisions = milestones.map((milestone) => milestoneDecision(milestone, entries));
    // Clients pay the business; contractors are listed first, then vendors.
    const payees = counterparties
      .filter((counterparty) => counterparty.role !== "client")
      .sort((a, b) => Number(b.role === "contractor") - Number(a.role === "contractor"))
      .map(({ id, name, role }) => ({ id, name, role }));

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("contractors")}
          sub="Milestone pay follows verified work instead of a Net-30 calendar. Every release still passes risk and authority guardrails."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />
        {/* The agent decides within a minute of a milestone being verified: the page re-reads its
            data every 20 s, and at once on return to the tab, so the release appears without a reload. */}
        <AutoRefresh intervalMs={20_000} />

        <section className="mb-8">
          <SectionHeader title="Milestone intake" meta="work a contractor is paid for once it is verified" />
          {canWrite ? (
            <Card className="p-4 sm:p-6">
              <MilestoneIntake orgSlug={slug} contractors={payees} />
            </Card>
          ) : (
            <Callout>Only an owner or admin of this workspace can add milestones.</Callout>
          )}
        </section>

        {live && escrow !== undefined && (
          <section className="mb-8">
            <EscrowPanel orgSlug={slug} address={escrow?.address ?? null} deploying={Boolean(escrow && !escrow.address)} canSetUp={canManageTreasury} />
          </section>
        )}

        {decisions.length === 0 ? (
          <EmptyState
            titleAs="h2"
            icon={<Flag />}
            title="No milestones yet"
            body="Milestones appear here once they are added. Pay is released when the work is verified."
          />
        ) : (
          <div className="space-y-5">
            {decisions.map((decision, index) => (
              <div key={decision.id}>
                <DecisionCard decision={decision} orgSlug={slug} />
                {/* A paid milestone cannot be unverified (the action refuses it), so it has no controls. */}
                {canWrite && milestones[index].status !== "paid" && (
                  <MilestoneVerification
                    orgSlug={slug}
                    milestoneId={milestones[index].id}
                    verified={milestones[index].verified}
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
