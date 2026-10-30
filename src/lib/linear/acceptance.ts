/**
 * Accepting contractor work delivered in Linear (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN7 to
 * LN10, LN15): what a read of a linked issue does to the link, who may accept the work, and the figures the Linear card
 * shows. Pure and browser-safe: no I/O, no clock of its own. The same rules as Asana's (`../asana/acceptance`):
 * - An issue done in Linear is never by itself proof of quality, and never permission to move money: anyone in the
 *   Linear workspace can mark it Done, the contractor included. It makes the link **ready for acceptance**, and only a
 *   person's acceptance verifies the milestone.
 * - Without acceptance criteria the link is held: a completed issue waits for a person to write them.
 * - After acceptance, an issue reopened (or reopened and completed again), canceled, with a deliverable changed,
 *   archived or deleted, or no longer shown by Linear takes the acceptance back (`withdraw`) before payment executes;
 *   the milestone is held for review.
 * - A held link stays held until a person accepts again: no read moves it back to accepted.
 * - Nothing here names an amount, a payee or an address.
 */

export type LinkState = "waiting" | "ready" | "accepted" | "held";
export type HeldReason = "reopened" | "canceled" | "deliverable_changed" | "archived" | "issue_unreachable" | "no_criteria" | "unlinked";
export type WithdrawReason = Exclude<HeldReason, "no_criteria">;

/** What the plan reads of a link row. */
export interface LinkFacts {
  state: LinkState;
  heldReason: HeldReason | null;
  /** When a person last accepted it: a link held after an acceptance stays held until one accepts again. */
  acceptedAt: string | null;
  acceptedFingerprint: string | null;
  acceptedCompletedAt: string | null;
  afterPayment: boolean;
}

/** What Linear said of the issue just now, as the plan needs it. */
export type ReadFacts =
  | { kind: "issue"; completed: boolean; canceled: boolean; archived: boolean; completedAt: string | null; fingerprint: string }
  | { kind: "gone"; reason: "not_found" | "forbidden" };

export type ReadPlan =
  /** Move the link to this state (the same one is no move), with no milestone touched. */
  | { kind: "set"; state: Exclude<LinkState, "accepted">; heldReason: HeldReason | null; becameReady: boolean }
  /** Accepted, and still what was accepted. */
  | { kind: "keep" }
  /** Take the acceptance back, through `hold_linear_acceptance`, which holds the milestone for review before payment. */
  | { kind: "withdraw"; reason: WithdrawReason };

const sameInstant = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));

export function planRead(link: LinkFacts, read: ReadFacts, options: { criteria: boolean }): ReadPlan {
  if (link.state === "accepted") {
    if (read.kind === "gone") return { kind: "withdraw", reason: "issue_unreachable" };
    if (read.archived) return { kind: "withdraw", reason: "archived" };
    if (read.canceled) return { kind: "withdraw", reason: "canceled" };
    // Reopened, or reopened and completed again between two reads: its completion is not the one accepted.
    if (!read.completed || !sameInstant(read.completedAt, link.acceptedCompletedAt)) return { kind: "withdraw", reason: "reopened" };
    if (read.fingerprint !== link.acceptedFingerprint) return { kind: "withdraw", reason: "deliverable_changed" };
    return { kind: "keep" };
  }
  // Held after an acceptance: for a person to review, whatever Linear says now. A person accepts again, or unlinks it.
  if (link.state === "held" && (link.acceptedAt !== null || link.afterPayment) && link.heldReason !== "no_criteria") {
    return { kind: "set", state: "held", heldReason: link.heldReason, becameReady: false };
  }
  if (read.kind === "gone") return { kind: "set", state: "held", heldReason: "issue_unreachable", becameReady: false };
  if (read.archived) return { kind: "set", state: "held", heldReason: "archived", becameReady: false };
  // Canceled before any acceptance: nothing will be delivered as it stands, so a person looks at it.
  if (read.canceled) return { kind: "set", state: "held", heldReason: "canceled", becameReady: false };
  if (!read.completed) return { kind: "set", state: "waiting", heldReason: null, becameReady: false };
  if (!options.criteria) return { kind: "set", state: "held", heldReason: "no_criteria", becameReady: false };
  return { kind: "set", state: "ready", heldReason: null, becameReady: link.state !== "ready" };
}

/** Whether a person may accept now, by the link alone: what the page offers, checked again on the server. */
export function acceptable(
  link: Pick<LinkFacts, "state" | "afterPayment" | "heldReason">,
  facts: { completed: boolean; archived: boolean; criteria: boolean; milestoneStatus: string }
): boolean {
  if (link.state === "accepted" || link.state === "waiting" || link.afterPayment) return false;
  if (link.state === "held" && link.heldReason === "issue_unreachable") return false;
  return facts.completed && !facts.archived && facts.criteria && facts.milestoneStatus === "pending";
}

/**
 * Who is the payee, and who would accept (LN9): the contractor or payee never accepts their own work, or approves its
 * payout. Known by the payee's email in Vestiarion (the counterparty's notice email) against the member's own; and in
 * Linear, as Asana's (A9), by the Linear user with the payee's email, against the member's own Linear user (the
 * connection's, when they connected Linear, else the one with their email).
 */
