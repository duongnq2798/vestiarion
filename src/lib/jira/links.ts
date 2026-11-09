import { db } from "../dal";
import type { HeldReason, LinkFacts, LinkState, WithdrawReason } from "./acceptance";
import { deliverablesFrom, type Deliverable } from "./deliverables";
import { isJiraNotSetUp, JiraNotSetUpError, siteTableReady } from "./sites";

export { isJiraNotSetUp, JiraNotSetUpError } from "./sites";
export { milestonesForAcceptance, writeCriteria, type MilestoneForAcceptance } from "../linear/links";

/**
 * The Jira issues linked to milestones (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR5, JR6, JR8, JR10,
 * JR11, JR13), read and written through the DAL in the workspace's own scope, as Linear's issues are (`../linear/links`).
 * A link names its site's cloudId and the issue's numeric id there: an issue id is unique on its own site only, and an
 * issue keeps it when it moves, while its key does not. Every write to a link's state compares the state it read, so a
 * read that raced a person's acceptance changes nothing. The milestone itself is touched only by the two database
 * functions of migration 0149, `accept_jira_issue` and `hold_jira_acceptance`, and only in its verification, and by a
 * person's criteria (Linear's `writeCriteria`): never an amount, a payee or an address (JR18). No Atlassian person is
 * kept: no account id, name or email (JR19). Before 0149 has run, a read says Jira is not set up rather than failing.
 */

export interface IssueLink {
  id: string;
  milestoneId: string;
  connectionId: string;
  /** The site the issue is on. */
  cloudId: string;
  /** Jira's numeric id for the issue, which every read after the link uses. */
  issueId: string;
  /** Its key (ENG-142), as last read: it changes when the issue moves to another project. */
  identifier: string;
  projectId: string | null;
  projectKey: string | null;
  issueTitle: string;
  /** `<site>/browse/<KEY>`, as last read. */
  issueUrl: string | null;
  state: LinkState;
  heldReason: HeldReason | null;
  afterPayment: boolean;
  heldAt: string | null;
  /** Jira's own status, as last read: its category's key (`new`, `indeterminate`, `done`) and its name ("In Review"). */
  statusCategory: string | null;
  statusName: string | null;
  /** The resolution's name ("Done", "Won't Do"), as last read. */
  resolutionName: string | null;
  completed: boolean;
  completedAt: string | null;
  deliverables: Deliverable[];
  fingerprint: string | null;
  attachmentsRead: number;
  remoteLinksRead: number;
  commentsRead: number;
  moreUnread: boolean;
  /** When Jira says the issue last changed, as last read: the sweep's change check compares it (JR16). */
  issueUpdatedAt: string | null;
  /** When the last read that succeeded started (JR15). */
  lastReadAt: string | null;
  readError: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  acceptedFingerprint: string | null;
  acceptedCompletedAt: string | null;
  acceptedDeliverables: Deliverable[] | null;
  linkedAt: string;
}

interface LinkRow {
  id: string;
  milestone_id: string;
  connection_id: string;
  cloud_id: string;
  issue_id: string;
  identifier: string;
  project_id: string | null;
  project_key: string | null;
  issue_title: string;
  issue_url: string | null;
  state: LinkState;
  held_reason: HeldReason | null;
  after_payment: boolean;
  held_at: string | null;
  status_category: string | null;
  status_name: string | null;
  resolution_name: string | null;
  completed: boolean;
  completed_at: string | null;
  deliverables: unknown;
  deliverable_fingerprint: string | null;
  attachments_read: number | null;
  remote_links_read: number | null;
  comments_read: number | null;
  more_unread: boolean | null;
  issue_updated_at: string | null;
  last_read_at: string | null;
  read_error: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  accepted_fingerprint: string | null;
  accepted_completed_at: string | null;
  accepted_deliverables: unknown;
  linked_at: string;
}

export const LINK_COLUMNS =
  "id, milestone_id, connection_id, cloud_id, issue_id, identifier, project_id, project_key, issue_title, issue_url, state, held_reason, after_payment, held_at, status_category, status_name, resolution_name, completed, completed_at, deliverables, deliverable_fingerprint, attachments_read, remote_links_read, comments_read, more_unread, issue_updated_at, last_read_at, read_error, accepted_by, accepted_at, accepted_fingerprint, accepted_completed_at, accepted_deliverables, linked_at";

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

