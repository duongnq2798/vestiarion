import crypto from "node:crypto";
import { runCycleSoon } from "../agent/cycle-soon";
import { AsanaNotSetUpError, liveLinks as asanaLinks } from "../asana/links";
import { ProviderError } from "../connectors/provider";
import { parseGitHubPullRequestUrl } from "../github-verification";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { ACCEPTED_ACTION, acceptable, planRead, selfAcceptance, SELF_WORDS, stateWords, type Identities } from "../linear/acceptance";
import { identitiesOf } from "../linear/identities";
import {
  acceptLink,
  AcceptRefusedError,
  factsOf,
  holdAcceptance,
  insertLink,
  LinearNotSetUpError,
  liveLinks,
  milestonesForAcceptance,
  unlinkLink,
  writeCriteria,
  writeRead,
  type AcceptError,
  type IssueLink,
} from "../linear/links";
import type { LinearProvider } from "../linear/provider";
import { factsFromRead, readFailureWords, readLink } from "../linear/reads";
import { LinearAccessError } from "../linear/session";
import { issueRefOf } from "../linear/urls";
import { linearContext, markReconnect, needsReconnect, type LinearContext } from "../linear/workspace";
import { cycleEventOf, type Actor } from "./actor";
import { CRITERIA_MAX, CRITERIA_MIN } from "./asana";
import { done, refused, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * Contractor work accepted from Linear, from the console (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md
 * LN4, LN5, LN8, LN9), as Asana's commands (`./asana`): linking a milestone to the Linear issue its work is delivered
 * in, writing the criteria it is held to, accepting the work, and unlinking it. Each reads the person's role first
 * (`gate`, with permissions as Asana's), works in the workspace's scope, and writes nothing to a milestone but its
 * criteria and, through `accept_linear_issue` and `hold_linear_acceptance`, its verification. The agent decides the
 * payment afterwards, under every guardrail, as for any verified milestone.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const MISSING_WORDS = {
  off: "Linear is not set up on this deployment.",
  not_set_up: "Linear is not set up on this deployment yet.",
  not_connected: "Linear is not connected to this workspace. An owner or admin connects it in Settings.",
  reconnect: "Linear needs to be reconnected. An owner or admin reconnects it in Settings.",
} as const;

/** The workspace's Linear, ready to call, or the refusal saying why not. */
async function context(provider?: LinearProvider | null): Promise<LinearContext | Refused> {
  const found = await linearContext(provider);
  return "missing" in found ? refused(found.missing === "off" || found.missing === "not_set_up" ? "not_set_up" : "not_connected", MISSING_WORDS[found.missing]) : found;
}

/** A connection-level failure: the connection is marked when it needs a person, and the person is told. */
async function accessRefusal(ctx: LinearContext, error: unknown): Promise<Refused> {
  if (needsReconnect(error)) await markReconnect(ctx.connection, new Date().toISOString());
  if (!(error instanceof LinearAccessError) && !(error instanceof ProviderError)) {
    console.error("linear: a call failed", error instanceof Error ? error.message : "unknown error");
  }
  return refused("linear_unavailable", readFailureWords(error));
}

/** A call to Linear that failed: the connection's or Linear's answer, said to the person; anything else is a bug. */
const linearFailure = (error: unknown) => error instanceof LinearAccessError || error instanceof ProviderError;

function notSetUp(error: unknown): Refused | null {
  return error instanceof LinearNotSetUpError ? refused("not_set_up", MISSING_WORDS.not_set_up) : null;
}

/** Whether the milestone is linked to an Asana task: one milestone is accepted from one tool. Never, before 0115. */
async function linkedInAsana(milestoneId: string): Promise<boolean> {
  try {
    return (await asanaLinks({ milestoneIds: [milestoneId] })).length > 0;
  } catch (error) {
    if (error instanceof AsanaNotSetUpError) return false;
    throw error;
  }
}

export async function linkLinearIssue(actor: Actor, input: { milestoneId: string; issue: string }, deps: { provider?: LinearProvider | null } = {}): Promise<CommandOutcome<{ linkId: string; state: string }>> {
  const refusal = gate(actor, "milestone.link_issue");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  // A pasted link is read for its identifier only, and never opened (LN4, LN14).
  const ref = issueRefOf(input.issue);
  if (!ref) return refused("bad_issue", "That is not a Linear issue. Paste the issue's link, or its ID, such as ENG-123.");
  try {
    const ctx = await context(deps.provider);
    if ("ok" in ctx) return ctx;
    const milestone = (await milestonesForAcceptance([input.milestoneId])).get(input.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    if (milestone.status !== "pending") {
      return refused("milestone_not_open", milestone.status === "paid" || milestone.status === "closed" ? "This milestone is done: nothing is linked to it now." : "This milestone is verified already. Revoke its verification first to accept it from Linear.");
    }
    // A merged pull request verifies its milestone on its own (GitHub check), and an Asana task is accepted on its own
    // (Asana acceptance A8): one milestone is not verified two ways.
    if (parseGitHubPullRequestUrl(milestone.verificationSource)) return refused("github", "This milestone is verified by its GitHub pull request. Add a new milestone to accept work from Linear.");
    if (await linkedInAsana(milestone.id)) return refused("asana", "This milestone is linked to an Asana task. Unlink the task first to accept the work from Linear.");
    if ((await liveLinks({ milestoneIds: [milestone.id] })).length > 0) return refused("milestone_linked", "This milestone is linked to a Linear issue already. Unlink it first.");

    let read;
    try {
      read = await ctx.session.call((token) => ctx.provider.reader.issue(token, ref.identifier));
    } catch (error) {
      return await accessRefusal(ctx, error);
    }
    if (read.kind === "gone") return refused("issue_not_found", "Linear does not show that issue to the connected account. Check the ID, or ask whoever connected Linear to join the issue's team.");
    // The same identifier in another Linear workspace is another issue: a link to one names its workspace, which must be
    // the connected one.
    const answered = read.issue.url ? issueRefOf(read.issue.url) : null;
    if (ref.workspaceKey && answered?.workspaceKey && ref.workspaceKey.toLowerCase() !== answered.workspaceKey.toLowerCase()) {
      return refused("other_workspace", "That link is to another Linear workspace than the one connected. Link an issue of the connected workspace.");
    }
    const facts = factsFromRead(read);
    const inserted = await insertLink({
      milestoneId: milestone.id,
      connectionId: ctx.connection.id,
      issueId: read.issue.id,
      identifier: read.issue.identifier,
      teamId: read.issue.teamId,
      teamKey: read.issue.teamKey,
      issueTitle: read.issue.title,
      issueUrl: read.issue.url,
      by: actor.userId,
    });
    if (!inserted.ok) {
      return inserted.reason === "issue_linked"
        ? refused("issue_linked", "That Linear issue is linked to another milestone already: one issue verifies one milestone.")
        : refused("milestone_linked", "This milestone is linked to a Linear issue already. Unlink it first.");
    }
    const link = inserted.link;
    const plan = planRead(factsOf(link), facts.plan, { criteria: milestone.criteria !== null });
    const next = plan.kind === "set" ? { state: plan.state, heldReason: plan.heldReason } : null;
    await writeRead(link, facts.write, next, new Date().toISOString());
    await appendLedgerEntryBestEffort(actor.orgId, {
      actor: "human",
      domain: "contractor",
      action: "linear_issue_linked",
      summary: `Linked milestone “${milestone.title}” to the Linear issue ${read.issue.identifier} “${read.issue.title}”`,
      detail: {
        by: actor.userId,
        milestoneId: milestone.id,
        linkId: link.id,
        issueId: read.issue.id,
        identifier: read.issue.identifier,
        teamKey: read.issue.teamKey,
        issueUrl: read.issue.url,
        completed: read.issue.completed,
        fingerprint: facts.write.fingerprint,
      },
    });
    const state = next?.state ?? link.state;
    const words = stateWords(state, next?.heldReason ?? null, false);
    return done(`Linked to ${read.issue.identifier} “${read.issue.title}”. ${words.label}: ${words.line}`, { linkId: link.id, state });
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}

export async function unlinkLinearIssue(actor: Actor, input: { milestoneId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.unlink_issue");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  try {
    const link = (await liveLinks({ milestoneIds: [input.milestoneId] }))[0];
    if (!link) return refused("not_linked", "This milestone is not linked to a Linear issue.");
    const milestone = (await milestonesForAcceptance([link.milestoneId])).get(link.milestoneId);
    // An accepted milestone the agent has not paid loses its acceptance with its issue (LN10): the same hold a reopened
    // issue gets.
    let withdrew = false;
    if (link.state === "accepted") {
      const held = await holdAcceptance(link, "unlinked");
      if (held === "deferred") return refused("deciding", "Someone is deciding this milestone's payment right now. Try again in a few minutes.");
      withdrew = held === "held";
    }
    if (!(await unlinkLink(link, actor.userId, new Date().toISOString()))) return refused("not_linked", "This milestone is not linked to a Linear issue.");
    await appendLedgerEntryBestEffort(actor.orgId, {
      actor: "human",
      domain: "contractor",
      action: "linear_issue_unlinked",
      summary: `Unlinked milestone “${milestone?.title ?? link.issueTitle}” from the Linear issue ${link.identifier}${withdrew ? ", taking its acceptance back" : ""}`,
      detail: { by: actor.userId, milestoneId: link.milestoneId, linkId: link.id, issueId: link.issueId, identifier: link.identifier, withdrewAcceptance: withdrew },
    });
    return done(withdrew ? "Unlinked. Its acceptance was taken back: the milestone waits for verification again." : "Unlinked from Linear.");
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}

/**
 * Writes the criteria of a milestone linked to Linear, or to be (LN5): `milestones.acceptance_criteria`, as Asana's
 * `setAcceptanceCriteria` does, but held to the Linear link: never once its work was accepted, and a done issue held for
 * want of criteria is ready for acceptance at once.
 */
export async function setLinearAcceptanceCriteria(actor: Actor, input: { milestoneId: string; criteria: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.set_issue_criteria");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  const criteria = input.criteria.replace(/\r\n/g, "\n").trim();
  if (criteria.length < CRITERIA_MIN || criteria.length > CRITERIA_MAX) return refused("criteria", `Write the acceptance criteria from the agreement: ${CRITERIA_MIN} to ${CRITERIA_MAX} characters.`);
  try {
    const milestone = (await milestonesForAcceptance([input.milestoneId])).get(input.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    const link = (await liveLinks({ milestoneIds: [milestone.id] }))[0] ?? null;
    if (link?.state === "accepted") return refused("accepted", "The work was accepted against these criteria. Unlink the issue to change them.");
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
    // A done issue held for want of criteria is ready for acceptance now, from what was last read of it.
    if (link && link.completed && !link.archived && link.state === "held" && link.heldReason === "no_criteria" && link.fingerprint) {
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
  link_not_found: "This milestone is not linked to a Linear issue.",
  already_accepted: "This work was accepted already.",
  after_payment: "A payment for this milestone was sent before the issue changed. Review it with the contractor.",
  not_completed: "The issue is not done in Linear, so there is nothing to accept yet.",
  archived: "The issue is archived or deleted in Linear. Restore it there to accept it.",
  stale: "The deliverables changed in Linear since you opened this. Look at them again before accepting.",
  milestone_not_open: "This milestone is not waiting for verification any more.",
  no_criteria: "Add the acceptance criteria from the agreement first.",
  criteria_changed: "The acceptance criteria changed since you opened this. Read them again before accepting.",
};

export async function acceptLinearWork(
  actor: Actor,
  input: { milestoneId: string; fingerprint: string; criteriaSha256: string; confirmed: boolean },
  deps: { provider?: LinearProvider | null } = {}
): Promise<CommandOutcome<{ status: string }>> {
  const refusal = gate(actor, "milestone.accept_issue");
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
    // What Linear says right now, not what it said when the page was drawn (LN8).
    let read;
    try {
      read = await readLink(link, { title: milestone.title, criteria: milestone.criteria !== null }, { session: ctx.session, reader: ctx.provider.reader });
    } catch (error) {
      if (linearFailure(error)) return await accessRefusal(ctx, error);
      throw error;
    }
    if (read.kind === "failed") return refused("linear_unavailable", read.message);
    const fresh = (await liveLinks({ milestoneIds: [link.milestoneId] }))[0];
    if (!fresh) return refused("not_linked", ACCEPT_WORDS.link_not_found);
    if (fresh.fingerprint !== input.fingerprint) return refused("stale", ACCEPT_WORDS.stale, { changed: true });
    if (!acceptable(fresh, { completed: fresh.completed, archived: fresh.archived, criteria: milestone.criteria !== null, milestoneStatus: milestone.status })) {
      const words = stateWords(fresh.state, fresh.heldReason, fresh.afterPayment);
      return refused("not_ready", fresh.state === "accepted" ? ACCEPT_WORDS.already_accepted : `${words.label}. ${words.line}`, { changed: true });
    }
    // The contractor or payee never accepts their own work (LN9).
    let who: Identities;
    try {
      who = await identitiesOf(actor, milestone, ctx);
    } catch (error) {
      if (linearFailure(error)) return await accessRefusal(ctx, error);
      throw error;
    }
    const self = selfAcceptance(who);
    if (self) return refused("self_acceptance", SELF_WORDS[self]);

    let accepted: IssueLink;
    try {
      accepted = await acceptLink(fresh, {
        by: actor.userId,
        fingerprint: input.fingerprint,
        criteriaSha256: input.criteriaSha256,
        note: `Accepted by a person against the milestone's acceptance criteria; the Linear issue ${fresh.identifier} was done${fresh.completedAt ? ` on ${fresh.completedAt.slice(0, 10)}` : ""}.`,
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
      action: ACCEPTED_ACTION,
      summary: `Accepted the work of milestone “${milestone.title}” against its criteria, from the Linear issue ${accepted.identifier} “${accepted.issueTitle}”`,
      detail: {
        by: actor.userId,
        milestoneId: milestone.id,
        linkId: accepted.id,
        issueId: accepted.issueId,
        identifier: accepted.identifier,
        issueUrl: accepted.issueUrl,
        completedAt: accepted.completedAt,
        completedByName: accepted.completedByName,
        fingerprint: input.fingerprint,
        deliverables: (accepted.acceptedDeliverables ?? accepted.deliverables).map((item) => ({ kind: item.kind, label: item.label, href: item.href })),
        criteriaSha256: input.criteriaSha256,
        payeeLinearMapped: who.payeeLinearIds.length > 0,
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

/** Reads one linked issue again now (Check Linear now). */
export async function checkLinearIssue(actor: Actor, input: { milestoneId: string }, deps: { provider?: LinearProvider | null } = {}): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.check_issue");
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
      if (read.kind === "failed") return refused("linear_unavailable", read.message, { changed: true });
    } catch (error) {
      if (linearFailure(error)) return await accessRefusal(ctx, error);
      throw error;
    }
    const fresh = (await liveLinks({ milestoneIds: [link.milestoneId] }))[0];
    const words = fresh ? stateWords(fresh.state, fresh.heldReason, fresh.afterPayment) : null;
    return done(words ? `Read from Linear. ${words.label}.` : "Read from Linear.");
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}
