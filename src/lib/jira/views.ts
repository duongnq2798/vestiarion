import { durationWords } from "../asana/acceptance";
import { connectionStatus, type StatusView } from "../connectors/status";
import type { Connection } from "../connectors/connections";
import { utcDay, utcMinute } from "../copy";
import type { LinkAccess } from "../evidence-links/check";
import { criteriaHash } from "../linear/views";
import { acceptable, acceptanceKpis, stateWords, type AcceptanceEvent, type HeldReason, type LinkState } from "./acceptance";
import { ATTACHMENTS_READ, COMMENTS_READ, REMOTE_LINKS_READ } from "./api";
import type { IssueLink } from "./links";
import type { StoredSite } from "./sites";
import { siteHost } from "./urls";

export { criteriaHash } from "../linear/views";

/**
 * What the Contractors card and the Settings card show of Jira (docs/superpowers/specs/2026-11-09-jira-acceptance-
 * design.md JR11, JR21, JR22), as Linear's (`../linear/views`), built on the server from the rows, so the browser gets
 * words and links, never a token, an Atlassian account or an email. No Atlassian person is shown, because none is kept
 * (JR19): who moved the issue to Done, and who it is assigned to, are never read.
 */

export type JiraTone = "waiting" | "ready" | "accepted" | "held";

/** Where a deliverable was read in Jira: a file attached to the issue, a web link on it, or a link in its words. */
export type JiraDeliverableKind = "file" | "web_link" | "link" | "comment_link";

export interface JiraDeliverableView {
  kind: JiraDeliverableKind;
  label: string;
  /** Null when there is no https link, or the link was checked and cannot be opened (then `note` says why). */
  href: string | null;
  note: string | null;
  /** Shown as given, not checked: another site's link, or one Vestiarion does not check. */
  given: boolean;
}

export type JiraMilestoneView =
  | { linked: false; connected: boolean; criteria: string | null; canWrite: boolean }
  | {
      linked: true;
      identifier: string;
      issueTitle: string;
      issueUrl: string | null;
      /** Jira's own name for the issue's status now ("Done", "In Review"), as last read. */
      jiraStatus: string | null;
      /** Jira's resolution ("Done", "Won't Do"), as last read. */
      resolutionName: string | null;
      /** The site the issue is on, from its address. */
      siteHost: string | null;
      state: LinkState;
      heldReason: HeldReason | null;
      tone: JiraTone;
      label: string;
      line: string;
      completedAt: string | null;
      deliverables: JiraDeliverableView[];
      fingerprint: string | null;
      criteria: string | null;
      criteriaSha256: string | null;
      /** A person may accept now: done, criteria written, the milestone waiting for verification, Jira connected. */
      canAccept: boolean;
      /** Criteria may be written or changed: nothing accepted against them yet, and the milestone open. */
      canEditCriteria: boolean;
      acceptedAt: string | null;
      acceptedBy: string | null;
      readError: string | null;
      lastReadAt: string | null;
      /** The facts in words: done when and how, accepted when and by whom, the site, what was read, last read. */
      facts: string[];
      canWrite: boolean;
    };

/** A file is kept as `file:<id>` and a web link as `remotelink:<id>` (JR8): both are Jira attachments to the issue. */
const kindOf = (item: IssueLink["deliverables"][number]): JiraDeliverableKind =>
  item.kind === "attachment" ? (item.id.startsWith("remotelink:") ? "web_link" : "file") : item.kind;

function deliverableView(item: IssueLink["deliverables"][number], links: ReadonlyMap<string, LinkAccess> | null): JiraDeliverableView {
  const kind = kindOf(item);
  if (!item.href) return { kind, label: item.label, href: null, note: item.kind === "attachment" ? "No link Vestiarion can show." : null, given: false };
  const access = links?.get(item.href);
  if (access?.state === "cannot_open") return { kind, label: item.label, href: null, note: access.reason, given: false };
  return { kind, label: item.label, href: item.href, note: null, given: !access || access.state === "not_checked" };
}

