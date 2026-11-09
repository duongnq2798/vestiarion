import crypto from "node:crypto";
import { runCycleSoon } from "../agent/cycle-soon";
import { AsanaNotSetUpError, liveLinks as asanaLinks } from "../asana/links";
import { ProviderError } from "../connectors/provider";
import { parseGitHubPullRequestUrl } from "../github-verification";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { LinearNotSetUpError, liveLinks as linearLinks } from "../linear/links";
import { ACCEPTED_ACTION, acceptable, jiraPlan, planRead, selfAcceptance, SELF_WORDS, stateWords, type Identities } from "../jira/acceptance";
import type { IssueRead } from "../jira/api";
import { identitiesOf } from "../jira/identities";
import {
  acceptLink,
  AcceptRefusedError,
  factsOf,
  holdAcceptance,
  insertLink,
  JiraNotSetUpError,
  liveLinks,
  milestonesForAcceptance,
  unlinkLink,
  writeCriteria,
  writeRead,
  type AcceptError,
  type IssueLink,
} from "../jira/links";
import type { JiraProvider } from "../jira/provider";
import { factsFromRead, readFailureWords, readIssue, readLink, type LinkReadOutcome } from "../jira/reads";
import { JiraAccessError } from "../jira/session";
import { siteRef, type StoredSite } from "../jira/sites";
import { issueRefOf, siteHost } from "../jira/urls";
import { ensureJiraWebhook, JiraSiteGoneError } from "../jira/webhooks";
import { jiraContext, markReconnect, needsReconnect, siteOf, type JiraContext } from "../jira/workspace";
import { cycleEventOf, type Actor } from "./actor";
import { CRITERIA_MAX, CRITERIA_MIN } from "./asana";
import { done, refused, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * Contractor work accepted from Jira, from the console (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR6,
 * JR7, JR11, JR12, JR13), as Linear's commands (`./linear`), under the same five command names: linking a milestone to
 * the Jira issue its work is delivered in, writing the criteria it is held to, accepting the work, checking the issue
 * now, and unlinking it. Each reads the person's role first (`gate`, with permissions as Linear's), works in the
 * workspace's scope, and writes nothing to a milestone but its criteria and, through `accept_jira_issue` and
 * `hold_jira_acceptance`, its verification (JR18). The agent decides the payment afterwards, under every guardrail, as
 * for any verified milestone.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** What a command may be given besides its input: Jira's calls, a clock, and where Jira sends deliveries (tests name them). */
export interface JiraCommandDeps {
  provider?: JiraProvider | null;
  now?: () => number;
  /** This deployment's origin, for the webhook the link and unlink make sure of; `siteOrigin()` unless given. */
  origin?: string;
}

export const MISSING_WORDS = {
  off: "Jira is not set up on this deployment yet.",
  not_set_up: "Jira is not set up on this deployment yet.",
  not_connected: "Jira is not connected to this workspace. An owner or admin connects it in Settings.",
  reconnect: "Jira needs to be reconnected. An owner or admin reconnects it in Settings.",
} as const;

/** The workspace's Jira, ready to call, or the refusal saying why not (JR1). */
async function context(provider?: JiraProvider | null): Promise<JiraContext | Refused> {
  const found = await jiraContext(provider);
  return "missing" in found ? refused(found.missing === "off" || found.missing === "not_set_up" ? "not_set_up" : "not_connected", MISSING_WORDS[found.missing]) : found;
}

/** A call to Jira that failed: the connection's, the site's or Jira's answer, said to the person; anything else is a bug. */
const jiraFailure = (error: unknown) => error instanceof JiraAccessError || error instanceof ProviderError || error instanceof JiraSiteGoneError;

