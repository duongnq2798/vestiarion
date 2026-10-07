import type { Metadata } from "next";
import { Inbox } from "lucide-react";
import ApprovalCard from "@/components/ApprovalCard";
import { ProposalCard } from "@/components/ProposalCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { AutoRefresh } from "@/components/AutoRefresh";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { listWaitingPayables } from "@/lib/agent/approvals";
import { db } from "@/lib/dal";
import { verdictView, type DecisionEntryFacts } from "@/lib/verdict-view";
import { verdictFacts } from "@/lib/verdicts";
import { isSoleApprover } from "@/lib/agent/sole-approver";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { shellModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listMembers } from "@/lib/platform/members";
import { listOpenProposals } from "@/lib/policy-proposals";
import { stats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("approvals") };

export default async function ApprovalsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const { user, membership } = access;
    const canDecide = can(membership.role, "approval.decide");
    const [waiting, dashboardStats, proposals, soleApprover] = await Promise.all([
      listWaitingPayables(),
      stats(),
      // Best effort: suggestions that cannot be read hide their section, nothing else.
      listOpenProposals().catch((error: unknown) => {
        console.error("approvals: proposals not loaded", error instanceof Error ? error.message : error);
        return [];
      }),
      // Whether this person may approve what they entered themselves (sole approver R5).
      canDecide ? isSoleApprover(user.id) : Promise.resolve(false),
    ]);
    // A payment held in shadow mode waits for a person's verdict, which pays it when they agree (shadow mode S4): the
    // agent's decision each one waits on, and any verdict given. Best effort, as the cards elsewhere read them.
    const verdictEntries: DecisionEntryFacts[] = waiting.flatMap((payable) =>
      payable.verdictEntry ? [{ seq: payable.verdictEntry.seq, ts: payable.verdictEntry.ts, actor: "agent" as const, action: "ap_pay", detail: { invoiceId: payable.id } }] : []
    );
    const verdicts = verdictEntries.length > 0 ? await verdictFacts(db(), verdictEntries, canDecide) : null;
    const verdictFor = (payable: (typeof waiting)[number]) =>
      verdicts
        ? verdictView(payable.id, verdictEntries.filter((entry) => entry.detail.invoiceId === payable.id), verdicts, payable.heldForVerdict === true, {
            amountUsdc: payable.amount,
            payee: payable.counterpartyName,
            address: payable.address,
          })
        : undefined;
    // Who approved a payment above the figure for two approvals, by email (two approvals T8): read only when someone has.
    const approverIds = new Set(waiting.flatMap((payable) => payable.twoApprovals?.approvals.map((approval) => approval.by) ?? []));
    const memberEmails: Record<string, string> =
      approverIds.size > 0
        ? Object.fromEntries((await listMembers(membership.orgId)).filter((member) => approverIds.has(member.userId)).map((member) => [member.userId, member.email]))
        : {};

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()}>
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
        {proposals.length > 0 && (
          <section className="mb-8">
            <SectionHeader title="Suggested by the agent" meta="from what people approved here" />
            <div className="space-y-4">
              {proposals.map((proposal) => (
                <ProposalCard key={proposal.id} proposal={proposal} orgSlug={slug} canDecide={can(membership.role, "records.write")} />
              ))}
            </div>
          </section>
        )}
        {waiting.length === 0 ? (
          <EmptyState icon={<Inbox />} title="Nothing is waiting for a decision." body="When the agent holds or flags a payable, it appears here." />
        ) : (
          <div className="space-y-4">
            {waiting.map((payable) => (
              <ApprovalCard
                key={payable.id}
                orgSlug={slug}
                payable={payable}
                canDecide={canDecide}
                viewerId={user.id}
                sandbox={membership.mode === "sandbox"}
                soleApprover={soleApprover}
                canEdit={can(membership.role, "records.write")}
                memberEmails={memberEmails}
                verdict={verdictFor(payable)}
              />
            ))}
          </div>
        )}
      </ProductShell>
    );
  });
}