export function toIssueLink(row: LinkRow): IssueLink {
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    connectionId: row.connection_id,
    cloudId: row.cloud_id,
    issueId: row.issue_id,
    identifier: row.identifier,
    projectId: row.project_id,
    projectKey: row.project_key,
    issueTitle: row.issue_title,
    issueUrl: row.issue_url,
    state: row.state,
    heldReason: row.held_reason,
    afterPayment: row.after_payment === true,
    heldAt: iso(row.held_at),
    statusCategory: row.status_category,
    statusName: row.status_name,
    resolutionName: row.resolution_name,
    completed: row.completed === true,
    completedAt: iso(row.completed_at),
    deliverables: deliverablesFrom(row.deliverables),
    fingerprint: row.deliverable_fingerprint,
    attachmentsRead: Number(row.attachments_read ?? 0),
    remoteLinksRead: Number(row.remote_links_read ?? 0),
    commentsRead: Number(row.comments_read ?? 0),
    moreUnread: row.more_unread === true,
    issueUpdatedAt: iso(row.issue_updated_at),
    lastReadAt: iso(row.last_read_at),
    readError: row.read_error,
    acceptedBy: row.accepted_by,
    acceptedAt: iso(row.accepted_at),
    acceptedFingerprint: row.accepted_fingerprint,
    acceptedCompletedAt: iso(row.accepted_completed_at),
    acceptedDeliverables: row.accepted_deliverables === null || row.accepted_deliverables === undefined ? null : deliverablesFrom(row.accepted_deliverables),
    linkedAt: iso(row.linked_at) ?? row.linked_at,
  };
}

/** What Linear's plan reads of a link. */
export function factsOf(link: IssueLink): LinkFacts {
  return {
    state: link.state,
    heldReason: link.heldReason,
    acceptedAt: link.acceptedAt,
    acceptedFingerprint: link.acceptedFingerprint,
    acceptedCompletedAt: link.acceptedCompletedAt,
    afterPayment: link.afterPayment,
  };
}

function raise(error: { code?: string | null; message: string }): never {
  if (isJiraNotSetUp(error)) throw new JiraNotSetUpError();
  throw new Error(error.message);
}

/**
 * The live links (not unlinked), of these milestones, this connection, this site or these issues, or all of them; at
 * most `limit`. An issue id names one issue on its own site only, so a caller asking by issue names the site too.
 */
export async function liveLinks(
  filter: {
    milestoneIds?: readonly string[];
    connectionId?: string;
    cloudId?: string;
    issueIds?: readonly string[];
    states?: readonly LinkState[];
    limit?: number;
  } = {}
): Promise<IssueLink[]> {
  if (filter.milestoneIds && filter.milestoneIds.length === 0) return [];
  if (filter.issueIds && filter.issueIds.length === 0) return [];
  let query = db().from("jira_issue_links").select(LINK_COLUMNS).is("unlinked_at", null);
  if (filter.milestoneIds) query = query.in("milestone_id", [...filter.milestoneIds]);
  if (filter.connectionId) query = query.eq("connection_id", filter.connectionId);
  if (filter.cloudId) query = query.eq("cloud_id", filter.cloudId);
  if (filter.issueIds) query = query.in("issue_id", [...filter.issueIds]);
  if (filter.states) query = query.in("state", [...filter.states]);
  const result = await query.order("linked_at", { ascending: true }).limit(filter.limit ?? 200);
  if (result.error) raise(result.error);
  return ((result.data ?? []) as unknown as LinkRow[]).map(toIssueLink);
}

/** How many milestones one look for links to read goes through, and how many ids one read of links names. */
const MILESTONE_SCAN = 1000;
const ID_CHUNK = 100;

/**
 * The live links of the milestones in `statuses` (and, with `method`, verified that way), at most `limit`: those of the
 * milestones in the first status first. As Linear's: the milestones are found before their links, because a paid
 * milestone's link stays live, as its history, and a limit over every live link would in time hold none of the open ones.
 */
export async function linksOfMilestones(filter: { statuses: readonly string[]; method?: "jira"; states?: readonly LinkState[]; limit: number }): Promise<IssueLink[]> {
  let query = db().from("milestones").select("id, status").in("status", [...filter.statuses]);
  if (filter.method) query = query.eq("verification_method", filter.method);
  const result = await query.order("created_at", { ascending: true }).limit(MILESTONE_SCAN);
  if (result.error) raise(result.error);
  const rank = (status: string) => filter.statuses.indexOf(status);
  const ids = ((result.data ?? []) as Array<{ id: string; status: string }>).sort((a, b) => rank(a.status) - rank(b.status)).map((row) => row.id);
  const links: IssueLink[] = [];
  for (let at = 0; at < ids.length && links.length < filter.limit; at += ID_CHUNK) {
    const chunk = ids.slice(at, at + ID_CHUNK);
    // One live link per milestone (0149), kept in the milestones' order.
    const found = new Map((await liveLinks({ milestoneIds: chunk, ...(filter.states ? { states: filter.states } : {}), limit: ID_CHUNK })).map((link) => [link.milestoneId, link]));
    for (const id of chunk) {
      const link = found.get(id);
      if (link && links.length < filter.limit) links.push(link);
    }
  }
  return links;
}

