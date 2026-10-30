import { db } from "../dal";
import type { HeldReason, LinkFacts, LinkState, WithdrawReason } from "./acceptance";
import { deliverablesFrom, type Deliverable } from "./deliverables";

/**
 * The issues linked to milestones (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN3, LN4, LN8, LN10),
 * read and written through the DAL in the workspace's own scope, as Asana's tasks are (`../asana/links`). Every write
 * to a link's state compares the state it read, so a read that raced a person's acceptance changes nothing. The
 * milestone itself is touched only by the two database functions of migration 0147, `accept_linear_issue` and
 * `hold_linear_acceptance`, and only in its verification, and by a person's criteria: never an amount, a payee or an
 * address. Before 0147 has run, a read says Linear is not set up rather than failing.
 */

export interface IssueLink {
  id: string;
  milestoneId: string;
  connectionId: string;
  issueId: string;
  identifier: string;
  teamKey: string | null;
  issueTitle: string;
  issueUrl: string | null;
  state: LinkState;
  heldReason: HeldReason | null;
  afterPayment: boolean;
  heldAt: string | null;
  /** Linear's own workflow state, as last read: its type and its name ("Done", "In Review"). */
  stateType: string | null;
  stateName: string | null;
  completed: boolean;
  completedAt: string | null;
  completedById: string | null;
  completedByName: string | null;
  assigneeName: string | null;
  archived: boolean;
  deliverables: Deliverable[];
  fingerprint: string | null;
  attachmentsRead: number;
  commentsRead: number;
  moreUnread: boolean;
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
  issue_id: string;
  identifier: string;
  team_key: string | null;
  issue_title: string;
  issue_url: string | null;
  state: LinkState;
  held_reason: HeldReason | null;
  after_payment: boolean;
  held_at: string | null;
  state_type: string | null;
  state_name: string | null;
  completed: boolean;
  completed_at: string | null;
  completed_by_id: string | null;
  completed_by_name: string | null;
  assignee_name: string | null;
  archived: boolean;
  deliverables: unknown;
  deliverable_fingerprint: string | null;
  attachments_read: number | null;
  comments_read: number | null;
  more_unread: boolean | null;
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
  "id, milestone_id, connection_id, issue_id, identifier, team_key, issue_title, issue_url, state, held_reason, after_payment, held_at, state_type, state_name, completed, completed_at, completed_by_id, completed_by_name, assignee_name, archived, deliverables, deliverable_fingerprint, attachments_read, comments_read, more_unread, last_read_at, read_error, accepted_by, accepted_at, accepted_fingerprint, accepted_completed_at, accepted_deliverables, linked_at";

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

export function toIssueLink(row: LinkRow): IssueLink {
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    connectionId: row.connection_id,
    issueId: row.issue_id,
    identifier: row.identifier,
    teamKey: row.team_key,
    issueTitle: row.issue_title,
    issueUrl: row.issue_url,
    state: row.state,
    heldReason: row.held_reason,
    afterPayment: row.after_payment === true,
    heldAt: iso(row.held_at),
    stateType: row.state_type,
    stateName: row.state_name,
    completed: row.completed === true,
    completedAt: iso(row.completed_at),
    completedById: row.completed_by_id,
    completedByName: row.completed_by_name,
    assigneeName: row.assignee_name,
    archived: row.archived === true,
    deliverables: deliverablesFrom(row.deliverables),
    fingerprint: row.deliverable_fingerprint,
    attachmentsRead: Number(row.attachments_read ?? 0),
    commentsRead: Number(row.comments_read ?? 0),
    moreUnread: row.more_unread === true,
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

/** A table, column or function migration 0147 adds, missing because it has not run here yet. */
export function isLinearNotSetUp(error: { code?: string | null; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code && ["PGRST205", "PGRST202", "PGRST204", "42P01", "42703", "42883"].includes(error.code)) return true;
  return /could not find the (table|function|column)|does not exist/i.test(error.message ?? "");
}

/** Linear's table is not in this database yet (migration 0147). */
export class LinearNotSetUpError extends Error {
  constructor() {
    super("The Linear tables are not in this database yet");
    this.name = "LinearNotSetUpError";
  }
}

function raise(error: { code?: string | null; message: string }): never {
  if (isLinearNotSetUp(error)) throw new LinearNotSetUpError();
  throw new Error(error.message);
}

/** The live links (not unlinked), of these milestones, this connection or these issues, or all of them; at most `limit`. */
export async function liveLinks(
  filter: { milestoneIds?: readonly string[]; connectionId?: string; issueIds?: readonly string[]; states?: readonly LinkState[]; limit?: number } = {}
): Promise<IssueLink[]> {
  if (filter.milestoneIds && filter.milestoneIds.length === 0) return [];
  if (filter.issueIds && filter.issueIds.length === 0) return [];
  let query = db().from("linear_issue_links").select(LINK_COLUMNS).is("unlinked_at", null);
  if (filter.milestoneIds) query = query.in("milestone_id", [...filter.milestoneIds]);
  if (filter.connectionId) query = query.eq("connection_id", filter.connectionId);
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
 * milestones in the first status first. The milestones are found before their links because a paid milestone's link
 * stays live, as its history: a limit taken over every live link would, once enough milestones were paid, hold none of
 * the open ones, and nothing open would be read again.
 */
export async function linksOfMilestones(filter: { statuses: readonly string[]; method?: "linear"; states?: readonly LinkState[]; limit: number }): Promise<IssueLink[]> {
  let query = db().from("milestones").select("id, status").in("status", [...filter.statuses]);
  if (filter.method) query = query.eq("verification_method", filter.method);
  const result = await query.order("created_at", { ascending: true }).limit(MILESTONE_SCAN);
  if (result.error) raise(result.error);
  const rank = (status: string) => filter.statuses.indexOf(status);
  const ids = ((result.data ?? []) as Array<{ id: string; status: string }>).sort((a, b) => rank(a.status) - rank(b.status)).map((row) => row.id);
  const links: IssueLink[] = [];
  for (let at = 0; at < ids.length && links.length < filter.limit; at += ID_CHUNK) {
    const chunk = ids.slice(at, at + ID_CHUNK);
    // One live link per milestone (0147), kept in the milestones' order.
    const found = new Map((await liveLinks({ milestoneIds: chunk, ...(filter.states ? { states: filter.states } : {}), limit: ID_CHUNK })).map((link) => [link.milestoneId, link]));
    for (const id of chunk) {
      const link = found.get(id);
      if (link && links.length < filter.limit) links.push(link);
    }
  }
  return links;
}

/** A probe: throws `LinearNotSetUpError` before migration 0147 (the connect flow's `ready`). */
export async function linearReady(): Promise<void> {
  const result = await db().rpc("linear_connector_ready");
  if (result.error) raise(result.error);
  const links = await db().from("linear_issue_links").select("id").limit(1);
  if (links.error) raise(links.error);
}

export type InsertOutcome = { ok: true; link: IssueLink } | { ok: false; reason: "milestone_linked" | "issue_linked" };

export async function insertLink(input: {
  milestoneId: string;
  connectionId: string;
  issueId: string;
  identifier: string;
  teamId: string | null;
  teamKey: string | null;
  issueTitle: string;
  issueUrl: string | null;
  by: string;
}): Promise<InsertOutcome> {
  const result = await db()
    .from("linear_issue_links")
    .insert({
      milestone_id: input.milestoneId,
      connection_id: input.connectionId,
      issue_id: input.issueId,
      identifier: input.identifier,
      team_id: input.teamId,
      team_key: input.teamKey,
      issue_title: input.issueTitle.slice(0, 200),
      issue_url: input.issueUrl,
      linked_by: input.by,
    })
    .select(LINK_COLUMNS);
  if (result.error) {
    if (result.error.code === "23505" && /milestone_key/.test(result.error.message)) return { ok: false, reason: "milestone_linked" };
    if (result.error.code === "23505" && /issue_key/.test(result.error.message)) return { ok: false, reason: "issue_linked" };
    raise(result.error);
  }
  return { ok: true, link: toIssueLink(((result.data ?? []) as unknown as LinkRow[])[0]) };
}

/** What a read found, written on the link: its facts, always; its state, when the plan moves it. */
export interface ReadWrite {
  identifier: string;
  teamId: string | null;
  teamKey: string | null;
  issueTitle: string;
  issueUrl: string | null;
  stateType: string | null;
  stateName: string | null;
  completed: boolean;
  completedAt: string | null;
  completedById: string | null;
  completedByName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  archived: boolean;
  deliverables: Deliverable[];
  fingerprint: string;
  attachmentsRead: number;
  commentsRead: number;
  moreUnread: boolean;
  updatedAt: string | null;
}

/**
 * Writes a read's facts, and the new state when given, over the state the read saw: false when the link moved since (a
 * person accepted it, or another read held it), and nothing is written.
 */
export async function writeRead(link: IssueLink, facts: ReadWrite | null, next: { state: Exclude<LinkState, "accepted">; heldReason: HeldReason | null } | null, nowIso: string): Promise<boolean> {
  const values: Record<string, unknown> = { last_read_at: nowIso, read_error: null, updated_at: nowIso };
  if (facts) {
    Object.assign(values, {
      identifier: facts.identifier,
      team_id: facts.teamId,
      team_key: facts.teamKey,
      issue_title: facts.issueTitle.slice(0, 200),
      issue_url: facts.issueUrl,
      state_type: facts.stateType,
      state_name: facts.stateName,
      completed: facts.completed,
      completed_at: facts.completed ? facts.completedAt : null,
      completed_by_id: facts.completed ? facts.completedById : null,
      completed_by_name: facts.completed ? facts.completedByName : null,
      assignee_id: facts.assigneeId,
      assignee_name: facts.assigneeName,
      archived: facts.archived,
      deliverables: facts.deliverables,
      deliverable_fingerprint: facts.fingerprint,
      attachments_read: facts.attachmentsRead,
      comments_read: facts.commentsRead,
      more_unread: facts.moreUnread,
      issue_updated_at: facts.updatedAt,
    });
  }
  if (next && (next.state !== link.state || next.heldReason !== link.heldReason)) {
    Object.assign(values, { state: next.state, held_reason: next.heldReason, held_at: next.state === "held" ? nowIso : null });
  }
  const result = await db().from("linear_issue_links").update(values).eq("id", link.id).eq("state", link.state).is("unlinked_at", null).select("id");
  if (result.error) raise(result.error);
  return (result.data ?? []).length === 1;
}

/** A read that did not finish, said on the link in business words; nothing else changes. */
export async function writeReadError(link: IssueLink, message: string, nowIso: string): Promise<void> {
  const result = await db().from("linear_issue_links").update({ read_error: message.slice(0, 300), updated_at: nowIso }).eq("id", link.id).select("id");
  if (result.error) raise(result.error);
}

/** `hold_linear_acceptance`'s answer. */
export type HoldOutcome = "held" | "held_after_payment" | "deferred" | "not_accepted";

export async function holdAcceptance(link: IssueLink, reason: WithdrawReason): Promise<HoldOutcome> {
  const result = await db().rpc("hold_linear_acceptance", { p_link_id: link.id, p_reason: reason });
  if (result.error) raise(result.error);
  const value = result.data as unknown;
  if (value === "held" || value === "held_after_payment" || value === "deferred" || value === "not_accepted") return value;
  throw new Error("hold_linear_acceptance answered something else");
}

export type AcceptError = "link_not_found" | "already_accepted" | "after_payment" | "not_completed" | "archived" | "stale" | "milestone_not_open" | "no_criteria" | "criteria_changed";

export class AcceptRefusedError extends Error {
  constructor(readonly code: AcceptError) {
    super(code);
    this.name = "AcceptRefusedError";
  }
}

const ACCEPT_CODES: ReadonlySet<string> = new Set(["link_not_found", "already_accepted", "after_payment", "not_completed", "archived", "stale", "milestone_not_open", "no_criteria", "criteria_changed"]);

/** `accept_linear_issue`: the milestone verified by this person's acceptance, or the refusal's code. */
export async function acceptLink(link: IssueLink, input: { by: string; fingerprint: string; criteriaSha256: string; note: string }): Promise<IssueLink> {
  const result = await db()
    .rpc("accept_linear_issue", { p_link_id: link.id, p_by: input.by, p_fingerprint: input.fingerprint, p_criteria_sha256: input.criteriaSha256, p_note: input.note })
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
  const result = await db().from("linear_issue_links").update({ unlinked_at: nowIso, unlinked_by: by, updated_at: nowIso }).eq("id", link.id).is("unlinked_at", null).select("id");
  if (result.error) raise(result.error);
  return (result.data ?? []).length === 1;
}

/** What the acceptance code reads of a milestone: its status, title, criteria and payee, never its amount. */
export interface MilestoneForAcceptance {
  id: string;
  title: string;
  status: string;
  criteria: string | null;
  contractorId: string;
  verificationMethod: string;
  verificationSource: string | null;
}

export async function milestonesForAcceptance(ids: readonly string[]): Promise<Map<string, MilestoneForAcceptance>> {
  if (ids.length === 0) return new Map();
  const result = await db()
    .from("milestones")
    .select("id, title, status, acceptance_criteria, contractor_id, verification_method, verification_source")
    .in("id", [...ids]);
  if (result.error) raise(result.error);
  return new Map(
    ((result.data ?? []) as Array<{ id: string; title: string; status: string; acceptance_criteria: string | null; contractor_id: string; verification_method: string; verification_source: string | null }>).map(
      (row) => [
        row.id,
        {
          id: row.id,
          title: row.title,
          status: row.status,
          criteria: row.acceptance_criteria,
          contractorId: row.contractor_id,
          verificationMethod: row.verification_method,
          verificationSource: row.verification_source,
        },
      ]
    )
  );
}

/**
 * Writes a milestone's acceptance criteria, by a person (LN5): only while the milestone is open and its work not
 * accepted (an accepted milestone keeps the criteria it was accepted against). False when the milestone moved on.
 */
export async function writeCriteria(milestoneId: string, criteria: string, by: string, nowIso: string): Promise<boolean> {
  const result = await db()
    .from("milestones")
    .update({ acceptance_criteria: criteria, acceptance_criteria_by: by, acceptance_criteria_at: nowIso })
    .eq("id", milestoneId)
    .eq("status", "pending")
    .select("id");
  if (result.error) raise(result.error);
  return (result.data ?? []).length === 1;
}
