import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { DocsLink } from "@/components/DocsLink";
import { NewProjectForm } from "@/components/projects/ProjectForms";
import { EarmarkNote, ProjectsList } from "@/components/projects/ProjectViews";
import { Callout } from "@/components/ui/Callout";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { sectionTitle } from "@/components/vx/nav";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { orgHref } from "@/lib/auth/org-paths";
import { shellModes } from "@/lib/circle";
import { inOrg } from "@/lib/dal/scope";
import { readProjects, type ProjectsRead } from "@/lib/projects/read";
import { stats } from "@/lib/queries";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: sectionTitle("projects") };

/**
 * Projects (docs/superpowers/specs/2026-10-13-project-budgets-design.md P7): every project with its budget, what is set
 * aside, paid and still available, the share of its open bills covered, and the payments held for its budget. An owner
 * or admin makes one here. Before migration 0111 runs, the page says projects are not set up.
 */
export default async function ProjectsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const [read, dashboardStats, canManage] = await Promise.all([
      readProjects().catch((error: unknown): ProjectsRead | null => {
        console.error("projects: not read", error instanceof Error ? error.message : error);
        return null;
      }),
      stats(),
      viewerCan(slug, "agent.budget"),
    ]);
    const projects = read?.available ? read.projects : [];
    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title={sectionTitle("projects")}
          sub="Give each job, client or launch its own budget. The agent sets each bill's money aside in its project before paying it, and holds what the budget cannot cover for a person."
          right={<DocsLink href="/docs/guides/projects" topic="projects" />}
        />
        {read === null ? (
          <Callout tone="held" className="mb-6">Projects could not be read just now. Reload the page in a moment.</Callout>
        ) : !read.available ? (
          <Callout className="mb-6">Projects are not set up on this deployment yet.</Callout>
        ) : (
          <>
            {canManage ? (
              <IntakeFold label="New project" meta="a budget, and a buffer kept back from it" defaultOpen={projects.length === 0}>
                <NewProjectForm orgSlug={slug} idempotencyKey={randomUUID()} />
              </IntakeFold>
            ) : (
              <Callout className="mb-8">Only an owner or admin of this workspace can make a project or change its budget.</Callout>
            )}
            <div className="mb-6">
              <EarmarkNote />
            </div>
            <section aria-labelledby="projects-title">
              <h2 id="projects-title" className="sr-only">
                Every project
              </h2>
              <ProjectsList projects={projects} hrefOf={(projectId) => orgHref(slug, `/projects/${projectId}`)} />
            </section>
          </>
        )}
      </ProductShell>
    );
  });
}
