import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ApprovalCard from "@/components/ApprovalCard";
import { AddToProjectForm, NewProjectForm } from "@/components/projects/ProjectForms";
import { EarmarkNote, ProjectCash, ProjectDealsList, ProjectFigureTiles, ProjectPlan, ProjectsList, ProjectsTreasuryCard, ProjectWorkList } from "@/components/projects/ProjectViews";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { invoiceDecision } from "@/components/vx/map";
import { sectionTitle } from "@/components/vx/nav";
import { PageHead } from "@/components/vx/Shell";
import { exceptionFacts } from "@/lib/exceptions";
import { DESIGN_SLUG } from "../../../design/fixtures";
import {
  BRIGHTLINE,
  HELD_VIDEO,
  HELD_VIDEO_ENTRY,
  HELD_VIDEO_WAITING,
  LINA,
  PROJECTS,
  PROJECTS_CASH,
  PROJECTS_TODAY,
  SAME_WORK_BILL,
  SAME_WORK_ENTRY,
  SAME_WORK_WAITING,
  SET_ASIDE_ALL,
  WEBSITE,
  WEBSITE_DEALS,
  WEBSITE_DUE_14_DAYS,
  WEBSITE_PLAN,
  WEBSITE_WORK,
} from "../../projects-fixture";

/**
 * Projects with sample data, for the partner's review of docs/superpowers/specs/2026-10-13-project-budgets-design.md
 * (`docs/superpowers/specs/project-budgets-shots/`): the projects list, a project's page, a bill held for its project's
 * budget in Approvals and on its card, and a bill held as the same work as a milestone. Every figure is worked out by the
 * pages' own functions from the fixture. Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per
 * request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Project budget states", robots: { index: false, follow: false } };

const STATES = ["list", "project", "held-bill", "same-work"] as const;
type State = (typeof STATES)[number];

const projectHref = (projectId: string) => `/docs-shots/projects/project?id=${projectId}`;
const MEMBERS = [
  { userId: "docs-sample-owner", email: "olivia@northstar.example", role: "owner" as const },
  { userId: "docs-sample-admin", email: "adam@northstar.example", role: "admin" as const },
];

function ListShot() {
  return (
    <>
      <PageHead
        title={sectionTitle("projects")}
        sub="Give each job, client or launch its own budget. The agent sets each bill's money aside in its project before paying it, and holds what the budget cannot cover for a person."
      />
      <IntakeFold label="New project" meta="a budget, and a buffer kept back from it">
        <NewProjectForm orgSlug={DESIGN_SLUG} idempotencyKey="docs-sample-project-key" />
      </IntakeFold>
      <div className="mb-6">
        <EarmarkNote />
      </div>
      <ProjectsList projects={PROJECTS} hrefOf={projectHref} />
      <div className="mt-10">
        <ProjectsTreasuryCard projects={PROJECTS} allHref="/docs-shots/projects/list" hrefOf={projectHref} />
      </div>
    </>
  );
}

function ProjectShot() {
  return (
    <>
      <PageHead title={WEBSITE.project.name} sub="A budget in USDC: the agent sets each bill's money aside here before paying it." />
      <div className="space-y-8">
        <ProjectFigureTiles summary={WEBSITE} />
        <EarmarkNote />
        <section>
          <SectionHeader title="Bills and milestones" meta={`${WEBSITE_WORK.length} in this project`} />
          <ProjectWorkList work={WEBSITE_WORK} hrefOf={() => "#"} />
        </section>
        <section>
          <SectionHeader title="Next 14 days" meta="This project's lines of the payment plan" />
          <ProjectPlan lines={WEBSITE_PLAN} through="2026-10-26" planHref="#" />
        </section>
        <ProjectCash cash={PROJECTS_CASH} setAsideAllMinor={SET_ASIDE_ALL} summary={WEBSITE} dueIn14DaysMinor={WEBSITE_DUE_14_DAYS} />
        <section>
          <SectionHeader title="Deals" meta="What they collected counts as this project's revenue" />
          <ProjectDealsList deals={WEBSITE_DEALS} hrefOf={() => "#"} />
        </section>
        <section>
          <SectionHeader title="Add to this project" meta="Open bills in USDC, milestones and deals in no project" />
          <AddToProjectForm
            orgSlug={DESIGN_SLUG}
            projectId={WEBSITE.project.id}
            candidates={[
              { kind: "bill", id: "00000000-0000-4000-8000-000000009501", label: "Atlas Couriers: AC-311 · Launch deliveries, 420 USDC" },
              { kind: "milestone", id: "00000000-0000-4000-8000-000000009502", label: "Lina Park: Launch QA, 900 USDC" },
            ]}
          />
        </section>
      </div>
    </>
  );
}

function HeldShot({ which }: { which: "held-bill" | "same-work" }) {
  const budget = which === "held-bill";
  const waiting = budget ? HELD_VIDEO_WAITING : SAME_WORK_WAITING;
  const row = budget ? HELD_VIDEO : SAME_WORK_BILL;
  const party = budget ? BRIGHTLINE : LINA;
  const decision = invoiceDecision(row, party, [budget ? HELD_VIDEO_ENTRY : SAME_WORK_ENTRY], { network: "arc-testnet", asOf: Date.parse(`${PROJECTS_TODAY}T09:00:00Z`) });
  const exception = exceptionFacts({ dueDate: waiting.dueDate.slice(0, 10), discount: null, createdBy: waiting.createdBy }, MEMBERS, PROJECTS_TODAY);
  return (
    <>
      <PageHead title={sectionTitle("approvals")} sub="Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle." />
      <ApprovalCard orgSlug={DESIGN_SLUG} payable={waiting} canDecide canEdit viewerId="docs-sample-owner" sandbox={false} exception={exception} viewerEmail="olivia@northstar.example" />
      <section className="mt-10">
        <SectionHeader title="The same bill's card on Bills & receivables" meta="the rule named, with its figures" />
        <DecisionCard decision={decision} orgSlug={DESIGN_SLUG} />
      </section>
    </>
  );
}

type Props = { params: Promise<{ state: string }> };

export default async function ProjectsStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;
  return (
    <MotionProvider>
      <main id="main" data-projects-state={shown} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>
          {shown === "list" ? <ListShot /> : shown === "project" ? <ProjectShot /> : <HeldShot which={shown} />}
        </div>
      </main>
    </MotionProvider>
  );
}
