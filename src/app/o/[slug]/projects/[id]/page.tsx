import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DocsLink } from "@/components/DocsLink";
import { AddToProjectForm, ChangeProjectForm, ProjectStatusButton, RemoveFromProjectButton } from "@/components/projects/ProjectForms";
import { EarmarkNote, ProjectCash, ProjectDealsList, ProjectFigureTiles, ProjectPlan, ProjectWorkList } from "@/components/projects/ProjectViews";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { billsHref, invoiceHref } from "@/lib/bills-view";
import { shellModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { minorToDecimal } from "@/lib/deals/money";
import { evidencePath } from "@/lib/evidence-paths";
import type { PaymentPlan } from "@/lib/payment-plan";
import { readPaymentPlan } from "@/lib/payment-plan-read";
import { obligationMinor, PROJECT_DIGITS } from "@/lib/projects/model";
import { readProject, type ProjectRead } from "@/lib/projects/read";
import { stats } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Project" };

type ProjectPageProps = { params: Promise<{ slug: string; id: string }> };

/**
 * One project (docs/superpowers/specs/2026-10-13-project-budgets-design.md P7, P8): its budget, set aside, paid,
 * available and collected; its commitments covered and the payments held for its budget; its bills, milestones and
 * deals; its lines of the 14-day payment plan; and the treasury it shares with every other project. An owner or admin
 * changes its budget or archives it; whoever enters records puts a bill, a milestone or a deal in it. An id the
 * workspace does not hold is the workspace's not-found page.
 */
export default async function ProjectPage({ params }: ProjectPageProps) {
  const { slug, id } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const [read, dashboardStats, canManage, canWrite] = await Promise.all([
      readProject(id).catch((error: unknown): ProjectRead | null => {
        console.error("project: not read", error instanceof Error ? error.message : error);
        return null;
      }),
      stats(),
      viewerCan(slug, "agent.budget"),
      viewerCan(slug, "records.write"),
    ]);
    const shell = { network: access.membership.network, day: dashboardStats.day, clockMode: dashboardStats.clockMode, lastCycleAt: dashboardStats.lastCycleAt, chainModes: shellModes(), status: await shellStatus() };
    const back = (
      <Button asChild variant="link">
        <Link href={orgHref(slug, "/projects")}>
          <ArrowLeft aria-hidden />
          All projects
        </Link>
      </Button>
    );
    if (read === null || !read.available) {
      return (
        <ProductShell {...shell}>
          <PageHead title="Project" right={back} />
          <Callout tone={read === null ? "held" : "neutral"}>{read === null ? "This project could not be read just now. Reload the page in a moment." : "Projects are not set up on this deployment yet."}</Callout>
        </ProductShell>
      );
    }
    const detail = read.detail;
    if (!detail) notFound();
    const { summary, work, deals, candidates, setAsideAllMinor } = detail;
    const { project } = summary;
    const archived = project.status === "archived";

    // The plan of the whole treasury, with this project's lines (P8). Best effort: the page stands without it.
    const plan: PaymentPlan | null = await readPaymentPlan().catch((error: unknown) => {
      console.error("project: payment plan not read", error instanceof Error ? error.message : error);
      return null;
    });
    const members = new Set(work.map((item) => `${item.kind}:${item.id}`));
    const lines = plan ? plan.lines.filter((line) => members.has(`${line.kind}:${line.id}`)) : null;
    // What the plan has it pay in its window: lines planned or on their way, never one waiting for a person.
    const dueIn14DaysMinor = lines ? lines.filter((line) => line.inWindow && (line.state === "planned" || line.state === "on_its_way")).reduce((sum, line) => sum + obligationMinor(line.pays), 0) : null;
    const decimal = (minor: number) => minorToDecimal(minor, PROJECT_DIGITS);

    return (
      <ProductShell {...shell} crumb={project.name}>
        <PageHead
          title={project.name}
          sub={archived ? <Badge size="sm">Archived</Badge> : "A budget in USDC: the agent sets each bill's money aside here before paying it."}
          right={
            <div className="flex shrink-0 items-center gap-3">
              <DocsLink href="/docs/guides/projects" topic="projects" />
              {back}
            </div>
          }
        />
        <div className="space-y-8">
          <ProjectFigureTiles summary={summary} />
          <EarmarkNote />

          <section aria-labelledby="project-work">
            <SectionHeader id="project-work" title="Bills and milestones" meta={`${work.length} in this project`} />
            <ProjectWorkList
              work={work}
              hrefOf={(item) => orgHref(slug, item.kind === "bill" ? invoiceHref(item.id) : evidencePath("milestone", item.id))}
              action={
                canWrite && !archived
                  ? (item) => (item.state === "reserved" || item.state === "not_reserved" ? <RemoveFromProjectButton orgSlug={slug} kind={item.kind} id={item.id} label={item.label} /> : null)
                  : undefined
              }
            />
          </section>

          <section aria-labelledby="project-plan">
            <SectionHeader id="project-plan" title="Next 14 days" meta="This project's lines of the payment plan" />
            <ProjectPlan lines={lines} through={plan?.through ?? null} planHref={orgHref(slug, billsHref({ tab: "plan" }))} />
          </section>

          <section aria-labelledby="project-cash">
            <h2 id="project-cash" className="sr-only">
              Treasury for this project
            </h2>
            <ProjectCash cash={plan ? plan.cash : null} setAsideAllMinor={setAsideAllMinor} summary={summary} dueIn14DaysMinor={dueIn14DaysMinor} />
          </section>

          <section aria-labelledby="project-deals">
            <SectionHeader id="project-deals" title="Deals" meta="What they collected counts as this project's revenue" />
            <ProjectDealsList
              deals={deals}
              hrefOf={(dealId) => orgHref(slug, `/invoices/deals/${dealId}`)}
              action={canWrite && !archived ? (deal) => <RemoveFromProjectButton orgSlug={slug} kind="deal" id={deal.id} label={deal.title} /> : undefined}
            />
          </section>

          {canWrite && !archived && (
            <section aria-labelledby="project-add">
              <SectionHeader id="project-add" title="Add to this project" meta="Open bills in USDC, milestones and deals in no project" />
              <AddToProjectForm orgSlug={slug} projectId={project.id} candidates={candidates} />
            </section>
          )}

          {canManage && (
            <section aria-labelledby="project-change" className="space-y-4">
              <h2 id="project-change" className="sr-only">
                Change this project
              </h2>
              {!archived && (
                <IntakeFold label="Change budget" meta="what is set aside already stays" className="">
                  <ChangeProjectForm
                    orgSlug={slug}
                    projectId={project.id}
                    defaults={{ name: project.name, budget: decimal(project.budgetMinor), buffer: project.bufferMinor > 0 ? decimal(project.bufferMinor) : "" }}
                  />
                </IntakeFold>
              )}
              <ProjectStatusButton orgSlug={slug} projectId={project.id} archived={archived} />
            </section>
          )}
        </div>
      </ProductShell>
    );
  });
}