/** A connection-level failure: the connection is marked when it needs a person, and the person is told. */
async function accessRefusal(ctx: JiraContext, error: unknown): Promise<Refused> {
  if (needsReconnect(error)) {
    const nowIso = new Date().toISOString();
    // A site gone twice says so in its own words (JR3); a refused grant, in the core's.
    await (error instanceof JiraSiteGoneError ? markReconnect(ctx.connection, nowIso, error.message) : markReconnect(ctx.connection, nowIso));
  }
  if (!jiraFailure(error)) console.error("jira: a call failed", error instanceof Error ? error.message : "unknown error");
  return refused("jira_unavailable", readFailureWords(error));
}

function notSetUp(error: unknown): Refused | null {
  return error instanceof JiraNotSetUpError ? refused("not_set_up", MISSING_WORDS.not_set_up) : null;
}

/**
 * The connected site to read on (JR2): the one kept, or the one the upkeep saves now. Atlassian not listing it is said
 * in the site-gone words, as the card says them.
 */
async function siteToRead(ctx: JiraContext, now: () => number): Promise<StoredSite | Refused> {
  const site = await siteOf(ctx, { now });
  return site ?? refused("jira_unavailable", readFailureWords(new JiraSiteGoneError(ctx.connection.externalOrgName ?? "connected", false)));
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

/** Whether the milestone is linked to a Linear issue. Never, before 0147. */
async function linkedInLinear(milestoneId: string): Promise<boolean> {
  try {
    return (await linearLinks({ milestoneIds: [milestoneId] })).length > 0;
  } catch (error) {
    if (error instanceof LinearNotSetUpError) return false;
    throw error;
  }
}

/** How long a link or an unlink waits for the webhook to be made sure of (JR6, JR14). */
const UPKEEP_WAIT_MS = 5_000;

/**
 * After a link or an unlink, the connection's one webhook made sure of for the projects of the open links (JR14): best
 * effort, raced against 5 s, and never a reason the command fails. What Jira refused is on the site row and the card; the
 * sweep tries again within 15 minutes.
 */
async function keepWebhook(ctx: JiraContext, deps: JiraCommandDeps): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = ensureJiraWebhook(ctx, { ...(deps.now ? { now: deps.now } : {}), ...(deps.origin ? { origin: deps.origin } : {}) }).then(
    () => undefined,
    (error: unknown) => console.error("jira: the webhook was not made sure of", ctx.connection.id, error instanceof Error ? error.name : "unknown")
  );
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, UPKEEP_WAIT_MS);
  });
  try {
    await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function linkJiraIssue(actor: Actor, input: { milestoneId: string; issue: string }, deps: JiraCommandDeps = {}): Promise<CommandOutcome<{ linkId: string; state: string }>> {
  const refusal = gate(actor, "milestone.link_issue");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  // A pasted link is read for its host and key only, and never opened (JR6, JR20).
  const ref = issueRefOf(input.issue);
  if (!ref) return refused("bad_issue", "That is not a Jira issue. Paste the issue's link from Jira, or its key, such as ENG-123.");
  const now = deps.now ?? Date.now;
  try {
    const ctx = await context(deps.provider);
    if ("ok" in ctx) return ctx;
    const milestone = (await milestonesForAcceptance([input.milestoneId])).get(input.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    if (milestone.status !== "pending") {
      return refused("milestone_not_open", milestone.status === "paid" || milestone.status === "closed" ? "This milestone is done: nothing is linked to it now." : "This milestone is verified already. Revoke its verification first to accept it from Jira.");
    }
    // One milestone is verified one way (JR6): a merged pull request verifies it on its own, and an Asana task or a Linear
    // issue is accepted on its own.
    if (parseGitHubPullRequestUrl(milestone.verificationSource)) return refused("github", "This milestone is verified by its GitHub pull request. Add a new milestone to accept work from Jira.");
    if (await linkedInAsana(milestone.id)) return refused("asana", "This milestone is linked to an Asana task. Unlink the task first to accept the work from Jira.");
    if (await linkedInLinear(milestone.id)) return refused("linear", "This milestone is linked to a Linear issue. Unlink the issue first to accept the work from Jira.");
    if ((await liveLinks({ milestoneIds: [milestone.id] })).length > 0) return refused("milestone_linked", "This milestone is linked to a Jira issue already. Unlink it first.");

    let site: StoredSite;
    let read: IssueRead;
    let startedIso: string;
    try {
      const found = await siteToRead(ctx, now);
      if ("ok" in found) return found;
      site = found;
      // A key names one issue on its own site only: a link to another site's issue is another issue (JR6).
      const host = siteHost(site.siteUrl) ?? site.siteUrl;
      if (ref.host !== null && ref.host !== host) return refused("other_site", `That issue is on another Jira site than the one connected (${host}). Link an issue of the connected site.`);
      startedIso = new Date(now()).toISOString();
      // By its key, once (JR6): its status first, and in full only when it is done (JR8). Every read after this is by id.
      read = await readIssue({ session: ctx.session, reader: ctx.provider.reader, site: siteRef(site) }, ref.key, "auto");
    } catch (error) {
      if (error instanceof JiraNotSetUpError) throw error;
      return await accessRefusal(ctx, error);
    }
    if (read.kind === "gone") return refused("issue_not_found", `Jira does not show ${ref.key} to the connected account. Check the key, or ask whoever connected Jira to open the project.`);
    const facts = factsFromRead(read, siteRef(site));
    const inserted = await insertLink({
      milestoneId: milestone.id,
      connectionId: ctx.connection.id,
      cloudId: site.cloudId,
      issueId: read.issue.id,
      identifier: read.issue.key,
      projectId: read.issue.projectId,
      projectKey: read.issue.projectKey,
      issueTitle: read.issue.title,
      issueUrl: read.issue.url,
      by: actor.userId,
    });
    if (!inserted.ok) {
      return inserted.reason === "issue_linked"
        ? refused("issue_linked", "That Jira issue is linked to another milestone already: one issue verifies one milestone.")
        : refused("milestone_linked", "This milestone is linked to a Jira issue already. Unlink it first.");
    }
    const link = inserted.link;
    const plan = jiraPlan(planRead(factsOf(link), facts.plan, { criteria: milestone.criteria !== null }));
    const next = plan.kind === "set" ? { state: plan.state, heldReason: plan.heldReason } : null;
    await writeRead(link, facts.write, next, startedIso);
    await appendLedgerEntryBestEffort(actor.orgId, {
      actor: "human",
      domain: "contractor",
      action: "jira_issue_linked",
      summary: `Linked milestone “${milestone.title}” to the Jira issue ${read.issue.key} “${read.issue.title}”`,
      detail: {
        by: actor.userId,
        milestoneId: milestone.id,
        linkId: link.id,
        issueId: read.issue.id,
        identifier: read.issue.key,
        projectKey: read.issue.projectKey,
        cloudId: site.cloudId,
        issueUrl: read.issue.url,
        completed: read.issue.completed,
        // Null until the issue is done: what it delivers is read only then (JR8).
        fingerprint: facts.write.deliverables?.fingerprint ?? null,
      },
    });
    // The webhook now names this issue's project too (JR14).
    await keepWebhook(ctx, deps);
    const state = next?.state ?? link.state;
    const words = stateWords(state, next?.heldReason ?? null, false, read.issue.resolutionName);
    return done(`Linked to ${read.issue.key} “${read.issue.title}”. ${words.label}: ${words.line}`, { linkId: link.id, state });
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}

export async function unlinkJiraIssue(actor: Actor, input: { milestoneId: string }, deps: JiraCommandDeps = {}): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.unlink_issue");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  try {
    const link = (await liveLinks({ milestoneIds: [input.milestoneId] }))[0];
    if (!link) return refused("not_linked", "This milestone is not linked to a Jira issue.");
    const milestone = (await milestonesForAcceptance([link.milestoneId])).get(link.milestoneId);
    // An accepted milestone the agent has not paid loses its acceptance with its issue (JR13): the same hold a reopened
    // issue gets.
    let withdrew = false;
    if (link.state === "accepted") {
      const held = await holdAcceptance(link, "unlinked");
      if (held === "deferred") return refused("deciding", "Someone is deciding this milestone's payment right now. Try again in a few minutes.");
      withdrew = held === "held";
    }
    if (!(await unlinkLink(link, actor.userId, new Date((deps.now ?? Date.now)()).toISOString()))) return refused("not_linked", "This milestone is not linked to a Jira issue.");
    await appendLedgerEntryBestEffort(actor.orgId, {
      actor: "human",
      domain: "contractor",
      action: "jira_issue_unlinked",
      summary: `Unlinked milestone “${milestone?.title ?? link.issueTitle}” from the Jira issue ${link.identifier}${withdrew ? ", taking its acceptance back" : ""}`,
      detail: { by: actor.userId, milestoneId: link.milestoneId, linkId: link.id, issueId: link.issueId, identifier: link.identifier, withdrewAcceptance: withdrew },
    });
    // The webhook no longer names a project no open link is in, and none is kept without one (JR14). The issue is
    // unlinked whatever Jira answers, so a connection that cannot be called now is left to the sweep.
    const found = await jiraContext(deps.provider).catch(() => null);
    if (found && !("missing" in found)) await keepWebhook(found, deps);
    return done(withdrew ? "Unlinked. Its acceptance was taken back: the milestone waits for verification again." : "Unlinked from Jira.");
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}

/**
 * Writes the criteria of a milestone linked to Jira, or to be (JR7): `milestones.acceptance_criteria`, through Linear's
 * `writeCriteria`, held to the Jira link: never once its work was accepted, and a done issue held for want of criteria is
 * ready for acceptance at once.
 */
export async function setJiraAcceptanceCriteria(actor: Actor, input: { milestoneId: string; criteria: string }): Promise<CommandOutcome> {
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
  link_not_found: "This milestone is not linked to a Jira issue.",
  already_accepted: "This work was accepted already.",
  after_payment: "A payment for this milestone was sent before the issue changed. Review it with the contractor.",
  not_completed: "The issue is not done in Jira, so there is nothing to accept yet.",
  stale: "The deliverables changed in Jira since you opened this. Look at them again before accepting.",
  milestone_not_open: "This milestone is not waiting for verification any more.",
  no_criteria: "Add the acceptance criteria from the agreement first.",
  criteria_changed: "The acceptance criteria changed since you opened this. Read them again before accepting.",
};

export async function acceptJiraWork(
  actor: Actor,
  input: { milestoneId: string; fingerprint: string; criteriaSha256: string; confirmed: boolean },
  deps: JiraCommandDeps = {}
): Promise<CommandOutcome<{ status: string }>> {
  const refusal = gate(actor, "milestone.accept_issue");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId) || !/^[0-9a-f]{64}$/.test(input.fingerprint) || !/^[0-9a-f]{64}$/.test(input.criteriaSha256)) return refused("not_found", "Milestone not found.");
  if (!input.confirmed) return refused("confirm", "Tick that you checked each criterion against these deliverables.");
  const now = deps.now ?? Date.now;
  try {
    const ctx = await context(deps.provider);
    if ("ok" in ctx) return ctx;
    const link = (await liveLinks({ milestoneIds: [input.milestoneId] }))[0];
    if (!link) return refused("not_linked", ACCEPT_WORDS.link_not_found);
    const milestone = (await milestonesForAcceptance([link.milestoneId])).get(link.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    // What Jira says right now, read in full, not what it said when the page was drawn (JR11).
    let read: LinkReadOutcome;
    try {
      const site = await siteToRead(ctx, now);
      if ("ok" in site) return site;
      read = await readLink(link, { title: milestone.title, criteria: milestone.criteria !== null }, { session: ctx.session, reader: ctx.provider.reader, site: siteRef(site), now }, "full");
    } catch (error) {
      if (jiraFailure(error)) return await accessRefusal(ctx, error);
      throw error;
    }
    if (read.kind === "failed") return refused("jira_unavailable", read.message);
    const fresh = (await liveLinks({ milestoneIds: [link.milestoneId] }))[0];
    if (!fresh) return refused("not_linked", ACCEPT_WORDS.link_not_found);
    if (fresh.fingerprint !== input.fingerprint) return refused("stale", ACCEPT_WORDS.stale, { changed: true });
    // Jira has no archived state (JR10): what it answers for an archived issue is what the read held.
    if (!acceptable(fresh, { completed: fresh.completed, archived: false, criteria: milestone.criteria !== null, milestoneStatus: milestone.status })) {
      const words = stateWords(fresh.state, fresh.heldReason, fresh.afterPayment, fresh.resolutionName);
      return refused("not_ready", fresh.state === "accepted" ? ACCEPT_WORDS.already_accepted : `${words.label}. ${words.line}`, { changed: true });
    }
    // The contractor or payee never accepts their own work (JR12).
    let who: Identities;
    try {
      who = await identitiesOf(actor, milestone, ctx);
    } catch (error) {
      if (jiraFailure(error)) return await accessRefusal(ctx, error);
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
        note: `Accepted by a person against the milestone's acceptance criteria; the Jira issue ${fresh.identifier} was done${fresh.completedAt ? ` on ${fresh.completedAt.slice(0, 10)}` : ""}.`,
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
      summary: `Accepted the work of milestone “${milestone.title}” against its criteria, from the Jira issue ${accepted.identifier} “${accepted.issueTitle}”`,
      detail: {
        by: actor.userId,
        milestoneId: milestone.id,
        linkId: accepted.id,
        issueId: accepted.issueId,
        identifier: accepted.identifier,
        issueUrl: accepted.issueUrl,
        completedAt: accepted.completedAt,
        statusName: accepted.statusName,
        resolutionName: accepted.resolutionName,
        fingerprint: input.fingerprint,
        deliverables: (accepted.acceptedDeliverables ?? accepted.deliverables).map((item) => ({ kind: item.kind, label: item.label, href: item.href })),
        criteriaSha256: input.criteriaSha256,
        // Whether user search found an Atlassian account by the payee's email; the account itself is never kept (JR19).
        payeeJiraMapped: who.payeeJiraIds.length > 0,
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

/** Reads one linked issue again now (Check Jira now, JR16): its status, and in full once it is done (JR8). */
export async function checkJiraIssue(actor: Actor, input: { milestoneId: string }, deps: JiraCommandDeps = {}): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.check_issue");
  if (refusal) return refusal;
  if (!UUID.test(input.milestoneId)) return refused("not_found", "Milestone not found.");
  const now = deps.now ?? Date.now;
  try {
    const ctx = await context(deps.provider);
    if ("ok" in ctx) return ctx;
    const link = (await liveLinks({ milestoneIds: [input.milestoneId] }))[0];
    if (!link) return refused("not_linked", ACCEPT_WORDS.link_not_found);
    const milestone = (await milestonesForAcceptance([link.milestoneId])).get(link.milestoneId);
    if (!milestone) return refused("not_found", "Milestone not found.");
    try {
      const site = await siteToRead(ctx, now);
      if ("ok" in site) return site;
      const read = await readLink(link, { title: milestone.title, criteria: milestone.criteria !== null }, { session: ctx.session, reader: ctx.provider.reader, site: siteRef(site), now });
      if (read.kind === "failed") return refused("jira_unavailable", read.message, { changed: true });
    } catch (error) {
      if (jiraFailure(error)) return await accessRefusal(ctx, error);
      throw error;
    }
    const fresh = (await liveLinks({ milestoneIds: [link.milestoneId] }))[0];
    const words = fresh ? stateWords(fresh.state, fresh.heldReason, fresh.afterPayment, fresh.resolutionName) : null;
    return done(words ? `Read from Jira. ${words.label}.` : "Read from Jira.");
  } catch (error) {
    const known = notSetUp(error);
    if (known) return known;
    throw error;
  }
}
