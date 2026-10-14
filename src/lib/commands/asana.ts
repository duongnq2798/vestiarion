import crypto from "node:crypto";
import { runCycleSoon } from "../agent/cycle-soon";
import { parseGitHubPullRequestUrl } from "../github-verification";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { acceptable, planRead, selfAcceptance, SELF_WORDS, stateWords, type Identities } from "../asana/acceptance";
import {
  acceptLink,
  AcceptRefusedError,
  AsanaNotSetUpError,
  factsOf,
  holdAcceptance,
  insertLink,
  liveLinks,
  milestonesForAcceptance,
  unlinkLink,
  writeCriteria,
  writeRead,
  type AcceptError,
  type TaskLink,
} from "../asana/links";
import type { AsanaProvider } from "../asana/provider";
import { identitiesOf } from "../asana/identities";
import { factsFromRead, readFailureWords, readLink } from "../asana/reads";
import { ProviderError } from "../connectors/provider";
import { AsanaAccessError } from "../asana/session";
import { taskRefOf } from "../asana/urls";
import { asanaContext, markReconnect, needsReconnect, startWebhook, stopWebhooks, type AsanaContext } from "../asana/workspace";
import { cycleEventOf, type Actor } from "./actor";
import { done, refused, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * Contractor work accepted from Asana, from the console (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md
 * A4, A5, A8, A9): linking a milestone to the Asana task its work is delivered in, writing the criteria it is held to,
 * accepting the work, and unlinking it. Each reads the person's role first (`gate`), works in the workspace's scope, and
 * writes nothing to a milestone but its criteria and, through `accept_asana_task` and `hold_asana_acceptance`, its
 * verification. The agent decides the payment afterwards, under every guardrail, as for any verified milestone.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const MISSING_WORDS = {
  off: "Asana is not set up on this deployment.",
  not_set_up: "Asana is not set up on this deployment yet.",
  not_connected: "Asana is not connected to this workspace. An owner or admin connects it in Settings.",
  reconnect: "Asana needs to be reconnected. An owner or admin reconnects it in Settings.",
} as const;

/** The workspace's Asana, ready to call, or the refusal saying why not. */
async function context(provider?: AsanaProvider | null): Promise<AsanaContext | Refused> {
  const found = await asanaContext(provider);
  return "missing" in found ? refused(found.missing === "off" || found.missing === "not_set_up" ? "not_set_up" : "not_connected", MISSING_WORDS[found.missing]) : found;
}

/** A connection-level failure: the connection is marked when it needs a person, and the person is told. */
async function accessRefusal(ctx: AsanaContext, error: unknown): Promise<Refused> {
  if (needsReconnect(error)) await markReconnect(ctx.connection, new Date().toISOString());
  if (!(error instanceof AsanaAccessError) && !(error instanceof ProviderError)) {
    console.error("asana: a call failed", error instanceof Error ? error.message : "unknown error");
  }
  return refused("asana_unavailable", readFailureWords(error));
}

/** A call to Asana that failed: the connection's or Asana's answer, said to the person; anything else is a bug. */
const asanaFailure = (error: unknown) => error instanceof AsanaAccessError || error instanceof ProviderError;

function notSetUp(error: unknown): Refused | null {
  return error instanceof AsanaNotSetUpError ? refused("not_set_up", MISSING_WORDS.not_set_up) : null;
}

/** Runs after the answer when a request is there (`after()`), and at once in a script or a test. */
export type Defer = (work: () => Promise<void>) => void;

export async function linkAsanaTask(
  actor: Actor,
  input: { milestoneId: string; taskUrl?: string; pick?: { workspaceGid: string; projectGid: string | null; taskGid: string } },
  deps: { provider?: AsanaProvider | null; defer?: Defer } = {}
): Promise<CommandOutcome<{ linkId: string; state: string }>> {
  const refusal = gate(actor, "milestone.link_task");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  // A pasted link is read for its ids only, and never opened (A4, A13).
  const ref = input.pick
    ? { taskGid: input.pick.taskGid, projectGid: input.pick.projectGid, workspaceGid: input.pick.workspaceGid }
    : input.taskUrl
      ? taskRefOf(input.taskUrl)
      : null;
  if (!ref || !/^[0-9]{1,32}$/.test(ref.taskGid)) return refused("bad_task", "That is not a link to an Asana task. Copy it from the task's Copy task link.");
  try {
    const ctx = await context(deps.provider);
    if ("ok" in ctx) return ctx;
    const milestone = (await milestonesForAcceptance([input.milestoneId])).get(input.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    if (milestone.status !== "pending") {
      return refused("milestone_not_open", milestone.status === "paid" || milestone.status === "closed" ? "This milestone is done: nothing is linked to it now." : "This milestone is verified already. Revoke its verification first to accept it from Asana.");
    }
    // A merged pull request verifies its milestone on its own (GitHub check): one milestone is not verified two ways.
    if (parseGitHubPullRequestUrl(milestone.verificationSource)) return refused("github", "This milestone is verified by its GitHub pull request. Add a new milestone to accept work from Asana.");
    if ((await liveLinks({ milestoneIds: [milestone.id] })).length > 0) return refused("milestone_linked", "This milestone is linked to an Asana task already. Unlink it first.");

    let read;
    try {
      read = await ctx.session.call((token) => ctx.provider.reader.task(token, ref.taskGid));
    } catch (error) {
      return await accessRefusal(ctx, error);
    }
    if (read.kind === "gone") return refused("task_not_found", "Asana does not show that task to the connected account. Check the link, or ask whoever connected Asana to open the project.");
    const facts = factsFromRead(read);
    const inserted = await insertLink({
      milestoneId: milestone.id,
      connectionId: ctx.connection.id,
      workspaceGid: read.task.workspaceGid ?? ref.workspaceGid ?? "0",
      projectGid: ref.projectGid ?? read.task.projectGids[0] ?? null,
      taskGid: read.task.gid,
      taskName: read.task.name,
      taskUrl: read.task.url,
      by: actor.userId,
    });
    if (!inserted.ok) {
      return inserted.reason === "task_linked"
        ? refused("task_linked", "That Asana task is linked to another milestone already: one task verifies one milestone.")
        : refused("milestone_linked", "This milestone is linked to an Asana task already. Unlink it first.");
    }
    const link = inserted.link;
    const plan = planRead(factsOf(link), facts.plan, { criteria: milestone.criteria !== null });
    const next = plan.kind === "set" ? { state: plan.state, heldReason: plan.heldReason } : null;
    await writeRead(link, facts.write, next, new Date().toISOString());
    await appendLedgerEntryBestEffort(actor.orgId, {
      actor: "human",
      domain: "contractor",
      action: "asana_task_linked",
      summary: `Linked milestone “${milestone.title}” to the Asana task “${read.task.name}”`,
      detail: {
        by: actor.userId,
        milestoneId: milestone.id,
        linkId: link.id,
        taskGid: read.task.gid,
        workspaceGid: read.task.workspaceGid,
        projectGid: ref.projectGid ?? read.task.projectGids[0] ?? null,
        taskUrl: read.task.url,
        completed: read.task.completed,
        fingerprint: facts.write.fingerprint,
      },
    });
    // The webhook is made after the answer: Asana's handshake comes back to this deployment while it is asked.
    (deps.defer ?? ((work) => void work()))(async () => {
      await startWebhook(link, ctx).catch((error: unknown) => console.error("asana: the webhook was not made", link.id, error instanceof Error ? error.message : "unknown error"));
    });
    const state = next?.state ?? link.state;
    const words = stateWords(state, next?.heldReason ?? null, false);
    return done(`Linked to “${read.task.name}”. ${words.label}: ${words.line}`, { linkId: link.id, state });
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}

export async function unlinkAsanaTask(actor: Actor, input: { milestoneId: string }, deps: { provider?: AsanaProvider | null; defer?: Defer } = {}): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.unlink_task");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  try {
    const link = (await liveLinks({ milestoneIds: [input.milestoneId] }))[0];
    if (!link) return refused("not_linked", "This milestone is not linked to an Asana task.");
    const milestone = (await milestonesForAcceptance([link.milestoneId])).get(link.milestoneId);
    // An accepted milestone the agent has not paid loses its acceptance with its task (A10): the same hold a reopened task gets.
    let withdrew = false;
    if (link.state === "accepted") {
      const held = await holdAcceptance(link, "unlinked");
      if (held === "deferred") return refused("deciding", "Someone is deciding this milestone's payment right now. Try again in a few minutes.");
      withdrew = held === "held";
    }
    if (!(await unlinkLink(link, actor.userId, new Date().toISOString()))) return refused("not_linked", "This milestone is not linked to an Asana task.");
    await appendLedgerEntryBestEffort(actor.orgId, {
      actor: "human",
      domain: "contractor",
      action: "asana_task_unlinked",
      summary: `Unlinked milestone “${milestone?.title ?? link.taskName}” from the Asana task “${link.taskName}”${withdrew ? ", taking its acceptance back" : ""}`,
      detail: { by: actor.userId, milestoneId: link.milestoneId, linkId: link.id, taskGid: link.taskGid, withdrewAcceptance: withdrew },
    });
    const found = await asanaContext(deps.provider);
    (deps.defer ?? ((work) => void work()))(async () => {
      await stopWebhooks("missing" in found ? { provider: null, session: null } : found, { linkId: link.id }).catch(() => 0);
    });
    return done(withdrew ? "Unlinked. Its acceptance was taken back: the milestone waits for verification again." : "Unlinked from Asana.");
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}

/** Criteria a person writes: 3 to 2000 characters, lines kept. */
export const CRITERIA_MIN = 3;
export const CRITERIA_MAX = 2000;

export async function setAcceptanceCriteria(actor: Actor, input: { milestoneId: string; criteria: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.set_criteria");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  const criteria = input.criteria.replace(/\r\n/g, "\n").trim();
  if (criteria.length < CRITERIA_MIN || criteria.length > CRITERIA_MAX) return refused("criteria", `Write the acceptance criteria from the agreement: ${CRITERIA_MIN} to ${CRITERIA_MAX} characters.`);
  try {
    const milestone = (await milestonesForAcceptance([input.milestoneId])).get(input.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    const link = (await liveLinks({ milestoneIds: [milestone.id] }))[0] ?? null;
    if (link?.state === "accepted") return refused("accepted", "The work was accepted against these criteria. Unlink the task to change them.");
    if (!(await writeCriteria(milestone.id, criteria, actor.userId, new Date().toISOString()))) {
      return refused("milestone_not_open", "Criteria are written while the milestone waits for verification.");
    }
    await appendLedgerEntryBestEffort(actor.orgId, {
      actor: "human",
      domain: "contractor",
      action: "milestone_criteria_set",
      summary: `Set the acceptance criteria of milestone “${milestone.title}”`,
      detail: { by: actor.userId, milestoneId: milestone.id, criteria, criteriaSha256: sha256(criteria), previousSha256: milestone.criteria ? sha256(milestone.criteria) : null },
    });
    // A completed task held for want of criteria is ready for acceptance now, from what was last read of it.
    if (link && link.completed && link.state === "held" && link.heldReason === "no_criteria" && link.fingerprint) {
      await writeRead(link, null, { state: "ready", heldReason: null }, new Date().toISOString());
    }
    return done("Criteria saved. They are what the work is accepted against.");
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}

const ACCEPT_WORDS: Record<AcceptError, string> = {
  link_not_found: "This milestone is not linked to an Asana task.",
  already_accepted: "This work was accepted already.",
  after_payment: "A payment for this milestone was sent before the task changed. Review it with the contractor.",
  not_completed: "The task is not completed in Asana, so there is nothing to accept yet.",
  stale: "The deliverables changed in Asana since you opened this. Look at them again before accepting.",
  milestone_not_open: "This milestone is not waiting for verification any more.",
  no_criteria: "Add the acceptance criteria from the agreement first.",
  criteria_changed: "The acceptance criteria changed since you opened this. Read them again before accepting.",
};

export async function acceptMilestoneWork(
  actor: Actor,
  input: { milestoneId: string; fingerprint: string; criteriaSha256: string; confirmed: boolean },
  deps: { provider?: AsanaProvider | null } = {}
): Promise<CommandOutcome<{ status: string }>> {
  const refusal = gate(actor, "milestone.accept");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId) || !/^[0-9a-f]{64}$/.test(input.fingerprint) || !/^[0-9a-f]{64}$/.test(input.criteriaSha256)) return refused("not_found", "Milestone not found.");
  if (!input.confirmed) return refused("confirm", "Tick that you checked each criterion against these deliverables.");
  try {
    const ctx = await context(deps.provider);
    if ("ok" in ctx) return ctx;
    const link = (await liveLinks({ milestoneIds: [input.milestoneId] }))[0];
    if (!link) return refused("not_linked", ACCEPT_WORDS.link_not_found);
    const milestone = (await milestonesForAcceptance([link.milestoneId])).get(link.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    // What Asana says right now, not what it said when the page was drawn.
    let read;
    try {
      read = await readLink(link, { title: milestone.title, criteria: milestone.criteria !== null }, { session: ctx.session, reader: ctx.provider.reader });
    } catch (error) {
      if (asanaFailure(error)) return await accessRefusal(ctx, error);
      throw error;
    }
    if (read.kind === "failed") return refused("asana_unavailable", read.message);
    const fresh = (await liveLinks({ milestoneIds: [link.milestoneId] }))[0];
    if (!fresh) return refused("not_linked", ACCEPT_WORDS.link_not_found);
    if (fresh.fingerprint !== input.fingerprint) return refused("stale", ACCEPT_WORDS.stale, { changed: true });
    if (!acceptable(fresh, { completed: fresh.completed, criteria: milestone.criteria !== null, milestoneStatus: milestone.status })) {
      const words = stateWords(fresh.state, fresh.heldReason, fresh.afterPayment);
      return refused("not_ready", fresh.state === "accepted" ? ACCEPT_WORDS.already_accepted : `${words.label}. ${words.line}`, { changed: true });
    }
    // The contractor or payee never accepts their own work (A9).
    let who: Identities;
    try {
      who = await identitiesOf(actor, milestone, ctx);
    } catch (error) {
      if (asanaFailure(error)) return await accessRefusal(ctx, error);
      throw error;
    }
    const self = selfAcceptance(who);
    if (self) return refused("self_acceptance", SELF_WORDS[self]);

    let accepted: TaskLink;
    try {
      accepted = await acceptLink(fresh, {
        by: actor.userId,
        fingerprint: input.fingerprint,
        criteriaSha256: input.criteriaSha256,
        note: `Accepted by a person against the milestone's acceptance criteria; the Asana task was completed${fresh.completedAt ? ` on ${fresh.completedAt.slice(0, 10)}` : ""}.`,
      });
    } catch (error) {
      if (error instanceof AcceptRefusedError) {
        return refused(error.code, ACCEPT_WORDS[error.code], error.code === "stale" || error.code === "criteria_changed" ? { changed: true } : {});
      }
      throw error;
    }
    await appendLedgerEntryBestEffort(actor.orgId, {
      actor: "human",
      domain: "contractor",
      action: "milestone_accepted",
      summary: `Accepted the work of milestone “${milestone.title}” against its criteria, from the Asana task “${accepted.taskName}”`,
      detail: {
        by: actor.userId,
        milestoneId: milestone.id,
        linkId: accepted.id,
        taskGid: accepted.taskGid,
        taskUrl: accepted.taskUrl,
        completedAt: accepted.completedAt,
        completedByName: accepted.completedByName,
        fingerprint: input.fingerprint,
        deliverables: (accepted.acceptedDeliverables ?? accepted.deliverables).map((item) => ({ kind: item.kind, label: item.label, href: item.href })),
        criteriaSha256: input.criteriaSha256,
        payeeAsanaMapped: who.payeeAsanaGid !== null,
      },
    });
    // A verified milestone not yet paid is one the agent decides, under every guardrail, within a minute.
    runCycleSoon(cycleEventOf(actor, "milestone_verified"));
    return done("Accepted. The agent decides on pay within a minute, under every guardrail.", { status: "verified" });
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}

/** Reads one linked task again now (Check Asana now). */
export async function checkAsanaTask(actor: Actor, input: { milestoneId: string }, deps: { provider?: AsanaProvider | null } = {}): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.check_task");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  try {
    const ctx = await context(deps.provider);
    if ("ok" in ctx) return ctx;
    const link = (await liveLinks({ milestoneIds: [input.milestoneId] }))[0];
    if (!link) return refused("not_linked", ACCEPT_WORDS.link_not_found);
    const milestone = (await milestonesForAcceptance([link.milestoneId])).get(link.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    try {
      const read = await readLink(link, { title: milestone.title, criteria: milestone.criteria !== null }, { session: ctx.session, reader: ctx.provider.reader });
      if (read.kind === "failed") return refused("asana_unavailable", read.message, { changed: true });
    } catch (error) {
      if (asanaFailure(error)) return await accessRefusal(ctx, error);
      throw error;
    }
    const fresh = (await liveLinks({ milestoneIds: [link.milestoneId] }))[0];
    const words = fresh ? stateWords(fresh.state, fresh.heldReason, fresh.afterPayment) : null;
    return done(words ? `Read from Asana. ${words.label}.` : "Read from Asana.");
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}
