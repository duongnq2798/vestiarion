import crypto from "node:crypto";
import { durationWords } from "../asana/acceptance";
import { connectionStatus, type StatusView } from "../connectors/status";
import type { Connection } from "../connectors/connections";
import { utcDay, utcMinute } from "../copy";
import type { LinkAccess } from "../evidence-links/check";
import { acceptable, acceptanceKpis, stateWords, type AcceptanceEvent, type HeldReason, type LinkState } from "./acceptance";
import { ATTACHMENTS_READ, COMMENTS_READ } from "./api";
import type { DeliverableKind } from "./deliverables";
import type { IssueLink } from "./links";

/**
 * What the Contractors card and the Settings card show of Linear (docs/superpowers/specs/2026-10-31-linear-acceptance-
 * design.md LN8, LN15, LN16), built on the server from the rows, so the browser gets words and links, never a token or
 * an email.
 */

export type LinearTone = "waiting" | "ready" | "accepted" | "held";

export interface LinearDeliverableView {
  kind: DeliverableKind;
  label: string;
  /** Null when there is no https link, or the link was checked and cannot be opened (then `note` says why). */
  href: string | null;
  note: string | null;
  /** Shown as given, not checked: another site's link. */
  given: boolean;
}

export type LinearMilestoneView =
  | { linked: false; connected: boolean; criteria: string | null; canWrite: boolean }
  | {
      linked: true;
      identifier: string;
      issueTitle: string;
      issueUrl: string | null;
      /** Linear's own name for the issue's status now ("Done", "In Review"), as last read. */
      linearStatus: string | null;
      state: LinkState;
      heldReason: HeldReason | null;
      tone: LinearTone;
      label: string;
      line: string;
      completedAt: string | null;
      completedByName: string | null;
      assigneeName: string | null;
      deliverables: LinearDeliverableView[];
      fingerprint: string | null;
      criteria: string | null;
      criteriaSha256: string | null;
      /** A person may accept now: done, not archived, criteria written, the milestone waiting for verification. */
      canAccept: boolean;
      /** Criteria may be written or changed: nothing accepted against them yet, and the milestone open. */
      canEditCriteria: boolean;
      acceptedAt: string | null;
      acceptedBy: string | null;
      readError: string | null;
      lastReadAt: string | null;
      /** The facts in words: done when and by whom, assigned to, accepted when and by whom, what was read, last read. */
      facts: string[];
      canWrite: boolean;
    };

export const criteriaHash = (criteria: string) => crypto.createHash("sha256").update(criteria, "utf8").digest("hex");

function deliverableView(item: IssueLink["deliverables"][number], links: ReadonlyMap<string, LinkAccess> | null): LinearDeliverableView {
  if (!item.href) return { kind: item.kind, label: item.label, href: null, note: item.kind === "attachment" ? "No link Vestiarion can show." : null, given: false };
  const access = links?.get(item.href);
  if (access?.state === "cannot_open") return { kind: item.kind, label: item.label, href: null, note: access.reason, given: false };
  return { kind: item.kind, label: item.label, href: item.href, note: null, given: !access || access.state === "not_checked" };
}

function statusFact(link: IssueLink): string {
  if (link.archived) return "Archived or deleted in Linear.";
  if (link.completed) return `Done in Linear${link.completedAt ? ` on ${utcDay(link.completedAt)}` : ""}${link.completedByName ? ` by ${link.completedByName}` : ""}.`;
  if (link.stateType === "canceled") return `Canceled in Linear${link.stateName ? ` (${link.stateName})` : ""}.`;
  return link.stateName ? `${link.stateName} in Linear: not done yet.` : "Not done in Linear.";
}

