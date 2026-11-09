import type { Metadata } from "next";
import { notFound } from "next/navigation";
import JiraPanel from "@/components/JiraPanel";
import { JiraIssueCard } from "@/components/JiraIssueCard";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { sectionTitle } from "@/components/vx/nav";
import { PageHead } from "@/components/vx/Shell";
import type { IssueLink } from "@/lib/jira/links";
import { jiraMilestoneView, jiraPanelView } from "@/lib/jira/views";
import { DESIGN_SLUG } from "../../../design/fixtures";
import { JIRA_CONNECTION, JIRA_EVENTS, JIRA_NOW, JIRA_PANEL_LINKS, JIRA_SITE, LINK_ACCEPTED, LINK_HELD, LINK_READY, MEMBER_EMAILS, RETRIES_CRITERIA } from "../../jira-fixture";

/**
 * Contractor work accepted from Jira, with sample data (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md
 * JR22), as Linear's /docs-shots/linear: the Jira card in Settings; a milestone's card before an issue is linked; ready
 * for acceptance; accepted; and held after the issue was reopened. Every view is built by the pages' own functions from
 * the fixture. Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per request: everywhere else, a
 * 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Jira acceptance states", robots: { index: false, follow: false } };

const STATES = ["settings", "link", "ready", "accepted", "held"] as const;
type State = (typeof STATES)[number];

type Props = { params: Promise<{ state: string }> };

/** The milestone's row, as Contractors heads its card: the work, the contractor, the amount and where it stands. */
function MilestoneHead({ title, status, tone }: { title: string; status: string; tone: "neutral" | "agent" | "proof" | "held" }) {
  return (
    <Card className="space-y-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <Badge size="sm" tone={tone} dot>
          {status}
        </Badge>
      </div>
      <p className="text-sm text-ink-2">Kestrel Labs · 1,200.00 USDC</p>
    </Card>
  );
}

const milestoneStatus: Record<Exclude<State, "settings">, { status: string; milestone: string; tone: "neutral" | "agent" | "proof" | "held"; link: IssueLink | null }> = {
  link: { status: "Awaiting verification", milestone: "pending", tone: "neutral", link: null },
  ready: { status: "Ready for acceptance", milestone: "pending", tone: "agent", link: LINK_READY },
  accepted: { status: "Verified", milestone: "verified", tone: "proof", link: LINK_ACCEPTED },
  held: { status: "Held for review", milestone: "pending", tone: "held", link: LINK_HELD },
};

export default async function JiraStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const slug = DESIGN_SLUG;

  if (state === "settings") {
    const view = jiraPanelView({ connection: JIRA_CONNECTION, site: JIRA_SITE, links: JIRA_PANEL_LINKS, openLinks: JIRA_PANEL_LINKS.length, events: JIRA_EVENTS, nowMs: JIRA_NOW });
    return (
      <MotionProvider>
        <main id="main" data-jira-state={state} className="min-h-dvh bg-ground">
          <div className={cn(CONTENT_FRAME, "max-w-3xl pb-10 pt-6")}>
            <PageHead title={sectionTitle("settings")} sub="How this workspace connects to other tools." />
            <JiraPanel orgSlug={slug} view={view} canManage notice={null} />
          </div>
        </main>
      </MotionProvider>
    );
  }

  const shown = milestoneStatus[state as Exclude<State, "settings">];
  const view = jiraMilestoneView({
    milestone: { id: "docs-milestone-retries", status: shown.milestone, acceptance_criteria: state === "link" ? null : RETRIES_CRITERIA },
    link: shown.link,
    connected: true,
    canWrite: true,
    links: null,
    memberEmails: MEMBER_EMAILS,
  });
  return (
    <MotionProvider>
      <main id="main" data-jira-state={state} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "max-w-3xl pb-10 pt-6")}>
          <PageHead title={sectionTitle("contractors")} sub="Milestone pay follows verified work instead of a Net-30 calendar. Every release still passes risk and authority guardrails." />
          <div className="space-y-2">
            <MilestoneHead title="Webhook retries with backoff" status={shown.status} tone={shown.tone} />
            <JiraIssueCard orgSlug={slug} milestoneId="docs-milestone-retries" view={view} />
          </div>
        </div>
      </main>
    </MotionProvider>
  );
}
