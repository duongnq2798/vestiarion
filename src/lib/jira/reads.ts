import { currentOrgId } from "../context";
import { ProviderError } from "../connectors/provider";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { jiraPlan, planRead, WITHDRAWN_ACTION, type JiraReadPlan, type ReadFacts, type WithdrawReason } from "./acceptance";
import type { IssueRead, JiraReader, SiteRef } from "./api";
import { deliverablesOf, fingerprintOf } from "./deliverables";
import { factsOf, holdAcceptance, milestonesForAcceptance, writeRead, writeReadError, type HoldOutcome, type IssueLink, type ReadWrite } from "./links";
import { JiraAccessError, type JiraSession } from "./session";
import { JiraSiteGoneError } from "./webhooks";

/**
 * Reading a linked issue again (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR8 to JR10, JR13, JR16): the
 * one path every re-read takes, whatever asked for it (a signed webhook delivery, the agent's cycle before it decides
 * contractors, the contractor stage right before it sends releases, the sweeper every 15 minutes, Check Jira now, or a
 * person about to accept), as Linear's (`../linear/reads`). The issue is read through Jira's API with the connection's
 * token, by its numeric id on the connected site; its facts are written on the link; Linear's plan moves the link; and an
 * acceptance the issue no longer bears out is taken back through `hold_jira_acceptance`, which holds the milestone for
 * review before any payment executes. A read that fails changes nothing but the words on the link.
 *
 * An issue is read at one of two depths (JR8). One last read as done, ready or accepted is read in full: its status and
 * what it delivers. Any other is read for its status first, one request, and in full in the same call only when that
 * says it is done and not resolved as canceled: an open issue costs one request a read, and what it delivers is read once
 * there is something to accept. A status read keeps the deliverables and the fingerprint last read.
 */

export interface ReadContext {
  session: JiraSession;
  reader: JiraReader;
  /** The connected site: its cloudId, which every request names, and its address, which links are compared with. */
  site: SiteRef;
  now?: () => number;
}

/** `auto`: a status read first, in full when it says done (JR8); `full`: in full at once, as before an acceptance. */
export type LinkDepth = "auto" | "full";

export type LinkReadOutcome =
  | { kind: "read"; plan: JiraReadPlan; held: HoldOutcome | null; becameReady: boolean; fingerprint: string; updatedAt: string | null }
  | { kind: "failed"; message: string };

/** Whether the link's last read said the issue was done: it is read in full, so a change in what it delivers is seen. */
export const saidDone = (link: Pick<IssueLink, "statusCategory" | "state">) => link.statusCategory === "done" || link.state === "ready" || link.state === "accepted";

/**
 * An issue by its id or key, at a depth (JR8): in full at once, or its status first and in full in the same call when it
 * is done and not canceled, by the id Jira answered with.
 */
export async function readIssue(ctx: Pick<ReadContext, "session" | "reader" | "site">, ref: string, depth: LinkDepth): Promise<IssueRead> {
  const first = await ctx.session.call((token) => ctx.reader.issue(token, ctx.site, ref, depth === "full" ? "full" : "status"));
  if (depth === "full" || first.kind !== "issue" || !first.issue.completed) return first;
  const { id } = first.issue;
  return ctx.session.call((token) => ctx.reader.issue(token, ctx.site, id, "full"));
}

/**
 * The facts a read writes on the link, and what the plan compares. After a full read, what the issue delivers and its
 * fingerprint, Asana's; after a status read, none, and the plan compares the fingerprint last kept.
 */
