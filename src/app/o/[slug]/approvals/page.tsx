import type { Metadata } from "next";
import { cosignsNow } from "@/lib/approval-policy";
import { Inbox } from "lucide-react";
import { dismissChecklistAction } from "@/app/actions/onboarding";
import ApprovalCard from "@/components/ApprovalCard";
import { ProposalCard } from "@/components/ProposalCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { AutoRefresh } from "@/components/AutoRefresh";
import { DocsLink } from "@/components/DocsLink";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChecklistVisit } from "@/components/vx/ChecklistVisit";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { listWaitingPayables } from "@/lib/agent/approvals";
import { readCosignStates } from "@/lib/cosign-state";
import { db } from "@/lib/dal";
import { readDocumentRequests } from "@/lib/document-requests/read";
import { documentChecksMode, readDocumentChecksStatus } from "@/lib/document-requests/setting";
import type { DocumentRequestView } from "@/lib/document-requests/rules";
import { verdictView, type DecisionEntryFacts } from "@/lib/verdict-view";
import { verdictFacts } from "@/lib/verdicts";
import { isSoleApprover } from "@/lib/agent/sole-approver";
import { exceptionFacts } from "@/lib/exceptions";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { paysSimulated } from "@/lib/capability";
import { readCapability } from "@/lib/capability-read";
import { shellModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { listMembers } from "@/lib/platform/members";
import { readOnboardingMarks, readPersonActs } from "@/lib/onboarding/read";
import { approverChecklist, checklistRoleOf, type OnboardingMark } from "@/lib/onboarding/role-checklists";
import { listOpenProposals } from "@/lib/policy-proposals";
import { stats } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("approvals") };

