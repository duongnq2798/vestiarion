import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ApprovalCard from "@/components/ApprovalCard";
import { BillRows } from "@/components/bills/BillsList";
import type { BillRowItem } from "@/components/bills/types";
import { DealCashReadiness } from "@/components/deals/DealCashReadiness";
import { DealCosts } from "@/components/deals/DealCosts";
import { DealFigures } from "@/components/deals/DealFigures";
import { DealHeadSub } from "@/components/deals/DealHead";
import { DealSchedule } from "@/components/deals/DealSchedule";
import { DealsSection } from "@/components/deals/DealsSection";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { PageHead } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import type { DealCost } from "@/lib/deals/costs";
import type { DealRecord } from "@/lib/deals/read";
import { exceptionFacts } from "@/lib/exceptions";
import { DESIGN_SLUG } from "../../../design/fixtures";
import {
  COVERED_COSTS,
  COVERED_DEAL,
  DEAL_CASH_COSTS,
  DEAL_CASH_MEMBERS,
  DEAL_CASH_TODAY,
  dealCashCollected,
  HELD_BILLS,
  LINK_CANDIDATES,
  NO_COSTS_DEAL,
  PAYEES,
  SHORT_COSTS,
  SHORT_DEAL,
} from "../../deal-cash-fixture";

/**
 * A deal's cash readiness and held bills with an owner, with sample data, for the partner's review of
 * docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md (`docs/superpowers/specs/deal-cash-shots/`): a deal
 * short before its deposit arrives, one with no gap, one with no cost entered, the first with a try of an earlier
 * deposit, the deals list with its badges, and Approvals with each bill's priority, day and owners. Every figure is
 * worked out by the page's own functions. Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per
 * request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Deal cash readiness states", robots: { index: false, follow: false } };

const STATES = ["short", "covered", "no-costs", "try", "list", "approvals"] as const;
type State = (typeof STATES)[number];

const DEALS: Record<"short" | "covered" | "no-costs" | "try", { deal: DealRecord; costs: DealCost[] }> = {
  short: { deal: SHORT_DEAL, costs: SHORT_COSTS },
  covered: { deal: COVERED_DEAL, costs: COVERED_COSTS },
  "no-costs": { deal: NO_COSTS_DEAL, costs: [] },
  try: { deal: SHORT_DEAL, costs: SHORT_COSTS },
};

function DealShot({ state }: { state: keyof typeof DEALS }) {
  const { deal, costs } = DEALS[state];
  const today = DEAL_CASH_TODAY;
  const collected = dealCashCollected(deal);
  return (
    <>
      <PageHead title={deal.title} sub={<DealHeadSub deal={deal} today={today} />} />
      <DealFigures deal={deal} today={today} collected={collected} />
      <div className="space-y-8">
        <DealCashReadiness facts={deal.facts} digits={deal.digits} template={deal.template} costs={costs} collected={collected.byReceivable} today={today} changeHref="#change" {...(state === "try" ? { initialTry: { depositOn: "2026-10-05" } } : {})} />
        <DealSchedule orgSlug={DESIGN_SLUG} deal={deal} today={today} canWrite />
        <DealCosts
          orgSlug={DESIGN_SLUG}
          dealId={deal.facts.id}
          costs={costs}
          today={today}
          digits={deal.digits}
          currency={deal.facts.currency}
          canWrite
          candidates={LINK_CANDIDATES}
          payees={PAYEES}
          idempotencyKey="deal-cash-shot"
        />
      </div>
    </>
  );
}

function ApprovalsShot() {
  const today = DEAL_CASH_TODAY;
  const viewer = DEAL_CASH_MEMBERS[0];
  const facts = (bill: (typeof HELD_BILLS)[number]) => exceptionFacts({ dueDate: bill.dueDate, discount: bill.discount, createdBy: bill.createdBy }, DEAL_CASH_MEMBERS, today);
  const rows: BillRowItem[] = HELD_BILLS.map((bill) => ({
    id: bill.id,
    name: bill.counterpartyName,
    reference: bill.poReference ?? "No purchase order",
    amount: bill.amount,
    token: bill.currency,
    struck: false,
    date: bill.dueDate < today ? { label: `Overdue Oct ${Number(bill.dueDate.slice(8, 10))}, 2026`, tone: "held" } : { label: `Due Oct ${Number(bill.dueDate.slice(8, 10))}, 2026` },
    outcome: "held",
    outcomeLabel: bill.status === "awaiting_info" ? "Waiting for details" : "Held for you",
    blockers: bill.status === "awaiting_info" ? ["No purchase order", "Not received"] : [],
    why: bill.status === "awaiting_info" ? null : bill.explanation,
    next: { text: bill.status === "awaiting_info" ? "Add the purchase order" : "Decide in Approvals", tone: "held", href: "/approvals" },
    exception: facts(bill),
    href: "#",
  }));
  return (
    <>
      <PageHead title={sectionTitle("approvals")} sub="Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle." />
      <div className="space-y-4">
        {HELD_BILLS.map((bill) => (
          <ApprovalCard key={bill.id} orgSlug={DESIGN_SLUG} payable={bill} canDecide canEdit viewerId={viewer.userId} sandbox={false} exception={facts(bill)} viewerEmail={viewer.email} />
        ))}
        <ApprovalCard
          orgSlug={DESIGN_SLUG}
          payable={{ ...HELD_BILLS[0], id: "00000000-0000-4000-8000-0000000c5f09" }}
          canDecide={false}
          viewerId="docs-sample-viewer"
          sandbox={false}
          exception={facts(HELD_BILLS[0])}
          viewerEmail="vic@northstar.example"
        />
      </div>
      <section className="mt-10">
        <SectionHeader title="The same bills on Bills & receivables" meta="each row with its priority, its day and who can act" />
        <BillRows label="Bills" rows={rows} slugHref={(path) => `/docs-shots/deal-cash/approvals${path}`} />
      </section>
    </>
  );
}

type Props = { params: Promise<{ state: string }> };

export default async function DealCashStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;
  return (
    <MotionProvider>
      <main id="main" data-deal-cash-state={shown} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>
          {shown === "approvals" ? (
            <ApprovalsShot />
          ) : shown === "list" ? (
            <>
              <PageHead title={sectionTitle("invoices")} sub="Your bills, what the agent decided on each, and why." />
              <DealsSection
                deals={[SHORT_DEAL, COVERED_DEAL, NO_COSTS_DEAL]}
                costs={DEAL_CASH_COSTS}
                collected={new Map([SHORT_DEAL, COVERED_DEAL, NO_COSTS_DEAL].map((each) => [each.facts.id, dealCashCollected(each)]))}
                orgSlug={DESIGN_SLUG}
                today={DEAL_CASH_TODAY}
              />
            </>
          ) : (
            <DealShot state={shown} />
          )}
        </div>
      </main>
    </MotionProvider>
  );
}
