import crypto from "node:crypto";
import { connectionStatus, type StatusView } from "../connectors/status";
import type { Connection } from "../connectors/connections";
import { utcDay, utcMinute } from "../copy";
import type { LinkAccess } from "../evidence-links/check";
import { acceptable, acceptanceKpis, durationWords, stateWords, type AcceptanceEvent, type HeldReason, type LinkState } from "./acceptance";
import type { DeliverableKind } from "./deliverables";
import type { TaskLink } from "./links";

/**
 * What the Contractors card and the Settings card show of Asana (docs/superpowers/specs/2026-10-14-asana-acceptance-
 * design.md A8, A14, A16), built on the server from the rows, so the browser gets words and links, never a token.
 */

export type AsanaTone = "waiting" | "ready" | "accepted" | "held";

export interface DeliverableView {
  kind: DeliverableKind;
  label: string;
  /** Null when there is no https link, or the link was checked and cannot be opened (then `note` says why). */
  href: string | null;
  note: string | null;
  /** Shown as given, not checked: another site's link. */
  given: boolean;
}

export type AsanaMilestoneView =
  | { linked: false; connected: boolean; criteria: string | null; canWrite: boolean }
  | {
      linked: true;
      taskName: string;
      taskUrl: string | null;
      state: LinkState;
      heldReason: HeldReason | null;
      tone: AsanaTone;
      label: string;
      line: string;
      completedAt: string | null;
      completedByName: string | null;
      assigneeName: string | null;
      deliverables: DeliverableView[];
      fingerprint: string | null;
      criteria: string | null;
      criteriaSha256: string | null;
      /** A person may accept now: completed, criteria written, the milestone waiting for verification. */
      canAccept: boolean;
      /** Criteria may be written or changed: nothing accepted against them yet, and the milestone open. */
      canEditCriteria: boolean;
      acceptedAt: string | null;
      acceptedBy: string | null;
      readError: string | null;
      lastReadAt: string | null;
      /** The facts in words: completed when and by whom, assigned to, accepted when and by whom, last read. */
      facts: string[];
      canWrite: boolean;
    };

export const criteriaHash = (criteria: string) => crypto.createHash("sha256").update(criteria, "utf8").digest("hex");

function deliverableView(item: TaskLink["deliverables"][number], links: ReadonlyMap<string, LinkAccess> | null): DeliverableView {
  if (!item.href) return { kind: item.kind, label: item.label, href: null, note: item.kind === "attachment" ? "No link Vestiarion can show." : null, given: false };
  const access = links?.get(item.href);
  if (access?.state === "cannot_open") return { kind: item.kind, label: item.label, href: null, note: access.reason, given: false };
  return { kind: item.kind, label: item.label, href: item.href, note: null, given: !access || access.state === "not_checked" };
}

/** A milestone's Asana card: linked and how it stands, or what linking takes. */
export function asanaMilestoneView(input: {
  milestone: { id: string; status: string; acceptance_criteria?: string | null };
  link: TaskLink | null;
  connected: boolean;
  canWrite: boolean;
  links?: ReadonlyMap<string, LinkAccess> | null;
  memberEmails?: Readonly<Record<string, string>>;
}): AsanaMilestoneView {
  const criteria = input.milestone.acceptance_criteria ?? null;
  const { link } = input;
  if (!link) return { linked: false, connected: input.connected, criteria, canWrite: input.canWrite };
  const words = stateWords(link.state, link.heldReason, link.afterPayment);
  const acceptedBy = link.acceptedBy ? (input.memberEmails?.[link.acceptedBy] ?? "a member") : null;
  const facts = [
    link.completed ? `Completed in Asana${link.completedAt ? ` on ${utcDay(link.completedAt)}` : ""}${link.completedByName ? ` by ${link.completedByName}` : ""}.` : "Not completed in Asana.",
    link.assigneeName ? `Assigned to ${link.assigneeName}.` : null,
    link.acceptedAt && link.state === "accepted" ? `Accepted on ${utcDay(link.acceptedAt)}${acceptedBy ? ` by ${acceptedBy}` : ""}.` : null,
    link.lastReadAt ? `Read from Asana ${utcMinute(link.lastReadAt)}.` : null,
  ].filter((line): line is string => line !== null);
  // An accepted link shows the version accepted; any other, what Asana says now.
  const shown = link.state === "accepted" && link.acceptedDeliverables ? link.acceptedDeliverables : link.deliverables;
  return {
    linked: true,
    taskName: link.taskName,
    taskUrl: link.taskUrl,
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
    canAccept: input.connected && acceptable(link, { completed: link.completed, criteria: criteria !== null, milestoneStatus: input.milestone.status }),
    canEditCriteria: link.state !== "accepted" && input.milestone.status === "pending",
    acceptedAt: link.acceptedAt,
    acceptedBy,
    readError: link.readError,
    lastReadAt: link.lastReadAt,
    facts,
    canWrite: input.canWrite,
  };
}

/** Whether a milestone's Asana card waits on a person: ready for acceptance, or held for review. */
export const asanaNeedsPerson = (link: TaskLink | null | undefined) => link?.state === "ready" || link?.state === "held";

export type AsanaPanelView =
  | { state: "not_set_up" }
  | { state: "not_connected" }
  | {
      state: "connection";
      status: StatusView;
      connected: boolean;
      revoked: boolean;
      counts: { linked: number; ready: number; accepted: number; held: number };
      figures: { manualChecks: number; disputes: number; timeToProposal: string | null; window: string };
    };

/** The Settings card's view: the connection's status, the linked tasks by state, and the last 30 days' figures. */
export function asanaPanelView(input: { connection: Connection | null; links: readonly TaskLink[]; events: readonly AcceptanceEvent[]; nowMs: number }): AsanaPanelView {
  const { connection } = input;
  if (!connection) return { state: "not_connected" };
  const kpis = acceptanceKpis(input.events, input.nowMs, 30);
  return {
    state: "connection",
    status: connectionStatus(
      {
        providerLabel: "Asana",
        status: connection.status,
        externalOrgName: connection.externalOrgName ? `${connection.externalOrgName}'s Asana` : null,
        lastSyncedAt: connection.lastSyncedAt,
        lastError: connection.lastError,
        lastErrorAt: connection.lastErrorAt,
        syncing: null,
      },
      input.nowMs
    ),
    connected: connection.status === "connected",
    revoked: connection.status === "revoked",
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
