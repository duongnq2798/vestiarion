import { currentOrgId } from "../context";
import { ProviderError } from "../connectors/provider";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { planRead, type ReadFacts, type ReadPlan } from "./acceptance";
import type { AsanaReader, TaskRead } from "./api";
import { deliverablesOf, fingerprintOf } from "./deliverables";
import { factsOf, holdAcceptance, milestonesForAcceptance, writeRead, writeReadError, type HoldOutcome, type ReadWrite, type TaskLink } from "./links";
import { AsanaAccessError, type AsanaSession } from "./session";

/**
 * Reading a linked task again (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A6, A7, A10, A11): the
 * one path every re-read takes, whatever asked for it (a signed webhook delivery, the agent's cycle before it decides
 * contractors, the contractor stage right before it sends releases, the sweeper every 15 minutes, Check Asana now, or a
 * person about to accept). The task is read through
 * Asana's API with the connection's token; its facts are written on the link; the plan moves the link; and an
 * acceptance the task no longer bears out is taken back through `hold_asana_acceptance`, which holds the milestone for
 * review before any payment executes. A read that fails changes nothing but the words on the link.
 */

export interface ReadContext {
  session: AsanaSession;
  reader: AsanaReader;
  now?: () => number;
}

export type LinkReadOutcome =
  | { kind: "read"; plan: ReadPlan; held: HoldOutcome | null; becameReady: boolean; fingerprint: string }
  | { kind: "failed"; message: string };

/** The facts a read writes on the link, and what the plan compares. */
export function factsFromRead(read: Extract<TaskRead, { kind: "task" }>): { write: ReadWrite; plan: Extract<ReadFacts, { kind: "task" }> } {
  const { deliverables, more } = deliverablesOf({ notes: read.task.notes, attachments: read.attachments, comments: read.comments, taskUrl: read.task.url });
  const fingerprint = fingerprintOf(deliverables, more);
  return {
    write: {
      taskName: read.task.name,
      taskUrl: read.task.url,
      completed: read.task.completed,
      completedAt: read.task.completedAt,
      completedByGid: read.task.completedBy?.gid ?? null,
      completedByName: read.task.completedBy?.name ?? null,
      assigneeGid: read.task.assignee?.gid ?? null,
      assigneeName: read.task.assignee?.name ?? null,
      deliverables,
      fingerprint,
      modifiedAt: read.task.modifiedAt,
    },
    plan: { kind: "task", completed: read.task.completed, completedAt: read.task.completedAt, fingerprint },
  };
}

/** A failed read, in the words the card shows. */
export function readFailureWords(error: unknown): string {
  if (error instanceof AsanaAccessError) {
    return error.outcome.reason === "reconnect" || error.outcome.reason === "missing"
      ? "Asana no longer accepts the connection. Reconnect Asana in Settings."
      : "Asana did not answer just now. It is read again within 15 minutes.";
  }
  if (error instanceof ProviderError) {
    if (error.failure === "rate_limited") return "Asana asked Vestiarion to slow down. It is read again within 15 minutes.";
    if (error.failure === "forbidden" || error.failure === "unauthorized") return "Asana refused the connection. Reconnect Asana in Settings.";
    if (error.failure === "bad_response") return "Asana's answer could not be read. It is read again within 15 minutes.";
    return "Asana did not answer just now. It is read again within 15 minutes.";
  }
  return "The task could not be read just now. It is read again within 15 minutes.";
}

const REASON_WORDS = { reopened: "was reopened", deliverable_changed: "changed its deliverables", task_unreachable: "can no longer be read", unlinked: "was unlinked" } as const;

/**
 * Reads one link's task and applies what it says. `criteria` is whether the milestone has acceptance criteria now.
 * Throws `AsanaAccessError` when the connection itself failed (the caller decides what the connection says); any other
 * failure is written on the link and answered as `failed`.
 */