export function factsFromRead(
  read: Extract<IssueRead, { kind: "issue" }>,
  site: Pick<SiteRef, "url">,
  kept: Pick<IssueLink, "fingerprint"> = { fingerprint: null }
): { write: ReadWrite; plan: Extract<ReadFacts, { kind: "issue" }> } {
  const { issue } = read;
  let deliverables: ReadWrite["deliverables"] = null;
  let fingerprint = kept.fingerprint ?? "";
  if (issue.depth === "full") {
    const found = deliverablesOf({ descriptionLinks: issue.descriptionLinks, attachments: issue.attachments, remoteLinks: issue.remoteLinks, comments: issue.comments, key: issue.key, siteUrl: site.url });
    // As Linear's: deliverables past the first 50, or past the size a link keeps, count by number only; files and web
    // links past 50 and comments past the newest 50 are not read, which the link says (`moreUnread`).
    fingerprint = fingerprintOf(found.deliverables, found.more);
    deliverables = {
      list: found.deliverables,
      fingerprint,
      attachmentsRead: issue.counts.attachments,
      remoteLinksRead: issue.counts.remoteLinks,
      commentsRead: issue.counts.comments,
      moreUnread: issue.moreUnread,
    };
  }
  return {
    write: {
      identifier: issue.key,
      projectId: issue.projectId,
      projectKey: issue.projectKey,
      issueTitle: issue.title,
      issueUrl: issue.url,
      statusCategory: issue.statusCategory,
      statusName: issue.statusName,
      resolutionName: issue.resolutionName,
      completed: issue.completed,
      completedAt: issue.completedAt,
      updatedAt: issue.updatedAt,
      deliverables,
    },
    // Jira has no archived state (JR10): what it answers for an archived issue is read as it answers.
    plan: { kind: "issue", completed: issue.completed, canceled: issue.canceled, archived: false, completedAt: issue.completedAt, fingerprint },
  };
}

const RETRY = "It is read again within 15 minutes.";

/** A failed read, in the words the card shows (JR22). */
export function readFailureWords(error: unknown): string {
  if (error instanceof JiraSiteGoneError) return error.message;
  if (error instanceof JiraAccessError) {
    return error.outcome.reason === "reconnect" || error.outcome.reason === "missing" ? "Jira no longer accepts the connection. Reconnect Jira in Settings." : `Jira did not answer just now. ${RETRY}`;
  }
  if (error instanceof ProviderError) {
    if (error.failure === "rate_limited") return `Jira asked Vestiarion to slow down. ${RETRY}`;
    if (error.failure === "forbidden" || error.failure === "unauthorized") return "Jira refused the connection. Reconnect Jira in Settings.";
    if (error.failure === "bad_response") return `Jira's answer could not be read. ${RETRY}`;
    return `Jira did not answer just now. ${RETRY}`;
  }
  return `The issue could not be read just now. ${RETRY}`;
}

/** What happened to the issue, in a ledger summary's words. */
export const REASON_WORDS: Record<WithdrawReason, string> = {
  reopened: "was reopened",
  canceled: "was resolved as not done",
  deliverable_changed: "changed its deliverables",
  issue_unreachable: "can no longer be read",
  unlinked: "was unlinked",
};

/**
 * Reads one link's issue and applies what it says. `criteria` is whether the milestone has acceptance criteria now. A
 * link of another site than the connected one is read as gone, with no request (JR16): its issue id may be another issue
 * on the new site. Throws `JiraAccessError` when the connection itself failed (the caller decides what the connection
 * says); any other failure is written on the link and answered as `failed`.
 */
