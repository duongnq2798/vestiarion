import { Flag, ListChecks, UserPlus } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";
import AgentControls from "@/components/AgentControls";
import { EscrowPanel } from "@/components/EscrowPanel";
import { HeldMilestoneActions } from "@/components/HeldMilestoneActions";
import { MilestoneEscrow } from "@/components/MilestoneEscrow";
import { AutoRefresh } from "@/components/AutoRefresh";
import MilestoneIntake from "@/components/intake/MilestoneIntake";
import PayFreelancerForm from "@/components/intake/PayFreelancerForm";
import MilestoneVerification from "@/components/MilestoneVerification";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { DecisionRows, RowGroupHeading, type DecisionRowItem } from "@/components/vx/DecisionRows";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { Money } from "@/components/vx/Primitives";
import { StatTile } from "@/components/vx/StatTile";
import { milestoneDecision } from "@/components/vx/map";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { decisionEntryOf, heldMilestonesTwoApprovals, heldReason, milestoneIntents } from "@/lib/agent/milestone-decisions";
import { isSoleApprover } from "@/lib/agent/sole-approver";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { chainModes } from "@/lib/circle";
import { readEscrowContract } from "@/lib/circle/escrow-setup";
import { addressUnconfirmed, payeeNotReady } from "@/lib/counterparty-address";
import { inOrg } from "@/lib/dal/scope";
import { listLedgerEntries, listLedgerEntriesForTargets } from "@/lib/ledger";
import { orgHref } from "@/lib/auth/org-paths";
import { utcDay } from "@/lib/copy";
import { listMembers } from "@/lib/platform/members";
import { listCounterparties, listMilestones, stats, type MilestoneRow } from "@/lib/queries";
import { workspaceNetwork } from "@/lib/workspace-network";
import { paidAcrossChains } from "@/lib/payee-chains";
import { networkProfile } from "@/lib/network";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("contractors") };

/** Paid milestones shown before "Show all". */
const PAID_SHOWN = 10;