/** Jira's status in words (JR9): done by the category's key, never the name; resolved as not done; or not done yet. */
function statusFact(link: IssueLink): string {
  if (link.completed) {
    const how = [link.statusName, link.resolutionName ? `resolved as ${link.resolutionName}` : null].filter((part): part is string => part !== null);
    return `Done in Jira${link.completedAt ? ` on ${utcDay(link.completedAt)}` : ""}${how.length > 0 ? ` (${how.join(", ")})` : ""}.`;
  }
  // In Jira's Done category with a resolution that cancels the work: not done.
  if (link.statusCategory === "done" && link.resolutionName) return `Resolved in Jira as ${link.resolutionName}${link.statusName ? ` (${link.statusName})` : ""}: not done.`;
  return link.statusName ? `${link.statusName} in Jira: not done yet.` : "Not done in Jira.";
}

/** A milestone's Jira card: linked and how it stands, or what linking takes. */
export function jiraMilestoneView(input: {
  milestone: { id: string; status: string; acceptance_criteria?: string | null };
  link: IssueLink | null;
  connected: boolean;
  canWrite: boolean;
  links?: ReadonlyMap<string, LinkAccess> | null;
  memberEmails?: Readonly<Record<string, string>>;
}): JiraMilestoneView {
  const criteria = input.milestone.acceptance_criteria ?? null;
  const { link } = input;
  if (!link) return { linked: false, connected: input.connected, criteria, canWrite: input.canWrite };
  const words = stateWords(link.state, link.heldReason, link.afterPayment, link.resolutionName);
  const acceptedBy = link.acceptedBy ? (input.memberEmails?.[link.acceptedBy] ?? "a member") : null;
  const host = link.issueUrl ? siteHost(link.issueUrl) : null;
  const facts = [
    statusFact(link),
    link.acceptedAt && link.state === "accepted" ? `Accepted on ${utcDay(link.acceptedAt)}${acceptedBy ? ` by ${acceptedBy}` : ""}.` : null,
    host ? `On ${host}.` : null,
    link.moreUnread
      ? `Jira has more than Vestiarion reads: the first ${ATTACHMENTS_READ} attachments, ${REMOTE_LINKS_READ} web links and the newest ${COMMENTS_READ} comments were checked.`
      : null,
    link.lastReadAt ? `Read from Jira ${utcMinute(link.lastReadAt)}.` : null,
  ].filter((line): line is string => line !== null);
  // An accepted link shows the version accepted; any other, what Jira says now.
  const shown = link.state === "accepted" && link.acceptedDeliverables ? link.acceptedDeliverables : link.deliverables;
  return {
    linked: true,
    identifier: link.identifier,
    issueTitle: link.issueTitle,
    issueUrl: link.issueUrl,
    jiraStatus: link.statusName,
    resolutionName: link.resolutionName,
    siteHost: host,
    state: link.state,
    heldReason: link.heldReason,
    tone: link.state,
    label: words.label,
    line: words.line,
    completedAt: link.completedAt,
    deliverables: shown.map((item) => deliverableView(item, input.links ?? null)),
    fingerprint: link.fingerprint,
    criteria,
    criteriaSha256: criteria ? criteriaHash(criteria) : null,
    // Jira has no archived state of its own (JR10): Linear's rule, with `archived` always false.
    canAccept: input.connected && acceptable(link, { completed: link.completed, archived: false, criteria: criteria !== null, milestoneStatus: input.milestone.status }),
    canEditCriteria: link.state !== "accepted" && input.milestone.status === "pending",
    acceptedAt: link.acceptedAt,
    acceptedBy,
    readError: link.readError,
    lastReadAt: link.lastReadAt,
    facts,
    canWrite: input.canWrite,
  };
}

/** Whether a milestone's Jira card waits on a person: ready for acceptance, or held for review (JR22). */
export const jiraNeedsPerson = (link: IssueLink | null | undefined) => link?.state === "ready" || link?.state === "held";

/** How long a change the sweep found and no notice told of keeps the card's notice line on it (JR21). */
export const MISSED_SHOWN_MS = 24 * 60 * 60_000;
/** Jira's words for refusing the webhook, as far as the card quotes them. */
const ERROR_CHARS = 200;