export async function readLink(link: IssueLink, milestone: { title: string; criteria: boolean }, ctx: ReadContext, depth: LinkDepth = "auto"): Promise<LinkReadOutcome> {
  const now = ctx.now ?? Date.now;
  // When the read started: what `last_read_at` keeps, so a delivery sent before it is one it saw (JR15).
  const startedIso = new Date(now()).toISOString();
  let read: IssueRead;
  if (link.cloudId !== ctx.site.cloudId) {
    read = { kind: "gone", reason: "not_found" };
  } else {
    try {
      read = await readIssue(ctx, link.issueId, depth === "full" || saidDone(link) ? "full" : "auto");
    } catch (error) {
      const message = readFailureWords(error);
      await writeReadError(link, message, new Date(now()).toISOString());
      if (error instanceof JiraAccessError) throw error;
      if (!(error instanceof ProviderError)) console.error("jira: an issue read failed", link.id, error instanceof Error ? error.message : "unknown error");
      return { kind: "failed", message };
    }
  }

  const found = read.kind === "issue" ? factsFromRead(read, ctx.site, link) : null;
  const facts: ReadFacts = found ? found.plan : { kind: "gone", reason: read.kind === "gone" ? read.reason : "not_found" };
  const plan = jiraPlan(planRead(factsOf(link), facts, { criteria: milestone.criteria }));
  const fingerprint = found?.write.deliverables?.fingerprint ?? link.fingerprint ?? "";
  const updatedAt = found?.write.updatedAt ?? null;

  if (plan.kind === "withdraw") {
    const held = await holdAcceptance(link, plan.reason);
    // The link is held now (or still accepted, when a person is deciding the milestone): its facts are written over that.
    const heldNow = held === "held" || held === "held_after_payment" ? { ...link, state: "held" as const, heldReason: plan.reason } : link;
    await writeRead(heldNow, found?.write ?? null, null, startedIso);
    if (held === "held" || held === "held_after_payment") {
      const identifier = found?.write.identifier ?? link.identifier;
      await appendLedgerEntryBestEffort(currentOrgId(), {
        actor: "system",
        domain: "contractor",
        action: WITHDRAWN_ACTION,
        summary:
          held === "held"
            ? `Took back the acceptance of milestone “${milestone.title}”: its Jira issue ${identifier} ${REASON_WORDS[plan.reason]} before payment. Held for review`
            : `The Jira issue ${identifier} of milestone “${milestone.title}” ${REASON_WORDS[plan.reason]} after its payment was sent. Held for review`,
        detail: {
          milestoneId: link.milestoneId,
          linkId: link.id,
          issueId: link.issueId,
          identifier,
          reason: plan.reason,
          afterPayment: held === "held_after_payment",
          acceptedFingerprint: link.acceptedFingerprint,
          fingerprint: found?.write.deliverables ? found.write.deliverables.fingerprint : null,
          completed: found ? found.write.completed : null,
          completedAt: found ? found.write.completedAt : null,
          statusCategory: found ? found.write.statusCategory : null,
        },
      });
    }
    return { kind: "read", plan, held, becameReady: false, fingerprint, updatedAt };
  }

  const wrote = await writeRead(link, found?.write ?? null, plan.kind === "set" ? { state: plan.state, heldReason: plan.heldReason } : null, startedIso);
  const becameReady = wrote && plan.kind === "set" && plan.becameReady;
  if (becameReady && found) {
    await appendLedgerEntryBestEffort(currentOrgId(), {
      actor: "system",
      domain: "contractor",
      action: "jira_issue_ready",
      summary: `The Jira issue ${found.write.identifier} of milestone “${milestone.title}” was done: ready for a person to accept the work against its criteria`,
      detail: {
        milestoneId: link.milestoneId,
        linkId: link.id,
        issueId: link.issueId,
        identifier: found.write.identifier,
        completedAt: found.write.completedAt,
        statusName: found.write.statusName,
        resolutionName: found.write.resolutionName,
        fingerprint,
        deliverables: found.write.deliverables?.list.length ?? 0,
      },
    });
  }
  return { kind: "read", plan, held: null, becameReady, fingerprint, updatedAt };
}

export interface ReadSummary {
  read: number;
  failed: number;
  ready: number;
  withdrawn: number;
  deferred: number;
}

/**
 * Reads these links, one after another, until `budgetMs` is spent or `stop` says so (the sweep's, once Atlassian's shared
 * rate limit is spent: JR17); links whose milestone was paid or closed are left alone. Stops at the first connection
 * failure, which it throws. `onRead` hears each link's outcome.
 */
export async function readLinks(
  links: readonly IssueLink[],
  ctx: ReadContext & { budgetMs?: number; depth?: LinkDepth; stop?: () => boolean; onRead?: (link: IssueLink, outcome: LinkReadOutcome) => void }
): Promise<ReadSummary> {
  const now = ctx.now ?? Date.now;
  const started = now();
  const summary: ReadSummary = { read: 0, failed: 0, ready: 0, withdrawn: 0, deferred: 0 };
  if (links.length === 0) return summary;
  const milestones = await milestonesForAcceptance([...new Set(links.map((link) => link.milestoneId))]);
  for (const link of links) {
    if (ctx.budgetMs !== undefined && now() - started > ctx.budgetMs) break;
    if (ctx.stop?.()) break;
    const milestone = milestones.get(link.milestoneId);
    if (!milestone || milestone.status === "paid" || milestone.status === "closed") continue;
    const outcome = await readLink(link, { title: milestone.title, criteria: milestone.criteria !== null }, ctx, ctx.depth ?? "auto");
    ctx.onRead?.(link, outcome);
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
