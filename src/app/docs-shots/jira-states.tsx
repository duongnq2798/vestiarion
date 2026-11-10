import JiraPanel from "@/components/JiraPanel";
import { JiraIssueCard } from "@/components/JiraIssueCard";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { IssueLink } from "@/lib/jira/links";
import { jiraMilestoneView, jiraPanelView } from "@/lib/jira/views";
import { DESIGN_SLUG } from "../design/fixtures";
import { JIRA_CONNECTION, JIRA_EVENTS, JIRA_NOW, JIRA_PANEL_LINKS, JIRA_SITE, LINK_ACCEPTED, LINK_HELD, LINK_READY, MEMBER_EMAILS, RETRIES_CRITERIA } from "./jira-fixture";

/**
 * The five Jira states (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR22), drawn from the fixture by the
 * pages' own view functions: the Jira card in Settings, and a milestone's Jira card before an issue is linked, ready for
 * acceptance, accepted and held after the issue was reopened. /docs-shots/jira/<state> shows each in a page frame, and
 * the Jira guide's screenshots (`jira-<state>` in shots.tsx) show each in the screenshot frame.
 */

export const JIRA_STATES = ["settings", "link", "ready", "accepted", "held"] as const;
export type JiraState = (typeof JIRA_STATES)[number];
export type JiraCardState = Exclude<JiraState, "settings">;

/** The Jira card in Settings: the site connected, its notices, its linked issues and the last 30 days' figures. */
export function JiraSettingsState() {
  const view = jiraPanelView({ connection: JIRA_CONNECTION, site: JIRA_SITE, links: JIRA_PANEL_LINKS, openLinks: JIRA_PANEL_LINKS.length, events: JIRA_EVENTS, nowMs: JIRA_NOW });
  return <JiraPanel orgSlug={DESIGN_SLUG} view={view} canManage notice={null} />;
}

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

const milestoneStatus: Record<JiraCardState, { status: string; milestone: string; tone: "neutral" | "agent" | "proof" | "held"; link: IssueLink | null }> = {
  link: { status: "Awaiting verification", milestone: "pending", tone: "neutral", link: null },
  ready: { status: "Ready for acceptance", milestone: "pending", tone: "agent", link: LINK_READY },
  accepted: { status: "Verified", milestone: "verified", tone: "proof", link: LINK_ACCEPTED },
  held: { status: "Held for review", milestone: "pending", tone: "held", link: LINK_HELD },
};

/** A milestone's head and its Jira card, in one of the four states a milestone's card can be in. */
export function JiraMilestoneState({ state }: { state: JiraCardState }) {
  const shown = milestoneStatus[state];
  const view = jiraMilestoneView({
    milestone: { id: "docs-milestone-retries", status: shown.milestone, acceptance_criteria: state === "link" ? null : RETRIES_CRITERIA },
    link: shown.link,
    connected: true,
    canWrite: true,
    links: null,
    memberEmails: MEMBER_EMAILS,
  });
  return (
    <div className="space-y-2">
      <MilestoneHead title="Webhook retries with backoff" status={shown.status} tone={shown.tone} />
      <JiraIssueCard orgSlug={DESIGN_SLUG} milestoneId="docs-milestone-retries" view={view} />
    </div>
  );
}
