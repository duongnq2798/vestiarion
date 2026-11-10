import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { sectionTitle } from "@/components/vx/nav";
import { PageHead } from "@/components/vx/Shell";
import { JIRA_STATES, JiraMilestoneState, JiraSettingsState, type JiraCardState } from "../../jira-states";

/**
 * Contractor work accepted from Jira, with sample data (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md
 * JR22), as Linear's /docs-shots/linear: the Jira card in Settings; a milestone's card before an issue is linked; ready
 * for acceptance; accepted; and held after the issue was reopened. Every view is built by the pages' own functions from
 * the fixture (../../jira-states.tsx, which the Jira guide's screenshots draw too). Like /docs-shots, it answers only
 * where `DOCS_SCREENSHOTS=1` is set, read per request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Jira acceptance states", robots: { index: false, follow: false } };

type Props = { params: Promise<{ state: string }> };

export default async function JiraStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(JIRA_STATES as readonly string[]).includes(state)) notFound();

  if (state === "settings") {
    return (
      <MotionProvider>
        <main id="main" data-jira-state={state} className="min-h-dvh bg-ground">
          <div className={cn(CONTENT_FRAME, "max-w-3xl pb-10 pt-6")}>
            <PageHead title={sectionTitle("settings")} sub="How this workspace connects to other tools." />
            <JiraSettingsState />
          </div>
        </main>
      </MotionProvider>
    );
  }

  return (
    <MotionProvider>
      <main id="main" data-jira-state={state} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "max-w-3xl pb-10 pt-6")}>
          <PageHead title={sectionTitle("contractors")} sub="Milestone pay follows verified work instead of a Net-30 calendar. Every release still passes risk and authority guardrails." />
          <JiraMilestoneState state={state as JiraCardState} />
        </div>
      </main>
    </MotionProvider>
  );
}