export default async function ApprovalsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const { user, membership } = access;
    const canDecide = can(membership.role, "approval.decide");
    const [waiting, dashboardStats, proposals, soleApprover, canCosign] = await Promise.all([
      listWaitingPayables(),
      stats(),
      // Best effort: suggestions that cannot be read hide their section, nothing else.
      listOpenProposals().catch((error: unknown) => {
        console.error("approvals: proposals not loaded", error instanceof Error ? error.message : error);
        return [];
      }),
      // Whether this person may approve what they entered themselves (sole approver R5).
      canDecide ? isSoleApprover(user.id) : Promise.resolve(false),
      // An accountant co-signs a payment above the figure while an owner has turned it on (accountant co-sign CS2).
      cosignsNow(membership.role),
    ]);
    // A payment held in shadow mode waits for a person's verdict, which pays it when they agree (shadow mode S4): the
    // agent's decision each one waits on, and any verdict given. Best effort, as the cards elsewhere read them.
    const verdictEntries: DecisionEntryFacts[] = waiting.flatMap((payable) =>
      payable.verdictEntry ? [{ seq: payable.verdictEntry.seq, ts: payable.verdictEntry.ts, actor: "agent" as const, action: "ap_pay", detail: { invoiceId: payable.id } }] : []
    );
    const verdicts = verdictEntries.length > 0 ? await verdictFacts(db(), verdictEntries, canDecide) : null;
    // For a co-signing accountant, whether each payment can be co-signed now, as the accountant console says it (accountant
    // queue AQ5), so Co-sign shows only where the server would take it. Best effort: unread, the cards offer Co-sign on
    // every payment above the figure, as before, and the server refuses what it must.
    const cosignStates = canCosign
      ? await readCosignStates(
          user.id,
          waiting.map((payable) => ({
            id: payable.id,
            amount: payable.amount,
            currency: payable.currency,
            status: payable.status,
            reviewedAt: payable.reviewedAt,
            counterpartyId: payable.counterpartyId,
            riskLevel: payable.riskLevel,
            address: payable.address,
          }))
        ).catch((error: unknown) => {
          console.error("approvals: co-sign states not read", error instanceof Error ? error.message : error);
          return null;
        })
      : null;
    // Whether Approve and pay is simulated: the workspace's capability, not its mode, since a sandbox connected to Circle
    // pays for real (capability and reasons R5).
    const capability = verdicts?.capability ?? (await readCapability());
    const verdictFor = (payable: (typeof waiting)[number]) =>
      verdicts
        ? verdictView(payable.id, verdictEntries.filter((entry) => entry.detail.invoiceId === payable.id), verdicts, payable.heldForVerdict === true, {
            amountUsdc: payable.amount,
            payee: payable.counterpartyName,
            address: payable.address,
          })
        : undefined;
    // The members, read once while something waits: who approved a payment above the figure for two approvals, by email
    // (two approvals T8), and who can act on each payable (deal cash readiness E3). Best effort: a read that fails leaves
    // the cards to be decided as before, without who can act, rather than fail the page.
    const members =
      waiting.length > 0
        ? await listMembers(membership.orgId).catch((error: unknown) => {
            console.error("approvals: members not read", error instanceof Error ? error.message : error);
            return null;
          })
        : [];
    const approverIds = new Set(waiting.flatMap((payable) => payable.twoApprovals?.approvals.map((approval) => approval.by) ?? []));
    const memberEmails: Record<string, string> = Object.fromEntries((members ?? []).filter((member) => approverIds.has(member.userId)).map((member) => [member.userId, member.email]));
    // Each held payable's priority, the day it must be decided by, and who can act on it (E1-E3), less whoever a first
    // payment's address leaves out (N4); none when the members could not be read, never "nobody can approve it".
    const today = new Date().toISOString().slice(0, 10);
    const exceptionOf = (payable: (typeof waiting)[number]) =>
      members
        ? exceptionFacts(
            { dueDate: payable.dueDate, discount: payable.discount, lateFee: payable.lateFee, currency: payable.currency, createdBy: payable.createdBy, leftOut: payable.firstPaymentLeftOut },
            members,
            today
          )
        : undefined;

    // An approver's checklist (onboarding by role R2): this page open is its first step, and a bill waiting on it, its
    // reasons on its card, the second. Both are recorded for this person (migration 0114), best effort, so the console
    // ticks them too: once the page is in the browser (`ChecklistVisit`), never while it renders. Deciding a bill is read
    // from the signed ledger.
    const approverList = checklistRoleOf(membership.role) === "approver" ? await approverOnboarding(user.id, waiting) : null;
    // What the agent asked each bill's vendor for, or would in shadow, and what the vendor sent (document requests ER6).
    // Best effort: unread, the cards show none, as before migration 0142.
    // Whether an owner or admin may attach the vendor's document, and how it is checked (document checks DK11). Best
    // effort, read once: unread, no card offers it.
    const [documentRequests, documentChecks] = await Promise.all([
      readDocumentRequests(waiting.map((payable) => payable.id)).catch((error: unknown) => {
        console.error("approvals: document requests not read", error instanceof Error ? error.message : error);
        return new Map<string, DocumentRequestView>();
      }),
      waiting.length > 0
        ? readDocumentChecksStatus(db())
            .then(documentChecksMode)
            .catch((error: unknown) => {
              console.error("approvals: document checks not read", error instanceof Error ? error.message : error);
              return null;
            })
        : Promise.resolve(null),
    ]);

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title={sectionTitle("approvals")}
          sub={
            canDecide
              ? "Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle."
              : "Payables the agent would not pay on its own, oldest due date first. An owner, admin or approver decides them."
          }
          right={<DocsLink href="/docs/guides/controls" topic="how payments are controlled" />}
        />
        {/* A payable the agent just held, or one another approver just decided, shows up without a reload:
            every 15 s while something waits (someone else may be deciding it), every 30 s otherwise, and at once
            on return to the tab. Open dialogs and a typed rejection reason survive a refresh. */}
        <AutoRefresh intervalMs={waiting.length > 0 ? 15_000 : 30_000} />
        {approverList && <GettingStarted slug={slug} checklist={approverList.checklist} isOwner={false} dismiss={approverList.canDismiss ? dismissChecklistAction : undefined} />}
        {approverList?.unrecorded && <ChecklistVisit page="approvals" slugs={[slug]} />}
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
                sandbox={paysSimulated(capability)}
                soleApprover={soleApprover}
                canEdit={can(membership.role, "records.write")}
                memberEmails={memberEmails}
                verdict={verdictFor(payable)}
                exception={exceptionOf(payable)}
                viewerEmail={user.email}
                canCosign={canCosign}
                cosign={cosignStates?.get(payable.id)}
                documentRequest={documentRequests.get(payable.id)}
                documentChecks={documentChecks}
              />
            ))}
          </div>
        )}
      </ProductShell>
    );
  });
}

/**
 * The approver's checklist on Approvals, ticked with what opening it just did: the page seen, and a held bill's reasons.
 * Reading writes nothing; `unrecorded` says the page should have the visit recorded.
 */
async function approverOnboarding(userId: string, waiting: ReadonlyArray<{ id: string; status: string; reclaimable?: boolean }>) {
  const [marks, acts] = await Promise.all([readOnboardingMarks(userId), readPersonActs(userId)]);
  const seen: OnboardingMark[] = ["approvals_opened", ...(waiting.length > 0 ? (["held_reason_seen"] as const) : [])];
  return {
    canDismiss: marks.available,
    unrecorded: marks.available && seen.some((mark) => !marks.mine.has(mark)),
    checklist: approverChecklist({
      approvalsOpened: true,
      heldReasonSeen: marks.mine.has("held_reason_seen") || waiting.length > 0,
      decided: acts.decided,
      waitingCount: waiting.filter((payable) => payable.status !== "processing" || payable.reclaimable).length,
      firstWaitingId: waiting[0]?.id ?? null,
      dismissed: marks.mine.has("dismissed_approver"),
    }),
  };
}