export default async function ContractorsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ history?: string | string[] }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const network = workspaceNetwork().id;
    const showAllPaid = (await searchParams).history === "all";
    const live = access.membership.mode === "live";
    const [milestones, counterparties, headEntries, dashboardStats, canWrite, canManageTreasury, canDecide, escrow] = await Promise.all([
      listMilestones(),
      listCounterparties(),
      listLedgerEntries(1),
      stats(),
      viewerCan(slug, "records.write"),
      viewerCan(slug, "treasury.manage"),
      viewerCan(slug, "approval.decide"),
      // A live workspace's escrow (milestone escrow E2), on a network that has it (mainnet copy C3). Best effort: a read
      // that fails shows no panel.
      live && networkProfile(network).escrow
        ? readEscrowContract().catch((error: unknown) => {
            console.error("contractors: escrow not loaded", error instanceof Error ? error.message : error);
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    const held = milestones.filter((milestone) => milestone.status === "held");
    const [entries, intents, soleApprover] = await Promise.all([
      listLedgerEntriesForTargets({ milestoneIds: milestones.map((milestone) => milestone.id) }),
      milestoneIntents(held.map((milestone) => milestone.id)),
      // Whether this person may override a hold on a milestone they added themselves (sole approver R5).
      canDecide && held.some((milestone) => milestone.created_by === access.user.id) ? isSoleApprover(access.user.id) : Promise.resolve(false),
    ]);
    const contractorsById = new Map(counterparties.map((counterparty) => [counterparty.id, counterparty]));
    // Held milestones above the figure for two approvals: who approved each so far, and whether whoever added it may give
    // one (two approvals T8); the approvers' emails are read only when someone has approved.
    const twoApprovals = await heldMilestonesTwoApprovals(held, contractorsById, intents);
    const approverIds = new Set([...twoApprovals.values()].flatMap((facts) => facts.approvals.map((approval) => approval.by)));
    const memberEmails: Record<string, string> =
      approverIds.size > 0
        ? Object.fromEntries(
            (await listMembers(access.membership.orgId)).filter((member) => approverIds.has(member.userId)).map((member) => [member.userId, member.email])
          )
        : {};
    // What a verified milestone waits for before the agent pays it: an address to confirm, or one to add.
    const waitingOf = (milestone: MilestoneRow) => {
      const contractor = contractorsById.get(milestone.contractor_id);
      return milestone.status === "verified" && contractor ? payeeNotReady(contractor, live) : null;
    };
    const decisions = milestones.map((milestone) =>
      milestoneDecision(milestone, entries, { network, riskLevel: contractorsById.get(milestone.contractor_id)?.risk_level ?? null, waiting: waitingOf(milestone) })
    );
    const milestonesById = new Map(milestones.map((milestone) => [milestone.id, milestone]));
    // Made here, not in the browser, so the server's markup and the browser's agree (as the Gateway form's id is).
    const defaultRefundDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const minRefundDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const maxRefundDate = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    // Clients pay the business; contractors are listed first, then vendors.
    const payees = counterparties
      .filter((counterparty) => counterparty.role !== "client")
      .sort((a, b) => Number(b.role === "contractor") - Number(a.role === "contractor"))
      .map(({ id, name, role }) => ({ id, name, role }));

    // Under a milestone's card once its row is opened: its verification, and its escrow hold.
    const controls = (milestone: MilestoneRow) => (
      <>
        {/* A paid or closed milestone is never verified again (the action refuses it), so it has no controls. */}
        {canWrite && milestone.status !== "paid" && milestone.status !== "closed" && <MilestoneVerification orgSlug={slug} milestoneId={milestone.id} verified={milestone.verified} />}
        {live && (
          <MilestoneEscrow
            network={network}
            orgSlug={slug}
            milestoneId={milestone.id}
            requestId={crypto.randomUUID()}
            defaultRefundDate={defaultRefundDate}
            minRefundDate={minRefundDate}
            maxRefundDate={maxRefundDate}
            payee={contractorsById.get(milestone.contractor_id)?.address ?? null}
            amount={milestone.amount}
            lockable={(() => {
              const contractor = contractorsById.get(milestone.contractor_id);
              return (
                milestone.status === "pending" &&
                Boolean(contractor?.address) &&
                !paidAcrossChains(contractor?.chain) &&
                !addressUnconfirmed(contractor?.address_changed_at ?? null, contractor?.address_confirmed_at ?? null)
              );
            })()}
            escrowReady={Boolean(escrow?.address)}
            canManage={canManageTreasury}
            paid={milestone.status === "paid"}
            refundable={Boolean(milestone.escrow_refund_after) && Date.parse(milestone.escrow_refund_after ?? "") <= Date.now()}
            hold={
              milestone.escrow_state && milestone.escrow_state !== "funding"
                ? {
                    state: milestone.escrow_state as "funded" | "released" | "refunded",
                    payee: milestone.escrow_payee ?? null,
                    refundAfter: milestone.escrow_refund_after ?? "",
                    amount: Number(milestone.escrow_amount ?? milestone.amount),
                    fundTxHash: milestone.escrow_fund_tx_hash ?? null,
                    releaseTxHash: milestone.escrow_release_tx_hash ?? null,
                    refundTxHash: milestone.escrow_refund_tx_hash ?? null,
                  }
                : null
            }
          />
        )}
      </>
    );
    // What a held milestone waits for, and a person's decisions on it (held milestone actions R1–R3).
    const waitingFor = (milestone: MilestoneRow) => {
      const contractor = contractorsById.get(milestone.contractor_id);
      const last = decisionEntryOf(entries.filter((entry) => entry.detail.milestoneId === milestone.id));
      return heldReason({
        amount: milestone.amount,
        agentReasoning: milestone.agent_reasoning,
        contractor: {
          name: milestone.contractor_name,
          riskLevel: contractor?.risk_level ?? "unscreened",
          riskNotes: contractor?.risk_notes ?? null,
          paymentLimit: contractor?.payment_limit ?? null,
          baselinePaymentLimit: contractor?.baseline_payment_limit ?? null,
          address: contractor?.address ?? null,
          addressChangedAt: contractor?.address_changed_at ?? null,
          addressConfirmedAt: contractor?.address_confirmed_at ?? null,
        },
        intent: intents.get(milestone.id) ?? null,
        lastEntry: last ? { action: last.action, detail: last.detail } : null,
        live,
      });
    };
    const row = (decision: (typeof decisions)[number]): DecisionRowItem => {
      const milestone = milestonesById.get(decision.id) as MilestoneRow;
      const item: DecisionRowItem = { decision, date: milestoneDate(milestone, decision.at), after: controls(milestone) };
      const waiting = waitingOf(milestone);
      if (waiting === "no_address") return { ...item, hint: "Waiting for an address" };
      if (waiting === "unconfirmed") {
        return {
          ...item,
          hint: "Address to confirm",
          before: (
            <Callout tone="held" title="What it waits for">
              <p>
                {milestone.contractor_name}&apos;s address changed and no one has confirmed it yet. Confirm it on Counterparties, and the agent decides on pay within a minute.{" "}
                <Button asChild variant="link">
                  <Link href={orgHref(slug, "/counterparties")}>Open Counterparties</Link>
                </Button>
              </p>
            </Callout>
          ),
        };
      }
      if (milestone.status !== "held") return item;
      const reason = waitingFor(milestone);
      return {
        ...item,
        hint: reason.hint,
        before: (
          <HeldMilestoneActions
            orgSlug={slug}
            milestone={{ id: milestone.id, title: milestone.title, amount: milestone.amount, contractorName: milestone.contractor_name }}
            reason={reason}
            canDecide={canDecide}
            selfAdded={Boolean(milestone.created_by) && milestone.created_by === access.user.id}
            soleApprover={soleApprover}
            sandbox={!live}
            twoApprovals={twoApprovals.get(milestone.id)}
            viewerId={access.user.id}
            memberEmails={memberEmails}
          />
        ),
      };
    };
    // The work, not the record (Contractors layout): what waits for a person, what is under way, what is done.
    const statusOf = (decision: (typeof decisions)[number]) => milestonesById.get(decision.id)?.status ?? "";
    const done = (decision: (typeof decisions)[number]) => ["paid", "closed"].includes(statusOf(decision));
    // An address to confirm waits on a person too: the agent pays nothing to an address no one has confirmed.
    const confirming = (decision: (typeof decisions)[number]) => {
      const milestone = milestonesById.get(decision.id);
      return milestone !== undefined && waitingOf(milestone) === "unconfirmed";
    };
    const needsYou = decisions.filter((decision) => statusOf(decision) === "held" || confirming(decision) || (decision.outcome === "refused" && !done(decision)));
    const inProgress = decisions.filter((decision) => decision.outcome !== "refused" && !confirming(decision) && ["pending", "verified"].includes(statusOf(decision)));
    const paid = decisions.filter(done).sort((a, b) => b.at.localeCompare(a.at));
    const paidCount = milestones.filter((milestone) => milestone.status === "paid").length;
    const awaiting = milestones.filter((milestone) => milestone.status === "pending");
    const paidTotal = milestones.filter((milestone) => milestone.status === "paid").reduce((sum, milestone) => sum + Number(milestone.amount), 0);

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={chainModes()}>
        <PageHead
          title={sectionTitle("contractors")}
          sub="Milestone pay follows verified work instead of a Net-30 calendar. Every release still passes risk and authority guardrails."
          right={<AgentControls orgSlug={slug} nextDay={dashboardStats.day + 1} headSeq={headEntries[0]?.seq ?? 0} clockMode={dashboardStats.clockMode} />}
        />
        {/* The agent decides within a minute of a milestone being verified: the page re-reads its
            data every 20 s, and at once on return to the tab, so the release appears without a reload. */}
        <AutoRefresh intervalMs={20_000} />

        <div className="mb-6 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Needs you" tone={needsYou.length > 0 ? "held" : "default"} sub={needsYou.length > 0 ? "Held, or an address to confirm" : "Nothing held"}>
            <span className="tabular-nums">{needsYou.length}</span>
          </StatTile>
          <StatTile label="Awaiting verification" sub={<Money value={awaiting.reduce((sum, milestone) => sum + Number(milestone.amount), 0)} />}>
            <span className="tabular-nums">{awaiting.length}</span>
          </StatTile>
          <StatTile label="Verified, being paid" sub="The agent decides within a minute">
            <span className="tabular-nums">{milestones.filter((milestone) => milestone.status === "verified").length}</span>
          </StatTile>
          <StatTile label="Paid" sub={`${paidCount} ${paidCount === 1 ? "milestone" : "milestones"}`}>
            <Money value={paidTotal} />
          </StatTile>
        </div>

        {canWrite ? (
          // Folded until it is needed; open on a workspace with no milestone yet, where adding one is the next step.
          <IntakeFold label="New payment" meta="pay a freelancer in one step, or add a milestone for a contractor on file" defaultOpen={milestones.length === 0}>
            <Tabs defaultValue="freelancer">
              <TabsList aria-label="New payment">
                <TabsTrigger value="freelancer">
                  <UserPlus aria-hidden />
                  Pay a freelancer
                </TabsTrigger>
                <TabsTrigger value="milestone">
                  <ListChecks aria-hidden />
                  Milestone intake
                </TabsTrigger>
              </TabsList>
              {/* Both stay mounted, so switching tabs never loses what was typed. */}
              <TabsContent value="freelancer" forceMount className="data-[state=inactive]:hidden">
                <p className="mb-4 text-[0.8125rem] text-ink-3">One form: they get a link, you confirm their address, the agent pays.</p>
                <PayFreelancerForm orgSlug={slug} live={live} />
              </TabsContent>
              <TabsContent value="milestone" forceMount className="data-[state=inactive]:hidden">
                <p className="mb-4 text-[0.8125rem] text-ink-3">Work a contractor on file is paid for once it is verified.</p>
                <MilestoneIntake orgSlug={slug} contractors={payees} />
              </TabsContent>
            </Tabs>
          </IntakeFold>
        ) : (
          <Callout className="mb-8">Only an owner or admin of this workspace can add milestones.</Callout>
        )}

        {live && escrow !== undefined && (
          // Set up once, then rarely looked at: folded, and open while it has not been set up.
          <Disclosure
            className="mb-8"
            defaultOpen={!escrow?.address}
            summary={
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-ink">Milestone escrow</span>
                <span className="text-[0.8125rem] font-normal text-ink-3">{escrow?.address ? "a contract on Arc testnet · lock a milestone from its row" : "a contract on Arc testnet · not set up yet"}</span>
              </span>
            }
          >
            <EscrowPanel network={network} orgSlug={slug} address={escrow?.address ?? null} deploying={Boolean(escrow && !escrow.address)} canSetUp={canManageTreasury} bare />
          </Disclosure>
        )}

        {decisions.length === 0 ? (
          <EmptyState
            titleAs="h2"
            icon={<Flag />}
            title="No milestones yet"
            body="Milestones appear here once they are added. Pay is released when the work is verified."
          />
        ) : (
          <section>
            <SectionHeader title="Milestones" meta={`${decisions.length} · open one for the agent's reasoning, its verification and its escrow`} />
            {needsYou.length > 0 && (
              <>
                <RowGroupHeading title="Needs you" count={needsYou.length} />
                <DecisionRows orgSlug={slug} items={needsYou.map(row)} />
              </>
            )}
            {inProgress.length > 0 && (
              <>
                <RowGroupHeading title="In progress" count={inProgress.length} />
                <DecisionRows orgSlug={slug} items={inProgress.map(row)} />
              </>
            )}
            {paid.length > 0 && (
              <>
                <RowGroupHeading
                  title="Paid and closed"
                  count={paid.length}
                  action={
                    paid.length > PAID_SHOWN ? (
                      <Button asChild variant="link" className="text-[0.8125rem]">
                        <Link href={orgHref(slug, showAllPaid ? "/contractors" : "/contractors?history=all")} scroll={false}>
                          {showAllPaid ? `Show the latest ${PAID_SHOWN}` : `Show all ${paid.length}`}
                        </Link>
                      </Button>
                    ) : undefined
                  }
                />
                <DecisionRows orgSlug={slug} items={(showAllPaid ? paid : paid.slice(0, PAID_SHOWN)).map(row)} />
              </>
            )}
          </section>
        )}
      </ProductShell>
    );
  });
}

/** The date a milestone's row leads with: when it was paid, closed or held, when it was verified, or that it waits for verification. */
function milestoneDate(milestone: MilestoneRow | undefined, decidedAt: string): DecisionRowItem["date"] {
  if (!milestone) return null;
  const day = (at: string) => utcDay(at);
  if (milestone.status === "paid") return { label: `Paid ${day(decidedAt)}` };
  if (milestone.status === "closed") return { label: `Closed ${day(milestone.closed_at ?? decidedAt)}` };
  if (milestone.status === "held") return { label: `Held ${day(decidedAt)}`, tone: "held" };
  if (milestone.status === "verified") return { label: milestone.verified_at ? `Verified ${day(milestone.verified_at)}` : "Verified" };
  return { label: "Awaiting verification" };
}