/**
 * Whether Jira's notices arrive (JR21, JR22), in one line, the first that applies: Jira refused the webhook; the sweep
 * found a change no notice told of, in the last 24 hours and since the last notice; when the last notice came; or that
 * none has come yet. None while no open milestone is linked to an issue on the site: then there is no webhook to speak of.
 */
export function noticeLine(site: Pick<StoredSite, "webhookError" | "missedChangeAt" | "lastDeliveryAt"> | null, openLinks: number, nowMs: number): string | null {
  if (openLinks === 0) return null;
  const error = site?.webhookError?.trim();
  if (error) {
    const cut = Array.from(error).length > ERROR_CHARS ? `${Array.from(error).slice(0, ERROR_CHARS - 1).join("")}…` : error;
    return `Jira did not take Vestiarion's webhook: ${cut.replace(/[.\s]+$/, "")}. Linked issues are read every 15 minutes.`;
  }
  const missed = site?.missedChangeAt ? Date.parse(site.missedChangeAt) : null;
  const delivered = site?.lastDeliveryAt ? Date.parse(site.lastDeliveryAt) : null;
  if (missed !== null && nowMs - missed < MISSED_SHOWN_MS && (delivered === null || missed > delivered)) {
    return "Jira's notices are not reaching Vestiarion: the 15-minute check found a change Jira did not send. Linked issues are still read every 15 minutes.";
  }
  if (site?.lastDeliveryAt) return `Jira last told Vestiarion of a change ${utcMinute(site.lastDeliveryAt)}.`;
  return "Jira has not told Vestiarion of a change yet. Linked issues are read every 15 minutes.";
}

export type JiraPanelView =
  | { state: "not_set_up" }
  | { state: "not_connected" }
  | {
      state: "connection";
      status: StatusView;
      connected: boolean;
      revoked: boolean;
      /** The Jira site connected, by its name, and its host. */
      siteName: string | null;
      siteHost: string | null;
      /** Whether Jira's notices arrive (JR21); null when no open milestone is linked on the site. */
      noticeLine: string | null;
      counts: { linked: number; ready: number; accepted: number; held: number };
      figures: { manualChecks: number; disputes: number; timeToProposal: string | null; window: string };
    };

/**
 * The Settings card's view (JR21, JR22): the connection's status and its site, whether Jira's notices arrive, the linked
 * issues by state, and the last 30 days' figures. `openLinks` is how many open milestones are linked to an issue on the
 * connected site, which is what the webhook is kept for.
 */
export function jiraPanelView(input: {
  connection: Connection | null;
  site: Pick<StoredSite, "siteUrl" | "webhookError" | "missedChangeAt" | "lastDeliveryAt"> | null;
  links: readonly IssueLink[];
  openLinks: number;
  events: readonly AcceptanceEvent[];
  nowMs: number;
}): JiraPanelView {
  const { connection } = input;
  if (!connection) return { state: "not_connected" };
  const kpis = acceptanceKpis(input.events, input.nowMs, 30);
  const revoked = connection.status === "revoked";
  return {
    state: "connection",
    status: connectionStatus(
      {
        providerLabel: "Jira",
        status: connection.status,
        externalOrgName: connection.externalOrgName ? `the ${connection.externalOrgName} site in Jira` : null,
        lastSyncedAt: connection.lastSyncedAt,
        lastError: connection.lastError,
        lastErrorAt: connection.lastErrorAt,
        syncing: null,
      },
      input.nowMs
    ),
    connected: connection.status === "connected",
    revoked,
    siteName: connection.externalOrgName,
    siteHost: input.site ? siteHost(input.site.siteUrl) : null,
    noticeLine: revoked ? null : noticeLine(input.site, input.openLinks, input.nowMs),
    counts: {
      linked: input.links.length,
      ready: input.links.filter((link) => link.state === "ready").length,
      accepted: input.links.filter((link) => link.state === "accepted").length,
      held: input.links.filter((link) => link.state === "held").length,
    },
    figures: {
      manualChecks: kpis.manualChecks,
      disputes: kpis.disputes,
      timeToProposal: kpis.medianMinutesToProposal === null ? null : durationWords(kpis.medianMinutesToProposal),
      window: "the last 30 days",
    },
  };
}