/** A probe: throws `JiraNotSetUpError` before migration 0149 (the connect flow's `ready`): its function and its two tables. */
export async function jiraReady(): Promise<void> {
  const result = await db().rpc("jira_connector_ready");
  if (result.error) raise(result.error);
  const links = await db().from("jira_issue_links").select("id").limit(1);
  if (links.error) raise(links.error);
  await siteTableReady();
}

export type InsertOutcome = { ok: true; link: IssueLink } | { ok: false; reason: "milestone_linked" | "issue_linked" };

/** A new link, waiting until its first read is written (JR6): its issue is the one just read by key on the site. */
export async function insertLink(input: {
  milestoneId: string;
  connectionId: string;
  cloudId: string;
  issueId: string;
  identifier: string;
  projectId: string | null;
  projectKey: string | null;
  issueTitle: string;
  issueUrl: string | null;
  by: string;
}): Promise<InsertOutcome> {
  const result = await db()
    .from("jira_issue_links")
    .insert({
      milestone_id: input.milestoneId,
      connection_id: input.connectionId,
      cloud_id: input.cloudId,
      issue_id: input.issueId,
      identifier: input.identifier,
      project_id: input.projectId,
      project_key: input.projectKey,
      issue_title: Array.from(input.issueTitle).slice(0, 255).join(""),
      issue_url: input.issueUrl,
      linked_by: input.by,
    })
    .select(LINK_COLUMNS);
  if (result.error) {
    if (result.error.code === "23505" && /_milestone_key/.test(result.error.message)) return { ok: false, reason: "milestone_linked" };
    if (result.error.code === "23505" && /_issue_key/.test(result.error.message)) return { ok: false, reason: "issue_linked" };
    raise(result.error);
  }
  return { ok: true, link: toIssueLink(((result.data ?? []) as unknown as LinkRow[])[0]) };
}

/** What a full read found of an issue's deliverables: none after a status read, which keeps the ones last read (JR8). */
export interface DeliverablesWrite {
  list: Deliverable[];
  fingerprint: string;
  attachmentsRead: number;
  remoteLinksRead: number;
  commentsRead: number;
  moreUnread: boolean;
}

/** What a read found, written on the link: its facts, always; its state, when the plan moves it. */
export interface ReadWrite {
  identifier: string;
  projectId: string | null;
  projectKey: string | null;
  issueTitle: string;
  issueUrl: string | null;
  statusCategory: string | null;
  statusName: string | null;
  resolutionName: string | null;
  completed: boolean;
  completedAt: string | null;
  updatedAt: string | null;
  /** Null after a status read: the deliverables and their fingerprint last read stay as they are. */
  deliverables: DeliverablesWrite | null;
}

/**
 * Writes a read's facts, and the new state when given, over the state the read saw: false when the link moved since (a
 * person accepted it, or another read held it), and nothing is written. `startedIso` is when the read started, which is
 * what `last_read_at` keeps (JR15): a delivery sent before it is one this read already saw.
 */
export async function writeRead(link: IssueLink, facts: ReadWrite | null, next: { state: Exclude<LinkState, "accepted">; heldReason: HeldReason | null } | null, startedIso: string): Promise<boolean> {
  const values: Record<string, unknown> = { last_read_at: startedIso, read_error: null, updated_at: startedIso };
  if (facts) {
    Object.assign(values, {
      identifier: facts.identifier,
      project_id: facts.projectId,
      project_key: facts.projectKey,
      issue_title: Array.from(facts.issueTitle).slice(0, 255).join(""),
      issue_url: facts.issueUrl,
      status_category: facts.statusCategory,
      status_name: facts.statusName,
      resolution_name: facts.resolutionName,
      completed: facts.completed,
      completed_at: facts.completed ? facts.completedAt : null,
      issue_updated_at: facts.updatedAt,
    });
    if (facts.deliverables) {
      Object.assign(values, {
        deliverables: facts.deliverables.list,
        deliverable_fingerprint: facts.deliverables.fingerprint,
        attachments_read: facts.deliverables.attachmentsRead,
        remote_links_read: facts.deliverables.remoteLinksRead,
        comments_read: facts.deliverables.commentsRead,
        more_unread: facts.deliverables.moreUnread,
      });
    }
  }
  if (next && (next.state !== link.state || next.heldReason !== link.heldReason)) {
    Object.assign(values, { state: next.state, held_reason: next.heldReason, held_at: next.state === "held" ? startedIso : null });
  }
  const result = await db().from("jira_issue_links").update(values).eq("id", link.id).eq("state", link.state).is("unlinked_at", null).select("id");
  if (result.error) raise(result.error);
  return (result.data ?? []).length === 1;
}