/** A milestone's Linear card: linked and how it stands, or what linking takes. */
export function linearMilestoneView(input: {
  milestone: { id: string; status: string; acceptance_criteria?: string | null };
  link: IssueLink | null;
  connected: boolean;
  canWrite: boolean;
  links?: ReadonlyMap<string, LinkAccess> | null;
  memberEmails?: Readonly<Record<string, string>>;
}): LinearMilestoneView {
  const criteria = input.milestone.acceptance_criteria ?? null;
  const { link } = input;
  if (!link) return { linked: false, connected: input.connected, criteria, canWrite: input.canWrite };
  const words = stateWords(link.state, link.heldReason, link.afterPayment);
  const acceptedBy = link.acceptedBy ? (input.memberEmails?.[link.acceptedBy] ?? "a member") : null;
  const facts = [
    statusFact(link),
    link.assigneeName ? `Assigned to ${link.assigneeName}.` : null,
    link.acceptedAt && link.state === "accepted" ? `Accepted on ${utcDay(link.acceptedAt)}${acceptedBy ? ` by ${acceptedBy}` : ""}.` : null,
    link.moreUnread ? `Linear has more than Vestiarion reads: the first ${ATTACHMENTS_READ} attachments and ${COMMENTS_READ} comments were checked.` : null,
    link.lastReadAt ? `Read from Linear ${utcMinute(link.lastReadAt)}.` : null,
  ].filter((line): line is string => line !== null);
  // An accepted link shows the version accepted; any other, what Linear says now.
  const shown = link.state === "accepted" && link.acceptedDeliverables ? link.acceptedDeliverables : link.deliverables;
  return {
    linked: true,
    identifier: link.identifier,
    issueTitle: link.issueTitle,
    issueUrl: link.issueUrl,
    linearStatus: link.stateName,
    state: link.state,
    heldReason: link.heldReason,
    tone: link.state,
    label: words.label,
    line: words.line,
    completedAt: link.completedAt,
    completedByName: link.completedByName,
    assigneeName: link.assigneeName,
    deliverables: shown.map((item) => deliverableView(item, input.links ?? null)),
    fingerprint: link.fingerprint,
    criteria,
    criteriaSha256: criteria ? criteriaHash(criteria) : null,
    canAccept: input.connected && acceptable(link, { completed: link.completed, archived: link.archived, criteria: criteria !== null, milestoneStatus: input.milestone.status }),
    canEditCriteria: link.state !== "accepted" && input.milestone.status === "pending",
    acceptedAt: link.acceptedAt,
    acceptedBy,
    readError: link.readError,
    lastReadAt: link.lastReadAt,
    facts,
    canWrite: input.canWrite,
  };
}

/** Whether a milestone's Linear card waits on a person: ready for acceptance, or held for review. */
export const linearNeedsPerson = (link: IssueLink | null | undefined) => link?.state === "ready" || link?.state === "held";

export type LinearPanelView =
  | { state: "not_set_up" }
  | { state: "not_connected" }
  | {
      state: "connection";
      status: StatusView;
      connected: boolean;
      revoked: boolean;
      /** The Linear workspace connected, by its name. */
      workspaceName: string | null;
      counts: { linked: number; ready: number; accepted: number; held: number };
      figures: { manualChecks: number; disputes: number; timeToProposal: string | null; window: string };
    };

/** The Settings card's view: the connection's status, the linked issues by state, and the last 30 days' figures (LN15). */
export function linearPanelView(input: { connection: Connection | null; links: readonly IssueLink[]; events: readonly AcceptanceEvent[]; nowMs: number }): LinearPanelView {
  const { connection } = input;
  if (!connection) return { state: "not_connected" };
  const kpis = acceptanceKpis(input.events, input.nowMs, 30);
  return {
    state: "connection",
    status: connectionStatus(
      {
        providerLabel: "Linear",
        status: connection.status,
        externalOrgName: connection.externalOrgName ? `the ${connection.externalOrgName} workspace in Linear` : null,
        lastSyncedAt: connection.lastSyncedAt,
        lastError: connection.lastError,
        lastErrorAt: connection.lastErrorAt,
        syncing: null,
      },
      input.nowMs
    ),
    connected: connection.status === "connected",
    revoked: connection.status === "revoked",
    workspaceName: connection.externalOrgName,
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
