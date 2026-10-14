import { db } from "../dal";
import type { HeldReason, LinkFacts, LinkState, WithdrawReason } from "./acceptance";
import { deliverablesFrom, type Deliverable } from "./deliverables";

/**
 * The tasks linked to milestones (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A3, A4, A8, A10), read
 * and written through the DAL in the workspace's own scope. Every write to a link's state compares the state it read,
 * so a read that raced a person's acceptance changes nothing. The milestone itself is touched only by the two database
 * functions of migration 0115, `accept_asana_task` and `hold_asana_acceptance`, and only in its verification: never an
 * amount, a payee or an address. Before 0115 has run, a read says Asana is not set up rather than failing.
 */

export interface TaskLink {
  id: string;
  milestoneId: string;
  connectionId: string;
  workspaceGid: string;
  projectGid: string | null;
  taskGid: string;
  taskName: string;
  taskUrl: string | null;
  state: LinkState;
  heldReason: HeldReason | null;
  afterPayment: boolean;
  heldAt: string | null;
  completed: boolean;
  completedAt: string | null;
  completedByGid: string | null;
  completedByName: string | null;
  assigneeName: string | null;
  deliverables: Deliverable[];
  fingerprint: string | null;
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
  workspace_gid: string;
  project_gid: string | null;
  task_gid: string;
  task_name: string;
  task_url: string | null;
  state: LinkState;
  held_reason: HeldReason | null;
  after_payment: boolean;
  held_at: string | null;
  completed: boolean;
  completed_at: string | null;
  completed_by_gid: string | null;
  completed_by_name: string | null;
  assignee_name: string | null;
  deliverables: unknown;
  deliverable_fingerprint: string | null;
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
  "id, milestone_id, connection_id, workspace_gid, project_gid, task_gid, task_name, task_url, state, held_reason, after_payment, held_at, completed, completed_at, completed_by_gid, completed_by_name, assignee_name, deliverables, deliverable_fingerprint, last_read_at, read_error, accepted_by, accepted_at, accepted_fingerprint, accepted_completed_at, accepted_deliverables, linked_at";

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

export function toTaskLink(row: LinkRow): TaskLink {
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    connectionId: row.connection_id,
    workspaceGid: row.workspace_gid,
    projectGid: row.project_gid,
    taskGid: row.task_gid,
    taskName: row.task_name,
    taskUrl: row.task_url,
    state: row.state,
    heldReason: row.held_reason,
    afterPayment: row.after_payment === true,
    heldAt: iso(row.held_at),
    completed: row.completed === true,
    completedAt: iso(row.completed_at),
    completedByGid: row.completed_by_gid,
    completedByName: row.completed_by_name,
    assigneeName: row.assignee_name,
    deliverables: deliverablesFrom(row.deliverables),
    fingerprint: row.deliverable_fingerprint,
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

export function factsOf(link: TaskLink): LinkFacts {
  return {
    state: link.state,
    heldReason: link.heldReason,
    acceptedAt: link.acceptedAt,
    acceptedFingerprint: link.acceptedFingerprint,
    acceptedCompletedAt: link.acceptedCompletedAt,
    afterPayment: link.afterPayment,
  };
}

/** A table, column or function migration 0115 adds, missing because it has not run here yet. */
export function isAsanaNotSetUp(error: { code?: string | null; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code && ["PGRST205", "PGRST202", "PGRST204", "42P01", "42703", "42883"].includes(error.code)) return true;
  return /could not find the (table|function|column)|does not exist/i.test(error.message ?? "");
}

/** Asana's tables are not in this database yet (migration 0115). */
export class AsanaNotSetUpError extends Error {
  constructor() {
    super("The Asana tables are not in this database yet");
    this.name = "AsanaNotSetUpError";
  }
}

function raise(error: { code?: string | null; message: string }): never {
  if (isAsanaNotSetUp(error)) throw new AsanaNotSetUpError();
  throw new Error(error.message);
}

/** The live links (not unlinked), of these milestones or this connection, or all of them; at most `limit`. */
export async function liveLinks(filter: { milestoneIds?: readonly string[]; connectionId?: string; states?: readonly LinkState[]; limit?: number } = {}): Promise<TaskLink[]> {
  if (filter.milestoneIds && filter.milestoneIds.length === 0) return [];
  let query = db().from("asana_task_links").select(LINK_COLUMNS).is("unlinked_at", null);
  if (filter.milestoneIds) query = query.in("milestone_id", [...filter.milestoneIds]);
  if (filter.connectionId) query = query.eq("connection_id", filter.connectionId);
  if (filter.states) query = query.in("state", [...filter.states]);
  const result = await query.order("linked_at", { ascending: true }).limit(filter.limit ?? 200);
  if (result.error) raise(result.error);
  return ((result.data ?? []) as unknown as LinkRow[]).map(toTaskLink);
}

export async function linkById(id: string): Promise<TaskLink | null> {
  const result = await db().from("asana_task_links").select(LINK_COLUMNS).eq("id", id).is("unlinked_at", null).limit(1);
  if (result.error) raise(result.error);
  const row = ((result.data ?? []) as unknown as LinkRow[])[0];
  return row ? toTaskLink(row) : null;
}

/** A probe: throws `AsanaNotSetUpError` before migration 0115 (the connect flow's `ready`). */
export async function asanaReady(): Promise<void> {
  const result = await db().from("asana_task_links").select("id").limit(1);
  if (result.error) raise(result.error);
  const criteria = await db().from("milestones").select("acceptance_criteria").limit(1);
  if (criteria.error) raise(criteria.error);
}

export type InsertOutcome = { ok: true; link: TaskLink } | { ok: false; reason: "milestone_linked" | "task_linked" };

export async function insertLink(input: {
  milestoneId: string;
  connectionId: string;
  workspaceGid: string;
  projectGid: string | null;
  taskGid: string;
  taskName: string;
  taskUrl: string | null;
  by: string;
}): Promise<InsertOutcome> {
  const result = await db()
    .from("asana_task_links")
    .insert({
      milestone_id: input.milestoneId,
      connection_id: input.connectionId,
      workspace_gid: input.workspaceGid,
      project_gid: input.projectGid,
      task_gid: input.taskGid,
      task_name: input.taskName.slice(0, 200),
      task_url: input.taskUrl,
      linked_by: input.by,
    })
    .select(LINK_COLUMNS);
  if (result.error) {
    if (result.error.code === "23505" && /milestone_key/.test(result.error.message)) return { ok: false, reason: "milestone_linked" };
    if (result.error.code === "23505" && /task_key/.test(result.error.message)) return { ok: false, reason: "task_linked" };
    raise(result.error);
  }
  return { ok: true, link: toTaskLink(((result.data ?? []) as unknown as LinkRow[])[0]) };
}

/** What a read found, written on the link: its facts, always; its state, when the plan moves it. */
export interface ReadWrite {
  taskName: string;
  taskUrl: string | null;
  completed: boolean;
  completedAt: string | null;
  completedByGid: string | null;
  completedByName: string | null;
  assigneeGid: string | null;
  assigneeName: string | null;
  deliverables: Deliverable[];
  fingerprint: string;
  modifiedAt: string | null;
}

/**
 * Writes a read's facts, and the new state when given, over the state the read saw: false when the link moved since (a
 * person accepted it, or another read held it), and nothing is written.
 */
export async function writeRead(link: TaskLink, facts: ReadWrite | null, next: { state: Exclude<LinkState, "accepted">; heldReason: HeldReason | null } | null, nowIso: string): Promise<boolean> {
  const values: Record<string, unknown> = { last_read_at: nowIso, read_error: null, updated_at: nowIso };
  if (facts) {
    Object.assign(values, {
      task_name: facts.taskName.slice(0, 200),
      task_url: facts.taskUrl,
      completed: facts.completed,
      completed_at: facts.completed ? facts.completedAt : null,
      completed_by_gid: facts.completed ? facts.completedByGid : null,
      completed_by_name: facts.completed ? facts.completedByName : null,
      assignee_gid: facts.assigneeGid,
      assignee_name: facts.assigneeName,
      deliverables: facts.deliverables,
      deliverable_fingerprint: facts.fingerprint,
      task_modified_at: facts.modifiedAt,
    });
  }
  if (next && (next.state !== link.state || next.heldReason !== link.heldReason)) {
    Object.assign(values, { state: next.state, held_reason: next.heldReason, held_at: next.state === "held" ? nowIso : null });
  }
  const result = await db().from("asana_task_links").update(values).eq("id", link.id).eq("state", link.state).is("unlinked_at", null).select("id");
  if (result.error) raise(result.error);
  return (result.data ?? []).length === 1;
}

/** A read that did not finish, said on the link in business words; nothing else changes. */
export async function writeReadError(link: TaskLink, message: string, nowIso: string): Promise<void> {
  const result = await db().from("asana_task_links").update({ read_error: message.slice(0, 300), updated_at: nowIso }).eq("id", link.id).select("id");
  if (result.error) raise(result.error);
}

/** `hold_asana_acceptance`'s answer. */
export type HoldOutcome = "held" | "held_after_payment" | "deferred" | "not_accepted";

export async function holdAcceptance(link: TaskLink, reason: WithdrawReason): Promise<HoldOutcome> {
  const result = await db().rpc("hold_asana_acceptance", { p_link_id: link.id, p_reason: reason });
  if (result.error) raise(result.error);
  const value = result.data as unknown;
  if (value === "held" || value === "held_after_payment" || value === "deferred" || value === "not_accepted") return value;
  throw new Error("hold_asana_acceptance answered something else");
}

export type AcceptError = "link_not_found" | "already_accepted" | "after_payment" | "not_completed" | "stale" | "milestone_not_open" | "no_criteria" | "criteria_changed";

export class AcceptRefusedError extends Error {
  constructor(readonly code: AcceptError) {
    super(code);
    this.name = "AcceptRefusedError";
  }
}

const ACCEPT_CODES: ReadonlySet<string> = new Set(["link_not_found", "already_accepted", "after_payment", "not_completed", "stale", "milestone_not_open", "no_criteria", "criteria_changed"]);

/** `accept_asana_task`: the milestone verified by this person's acceptance, or the refusal's code. */
export async function acceptLink(link: TaskLink, input: { by: string; fingerprint: string; criteriaSha256: string; note: string }): Promise<TaskLink> {
  const result = await db()
    .rpc("accept_asana_task", { p_link_id: link.id, p_by: input.by, p_fingerprint: input.fingerprint, p_criteria_sha256: input.criteriaSha256, p_note: input.note })
    .single();
  if (result.error) {
    const code = /^([a-z_]+):/.exec(result.error.message)?.[1];
    if (code && ACCEPT_CODES.has(code)) throw new AcceptRefusedError(code as AcceptError);
    raise(result.error);
  }
  return toTaskLink(result.data as unknown as LinkRow);
}

/** Unlinks a task: kept, with who and when, so the history stays. False when it was unlinked already. */
export async function unlinkLink(link: TaskLink, by: string, nowIso: string): Promise<boolean> {
  const result = await db().from("asana_task_links").update({ unlinked_at: nowIso, unlinked_by: by, updated_at: nowIso }).eq("id", link.id).is("unlinked_at", null).select("id");
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
 * Writes a milestone's acceptance criteria, by a person (A5): only while the milestone is open and its work not accepted
 * (an accepted milestone keeps the criteria it was accepted against). False when the milestone moved on.
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