/**
 * Moves a link's state with no read made (JR7: criteria written for a done issue held for want of them), over the state
 * and reason it was seen in: false when either moved since, and nothing is written. `last_read_at` is left as it is,
 * since no read started (JR15): a delivery sent before now is still one to read.
 */
export async function writeState(link: IssueLink, next: { state: Exclude<LinkState, "accepted">; heldReason: HeldReason | null }, nowIso: string): Promise<boolean> {
  const update = db()
    .from("jira_issue_links")
    .update({ state: next.state, held_reason: next.heldReason, held_at: next.state === "held" ? nowIso : null, updated_at: nowIso })
    .eq("id", link.id)
    .eq("state", link.state)
    .is("unlinked_at", null);
  const result = await (link.heldReason === null ? update.is("held_reason", null) : update.eq("held_reason", link.heldReason)).select("id");
  if (result.error) raise(result.error);
  return (result.data ?? []).length === 1;
}

/** A read that did not finish, said on the link in business words; nothing else changes, `last_read_at` included. */
export async function writeReadError(link: IssueLink, message: string, nowIso: string): Promise<void> {
  const result = await db().from("jira_issue_links").update({ read_error: message.slice(0, 300), updated_at: nowIso }).eq("id", link.id).select("id");
  if (result.error) raise(result.error);
}

/** `hold_jira_acceptance`'s answer. */
export type HoldOutcome = "held" | "held_after_payment" | "deferred" | "not_accepted";

export async function holdAcceptance(link: IssueLink, reason: WithdrawReason): Promise<HoldOutcome> {
  const result = await db().rpc("hold_jira_acceptance", { p_link_id: link.id, p_reason: reason });
  if (result.error) raise(result.error);
  const value = result.data as unknown;
  if (value === "held" || value === "held_after_payment" || value === "deferred" || value === "not_accepted") return value;
  throw new Error("hold_jira_acceptance answered something else");
}

/** `accept_jira_issue`'s refusals, in its order (0149): no `archived` step, since Jira has no such state. */
export type AcceptError = "link_not_found" | "already_accepted" | "after_payment" | "not_completed" | "stale" | "milestone_not_open" | "no_criteria" | "criteria_changed";

export class AcceptRefusedError extends Error {
  constructor(readonly code: AcceptError) {
    super(code);
    this.name = "AcceptRefusedError";
  }
}

const ACCEPT_CODES: ReadonlySet<string> = new Set(["link_not_found", "already_accepted", "after_payment", "not_completed", "stale", "milestone_not_open", "no_criteria", "criteria_changed"]);

/** `accept_jira_issue` (JR11): the milestone verified by this person's acceptance, or the refusal's code. */
export async function acceptLink(link: IssueLink, input: { by: string; fingerprint: string; criteriaSha256: string; note: string }): Promise<IssueLink> {
  const result = await db()
    .rpc("accept_jira_issue", { p_link_id: link.id, p_by: input.by, p_fingerprint: input.fingerprint, p_criteria_sha256: input.criteriaSha256, p_note: input.note })
    .single();
  if (result.error) {
    const code = /^([a-z_]+):/.exec(result.error.message)?.[1];
    if (code && ACCEPT_CODES.has(code)) throw new AcceptRefusedError(code as AcceptError);
    raise(result.error);
  }
  return toIssueLink(result.data as unknown as LinkRow);
}

/** Unlinks an issue: kept, with who and when, so the history stays. False when it was unlinked already. */
export async function unlinkLink(link: IssueLink, by: string, nowIso: string): Promise<boolean> {
  const result = await db().from("jira_issue_links").update({ unlinked_at: nowIso, unlinked_by: by, updated_at: nowIso }).eq("id", link.id).is("unlinked_at", null).select("id");
  if (result.error) raise(result.error);
  return (result.data ?? []).length === 1;
}
