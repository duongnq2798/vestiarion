import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { confirmLimitsAction, dismissChecklistAction } from "@/app/actions/onboarding";
import { AccountantConsole } from "@/components/accountant/AccountantConsole";
import { AgentBudgetPanel } from "@/components/AgentBudgetPanel";
import ApprovalCard from "@/components/ApprovalCard";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { AccountMenu } from "@/components/vx/AccountMenu";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { EvidenceStepCard, evidenceSub } from "@/components/vx/EvidenceChain";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { sectionTitle } from "@/components/vx/nav";
import { PageHead } from "@/components/vx/Shell";
import { SiteFooter, SiteHeader, SiteHeaderLink } from "@/components/vx/SiteChrome";
import { triageFilter } from "@/lib/accountant/triage";
import { evidenceLinkLabel } from "@/lib/evidence-paths";
import { exceptionFacts } from "@/lib/exceptions";
import { accountantChecklist } from "@/lib/onboarding/role-checklists";
import { ACCOUNTANT_EMAIL, ACCOUNTANT_NOW, ACCOUNTANT_PORTFOLIO } from "../../accountant-fixture";
import { APPROVER_CHECKLIST, contractorCards, ONBOARDING_SLUG, OWNER_CHECKLIST, OWNER_LIMITS, privateMilestoneChain } from "../../onboarding-fixture";
import { HELD_VIDEO_WAITING, PROJECTS_TODAY } from "../../projects-fixture";

/**
 * Onboarding by role and evidence access with sample data, for the partner's review of
 * docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md (`role-onboarding-shots/`): the owner's,
 * the approver's and the accountant's checklists where each lands, and an evidence link that can't be opened. Built by
 * the pages' own components; a form sent from here reaches no workspace, as no slug here is one. Like /docs-shots, it
 * answers only where `DOCS_SCREENSHOTS=1` is set, read per request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Onboarding by role states", robots: { index: false, follow: false } };

const STATES = ["owner", "approver", "accountant", "evidence"] as const;
type State = (typeof STATES)[number];

function OwnerShot() {
  return (
    <>
      <PageHead title={sectionTitle("treasury")} sub="What the agent holds, what it decided, and why." />
      <GettingStarted slug={ONBOARDING_SLUG} checklist={OWNER_CHECKLIST} isOwner dismiss={dismissChecklistAction} confirmLimits={confirmLimitsAction} />
      <div className="max-w-md">
        <AgentBudgetPanel walletTreasury={false} network="arc-testnet" orgSlug={ONBOARDING_SLUG} canEdit live={false} onChain={null} view={OWNER_LIMITS} />
      </div>
    </>
  );
}

function ApproverShot() {
  const exception = exceptionFacts(
    { dueDate: HELD_VIDEO_WAITING.dueDate.slice(0, 10), discount: null, createdBy: HELD_VIDEO_WAITING.createdBy },
    [
      { userId: "docs-sample-owner", email: "olivia@northstar.example", role: "owner" },
      { userId: "docs-sample-approver", email: "sam@northstar.example", role: "approver" },
    ],
    PROJECTS_TODAY
  );
  return (
    <>
      <PageHead title={sectionTitle("approvals")} sub="Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle." />
      <GettingStarted slug={ONBOARDING_SLUG} checklist={APPROVER_CHECKLIST} isOwner={false} dismiss={dismissChecklistAction} />
      <ApprovalCard orgSlug={ONBOARDING_SLUG} payable={HELD_VIDEO_WAITING} canDecide canEdit={false} viewerId="docs-sample-approver" sandbox={false} exception={exception} viewerEmail="sam@northstar.example" />
    </>
  );
}

function AccountantShot() {
  const checklist = accountantChecklist({
    consoleOpened: true,
    queueOpened: false,
    booked: false,
    applied: false,
    handedOff: false,
    workspaceSlug: "harbor-bakery",
    bookHref: "/invoices?review=book-xero",
    dismissed: false,
  });
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader width="wide">
        <SiteHeaderLink href="/onboarding?new">Workspaces</SiteHeaderLink>
        <SiteHeaderLink href="/docs">Docs</SiteHeaderLink>
        <AccountMenu email={ACCOUNTANT_EMAIL} placement="header" />
      </SiteHeader>
      <main id="main" className="mx-auto w-full max-w-[88rem] flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-8 max-w-2xl space-y-2">
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em] text-ink">Accountant console</h1>
          <p className="text-[0.9375rem] leading-relaxed text-ink-2">
            Every workspace you are a member of, and what needs attention in each: payments waiting for a decision, payments to book, receivables to follow
            up and connectors to fix. Amounts stay with their own workspace and currency; nothing here is added up.
          </p>
        </div>
        <GettingStarted slug="harbor-bakery" checklist={checklist} isOwner={false} dismiss={dismissChecklistAction} />
        <AccountantConsole portfolio={ACCOUNTANT_PORTFOLIO} now={ACCOUNTANT_NOW} filter={triageFilter({})} />
      </main>
      <SiteFooter compact />
    </div>
  );
}

function EvidenceShot() {
  const chain = privateMilestoneChain();
  const shown = chain.steps.filter((step) => step.id === "agreed" || step.id === "delivered");
  return (
    <>
      <PageHead title={evidenceLinkLabel(chain.subject.paid)} sub={evidenceSub(chain.subject)} />
      <ol className="space-y-4">
        {shown.map((step) => (
          <li key={step.id}>
            <EvidenceStepCard step={step} number={chain.steps.indexOf(step) + 1} chain={chain} orgSlug={ONBOARDING_SLUG} publicKeys={{}} />
          </li>
        ))}
      </ol>
      <section className="mt-10">
        <SectionHeader title="The same links on Contractors" meta="checked before the card offers them" />
        <div className="space-y-4">
          {contractorCards().map((decision) => (
            <DecisionCard key={decision.id} decision={decision} orgSlug={ONBOARDING_SLUG} />
          ))}
        </div>
      </section>
    </>
  );
}

export default async function OnboardingStatePage({ params }: { params: Promise<{ state: string }> }) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;
  if (shown === "accountant") {
    return (
      <div data-onboarding-state={shown}>
        <AccountantShot />
      </div>
    );
  }
  return (
    <MotionProvider>
      <main id="main" data-onboarding-state={shown} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>{shown === "owner" ? <OwnerShot /> : shown === "approver" ? <ApproverShot /> : <EvidenceShot />}</div>
      </main>
    </MotionProvider>
  );
}