export interface Identities {
  memberEmail: string | null;
  payeeEmail: string | null;
  /** The Linear users whose email is the payee's notice email, anywhere in the Linear workspace. */
  payeeLinearIds: string[];
  /** The member's own Linear user: the connection's when they connected Linear, else the one with the member's email. */
  memberLinearIds: string[];
}

export type SelfRefusal = "payee_member" | "payee_linear";

const norm = (email: string | null) => (email ? email.trim().toLowerCase() : null);

export function selfAcceptance(identities: Identities): SelfRefusal | null {
  const member = norm(identities.memberEmail);
  if (member && member === norm(identities.payeeEmail)) return "payee_member";
  if (identities.memberLinearIds.some((id) => identities.payeeLinearIds.includes(id))) return "payee_linear";
  return null;
}

export const SELF_WORDS: Record<SelfRefusal, string> = {
  payee_member: "You are this milestone's payee, so someone else accepts the work.",
  payee_linear: "Your Linear account is this milestone's payee, so someone else accepts the work.",
};

/** The link's state in words, for the card and the evidence page. */
export function stateWords(state: LinkState, heldReason: HeldReason | null, afterPayment: boolean): { label: string; line: string } {
  switch (state) {
    case "waiting":
      return { label: "Waiting for the issue", line: "Not done in Linear yet. It is read again when it changes there." };
    case "ready":
      return { label: "Ready for acceptance", line: "Done in Linear. Check the deliverables against the criteria, then accept the work: the agent decides on pay only after that." };
    case "accepted":
      return { label: "Accepted", line: "A person accepted the work against its criteria. The agent decides on pay under every guardrail." };
    case "held":
      if (afterPayment) {
        return { label: "Changed after payment", line: "The issue changed in Linear after the payment was sent. Review it with the contractor: Vestiarion does not take a payment back." };
      }
      return { label: "Held for review", line: HELD_LINES[heldReason ?? "reopened"] };
  }
}

const HELD_LINES: Record<HeldReason, string> = {
  reopened: "The issue was reopened in Linear after the work was accepted, so the acceptance was taken back before any payment. Accept it again once it is done.",
  canceled: "The issue was canceled in Linear. Nothing is accepted from a canceled issue: move it back, or link another issue.",
  deliverable_changed: "The deliverables changed in Linear after the work was accepted, so the acceptance was taken back before any payment. Check the new version, then accept it again.",
  archived: "The issue was archived or deleted in Linear. Restore it there to accept it, or link another issue.",
  issue_unreachable: "Linear no longer shows this issue to the connection: it was deleted, or the person who connected Linear lost access to its team. Link another issue, or reconnect Linear.",
  no_criteria: "The issue is done, but the milestone has no acceptance criteria. Add the criteria from the agreement, then accept the work.",
  unlinked: "The issue was unlinked after the work was accepted, so the acceptance was taken back before any payment.",
};

/** The ledger actions of a Linear acceptance and of one taken back: Linear's own, so Asana's card counts none of them. */
export const ACCEPTED_ACTION = "linear_work_accepted";
export const WITHDRAWN_ACTION = "linear_acceptance_withdrawn";

/** One acceptance and what followed it, for the card's figures (LN15). */
export interface AcceptanceEvent {
  action: string;
  ts: string;
  milestoneId: string | null;
}

export interface AcceptanceKpis {
  /** Acceptances recorded in the window: each a person checking the evidence by hand. */
  manualChecks: number;
  /** Acceptances taken back in the window: the issue reopened or changed after it was accepted. */
  disputes: number;
  /** The median minutes from an acceptance to the agent's first decision on that milestone after it; null with none. */
  medianMinutesToProposal: number | null;
  proposals: number;
}

const PROPOSALS = new Set(["milestone_release", "milestone_hold"]);

/** The card's figures over the last `days` days, from the workspace's contractor entries, in any order. */
export function acceptanceKpis(events: readonly AcceptanceEvent[], nowMs: number, days = 30): AcceptanceKpis {
  const from = nowMs - days * 86_400_000;
  const inWindow = events.filter((event) => Date.parse(event.ts) >= from && Date.parse(event.ts) <= nowMs);
  const accepted = inWindow.filter((event) => event.action === ACCEPTED_ACTION && event.milestoneId);
  const proposals = events.filter((event) => PROPOSALS.has(event.action) && event.milestoneId);
  const minutes: number[] = [];
  for (const acceptance of accepted) {
    const at = Date.parse(acceptance.ts);
    const next = proposals
      .filter((event) => event.milestoneId === acceptance.milestoneId && Date.parse(event.ts) >= at)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0];
    if (next) minutes.push((Date.parse(next.ts) - at) / 60_000);
  }
  minutes.sort((a, b) => a - b);
  const median =
    minutes.length === 0 ? null : minutes.length % 2 === 1 ? minutes[(minutes.length - 1) / 2] : (minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2;
  return {
    manualChecks: accepted.length,
    disputes: inWindow.filter((event) => event.action === WITHDRAWN_ACTION).length,
    medianMinutesToProposal: median === null ? null : Math.round(median * 10) / 10,
    proposals: minutes.length,
  };
}