export async function readLink(link: TaskLink, milestone: { title: string; criteria: boolean }, ctx: ReadContext): Promise<LinkReadOutcome> {
  const now = ctx.now ?? Date.now;
  const nowIso = new Date(now()).toISOString();
  let read: TaskRead;
  try {
    read = await ctx.session.call((token) => ctx.reader.task(token, link.taskGid));
  } catch (error) {
    const message = readFailureWords(error);
    await writeReadError(link, message, nowIso);
    if (error instanceof AsanaAccessError) throw error;
    if (!(error instanceof ProviderError)) console.error("asana: a task read failed", link.id, error instanceof Error ? error.message : "unknown error");
    return { kind: "failed", message };
  }

  const found = read.kind === "task" ? factsFromRead(read) : null;
  const facts: ReadFacts = found ? found.plan : { kind: "gone", reason: read.kind === "gone" ? read.reason : "not_found" };
  const plan = planRead(factsOf(link), facts, { criteria: milestone.criteria });
  const fingerprint = found?.write.fingerprint ?? link.fingerprint ?? "";

  if (plan.kind === "withdraw") {
    const held = await holdAcceptance(link, plan.reason);
    // The link is held now (or still accepted, when a person is deciding the milestone): its facts are written over that.
    const heldNow = held === "held" || held === "held_after_payment" ? { ...link, state: "held" as const, heldReason: plan.reason } : link;
    await writeRead(heldNow, found?.write ?? null, null, nowIso);
    if (held === "held" || held === "held_after_payment") {
      await appendLedgerEntryBestEffort(currentOrgId(), {
        actor: "system",
        domain: "contractor",
        action: "milestone_acceptance_withdrawn",
        summary:
          held === "held"
            ? `Took back the acceptance of milestone “${milestone.title}”: its Asana task ${REASON_WORDS[plan.reason]} before payment. Held for review`
            : `The Asana task of milestone “${milestone.title}” ${REASON_WORDS[plan.reason]} after its payment was sent. Held for review`,
        detail: {
          milestoneId: link.milestoneId,
          linkId: link.id,
          taskGid: link.taskGid,
          reason: plan.reason,
          afterPayment: held === "held_after_payment",
          acceptedFingerprint: link.acceptedFingerprint,
          fingerprint: found ? found.write.fingerprint : null,
          completed: found ? found.write.completed : null,
          completedAt: found ? found.write.completedAt : null,
        },
      });
    }
    return { kind: "read", plan, held, becameReady: false, fingerprint };
  }

  const wrote = await writeRead(link, found?.write ?? null, plan.kind === "set" ? { state: plan.state, heldReason: plan.heldReason } : null, nowIso);
  const becameReady = wrote && plan.kind === "set" && plan.becameReady;
  if (becameReady && found) {
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "system",
      domain: "contractor",
      action: "asana_task_ready",
      summary: `The Asana task of milestone “${milestone.title}” was completed: ready for a person to accept the work against its criteria`,
      detail: {
        milestoneId: link.milestoneId,
        linkId: link.id,
        taskGid: link.taskGid,
        completedAt: found.write.completedAt,
        completedByName: found.write.completedByName,
        fingerprint: found.write.fingerprint,
        deliverables: found.write.deliverables.length,
      },
    });
  }
  return { kind: "read", plan, held: null, becameReady, fingerprint };
}

export interface ReadSummary {
  read: number;
  failed: number;
  ready: number;
  withdrawn: number;
  deferred: number;
}

/**
 * Reads these links, one after another, until `budgetMs` is spent; links whose milestone was paid or closed are left
 * alone. Stops at the first connection failure, which it throws.
 */
export async function readLinks(links: readonly TaskLink[], ctx: ReadContext & { budgetMs?: number }): Promise<ReadSummary> {
  const now = ctx.now ?? Date.now;
  const started = now();
  const summary: ReadSummary = { read: 0, failed: 0, ready: 0, withdrawn: 0, deferred: 0 };
  if (links.length === 0) return summary;
  const milestones = await milestonesForAcceptance([...new Set(links.map((link) => link.milestoneId))]);
  for (const link of links) {
    if (ctx.budgetMs !== undefined && now() - started > ctx.budgetMs) break;
    const milestone = milestones.get(link.milestoneId);
    if (!milestone || milestone.status === "paid" || milestone.status === "closed") continue;
    const outcome = await readLink(link, { title: milestone.title, criteria: milestone.criteria !== null }, ctx);
    if (outcome.kind === "failed") {
      summary.failed += 1;
      continue;
    }
    summary.read += 1;
    if (outcome.becameReady) summary.ready += 1;
    if (outcome.held === "held" || outcome.held === "held_after_payment") summary.withdrawn += 1;
    if (outcome.held === "deferred") summary.deferred += 1;
  }
  return summary;
}
