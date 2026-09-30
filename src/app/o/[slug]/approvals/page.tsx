import type { Metadata } from "next";
import { Inbox } from "lucide-react";
import ApprovalCard from "@/components/ApprovalCard";
import { AutoRefresh } from "@/components/AutoRefresh";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { listWaitingPayables } from "@/lib/agent/approvals";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { chainModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("approvals") };

export default async function ApprovalsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const { user, membership } = access;
    const canDecide = can(membership.role, "approval.decide");
    const [waiting, dashboardStats] = await Promise.all([listWaitingPayables(), stats()]);

    return (
      <ProductShell day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("approvals")}
          sub={
            canDecide
              ? "Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle."
              : "Payables the agent would not pay on its own, oldest due date first. An owner, admin or approver decides them."
          }
        />
        {/* A payable the agent just held, or one another approver just decided, shows up without a reload:
            every 15 s while something waits (someone else may be deciding it), every 30 s otherwise, and at once
            on return to the tab. Open dialogs and a typed rejection reason survive a refresh. */}
        <AutoRefresh intervalMs={waiting.length > 0 ? 15_000 : 30_000} />
        {waiting.length === 0 ? (
          <EmptyState icon={<Inbox />} title="Nothing is waiting for a decision." body="When the agent holds or flags a payable, it appears here." />
        ) : (
          <div className="space-y-4">
            {waiting.map((payable) => (
              <ApprovalCard key={payable.id} orgSlug={slug} payable={payable} canDecide={canDecide} viewerId={user.id} sandbox={membership.mode === "sandbox"} />
            ))}
          </div>
        )}
      </ProductShell>
    );
  });
}
