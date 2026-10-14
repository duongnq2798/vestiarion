/**
 * Accepting contractor work delivered in Asana (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A7 to
 * A10, A14): what a read of a linked task does to the link, who may accept the work, and the figures the Asana card
 * shows. Pure and browser-safe: no I/O, no clock of its own.
 *
 * The rules:
 * - A completed task is never by itself proof of quality, and never permission to move money: it makes the link
 *   **ready for acceptance**, and only a person's acceptance verifies the milestone.
 * - Without acceptance criteria the link is held: a completed task waits for a person to write them.
 * - After acceptance, a task reopened (or reopened and completed again), a deliverable changed, or a task Asana no
 *   longer shows takes the acceptance back (`withdraw`), before payment executes; the milestone is held for review.
 * - A held link stays held until a person accepts again: no read moves it back to accepted.
 * - Nothing here names an amount, a payee or an address.
 */

export type LinkState = "waiting" | "ready" | "accepted" | "held";
export type HeldReason = "reopened" | "deliverable_changed" | "task_unreachable" | "no_criteria" | "unlinked";
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

/** What Asana said of the task just now, as the plan needs it. */
export type ReadFacts = { kind: "task"; completed: boolean; completedAt: string | null; fingerprint: string } | { kind: "gone"; reason: "not_found" | "forbidden" };

export type ReadPlan =
  /** Move the link to this state (the same one is no move), with no milestone touched. */
  | { kind: "set"; state: Exclude<LinkState, "accepted">; heldReason: HeldReason | null; becameReady: boolean }
  /** Accepted, and still what was accepted. */
  | { kind: "keep" }
  /** Take the acceptance back, through `hold_asana_acceptance`, which holds the milestone for review before payment. */
  | { kind: "withdraw"; reason: WithdrawReason };

const sameInstant = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));

export function planRead(link: LinkFacts, read: ReadFacts, options: { criteria: boolean }): ReadPlan {
  if (link.state === "accepted") {
    if (read.kind === "gone") return { kind: "withdraw", reason: "task_unreachable" };
    // Reopened, or reopened and completed again between two reads: its completion is not the one accepted.
    if (!read.completed || !sameInstant(read.completedAt, link.acceptedCompletedAt)) return { kind: "withdraw", reason: "reopened" };
    if (read.fingerprint !== link.acceptedFingerprint) return { kind: "withdraw", reason: "deliverable_changed" };
    return { kind: "keep" };
  }
  // Held after an acceptance: for a person to review, whatever Asana says now. A person accepts again, or unlinks it.
  if (link.state === "held" && (link.acceptedAt !== null || link.afterPayment) && link.heldReason !== "no_criteria") {
    return { kind: "set", state: "held", heldReason: link.heldReason, becameReady: false };
  }
  if (read.kind === "gone") return { kind: "set", state: "held", heldReason: "task_unreachable", becameReady: false };
  if (!read.completed) return { kind: "set", state: "waiting", heldReason: null, becameReady: false };
  if (!options.criteria) return { kind: "set", state: "held", heldReason: "no_criteria", becameReady: false };
  return { kind: "set", state: "ready", heldReason: null, becameReady: link.state !== "ready" };
}

/** Whether a person may accept now, by the link alone: what the page offers, checked again on the server. */
export function acceptable(link: Pick<LinkFacts, "state" | "afterPayment" | "heldReason">, facts: { completed: boolean; criteria: boolean; milestoneStatus: string }): boolean {
  if (link.state === "accepted" || link.state === "waiting" || link.afterPayment) return false;
  if (link.state === "held" && link.heldReason === "task_unreachable") return false;
  return facts.completed && facts.criteria && facts.milestoneStatus === "pending";
}

/**
 * Who is the payee, and who would accept (A9): the contractor or payee never accepts their own work, or approves its
 * payout. Known by the payee's email in Vestiarion (the counterparty's notice email) against the member's own, and by
 * Asana's user mapping where there is one: the Asana user with the payee's email against the member's Asana user (by
 * their email, or the connection's own user when they connected it).
 */
export interface Identities {
  memberEmail: string | null;
  payeeEmail: string | null;
  memberAsanaGid: string | null;
  payeeAsanaGid: string | null;
}

export type SelfRefusal = "payee_member" | "payee_asana";

const norm = (email: string | null) => (email ? email.trim().toLowerCase() : null);

export function selfAcceptance(identities: Identities): SelfRefusal | null {
  const member = norm(identities.memberEmail);
  if (member && member === norm(identities.payeeEmail)) return "payee_member";
  if (identities.memberAsanaGid && identities.memberAsanaGid === identities.payeeAsanaGid) return "payee_asana";
  return null;
}

export const SELF_WORDS: Record<SelfRefusal, string> = {
  payee_member: "You are this milestone's payee, so someone else accepts the work.",
  payee_asana: "Your Asana account is this milestone's payee, so someone else accepts the work.",
};

/** The link's state in words, for the card and the evidence page. */
export function stateWords(state: LinkState, heldReason: HeldReason | null, afterPayment: boolean): { label: string; line: string } {
  switch (state) {
    case "waiting":
      return { label: "Waiting for the task", line: "Not completed in Asana yet. It is read again when it changes there." };
    case "ready":
      return { label: "Ready for acceptance", line: "Completed in Asana. Check the deliverables against the criteria, then accept the work: the agent decides on pay only after that." };
    case "accepted":
      return { label: "Accepted", line: "A person accepted the work against its criteria. The agent decides on pay under every guardrail." };
    case "held":
      if (afterPayment) {
        return { label: "Changed after payment", line: "The task changed in Asana after the payment was sent. Review it with the contractor: Vestiarion does not take a payment back." };
      }
      return { label: "Held for review", line: HELD_LINES[heldReason ?? "reopened"] };
  }
}

const HELD_LINES: Record<HeldReason, string> = {
  reopened: "The task was reopened in Asana after the work was accepted, so the acceptance was taken back before any payment. Accept it again once it is completed.",
  deliverable_changed: "The deliverables changed in Asana after the work was accepted, so the acceptance was taken back before any payment. Check the new version, then accept it again.",
  task_unreachable: "Asana no longer shows this task to the connection: it was deleted, or the person who connected Asana lost access. Link another task, or reconnect Asana.",
  no_criteria: "The task is completed, but the milestone has no acceptance criteria. Add the criteria from the agreement, then accept the work.",
  unlinked: "The task was unlinked after the work was accepted, so the acceptance was taken back before any payment.",
};

/** One acceptance and what followed it, for the card's figures (A14). */
export interface AcceptanceEvent {
  action: string;
  ts: string;
  milestoneId: string | null;
}

export interface AcceptanceKpis {
  /** Acceptances recorded in the window: each a person checking the evidence by hand. */
  manualChecks: number;
  /** Acceptances taken back in the window: the task reopened or changed after it was accepted. */
  disputes: number;
  /** The median minutes from an acceptance to the agent's first decision on that milestone after it; null with none. */
  medianMinutesToProposal: number | null;
  proposals: number;
}

const ACCEPTED = "milestone_accepted";
const WITHDRAWN = "milestone_acceptance_withdrawn";
const PROPOSALS = new Set(["milestone_release", "milestone_hold"]);

/** The card's figures over the last `days` days, from the workspace's contractor entries, in any order. */
export function acceptanceKpis(events: readonly AcceptanceEvent[], nowMs: number, days = 30): AcceptanceKpis {
  const from = nowMs - days * 86_400_000;
  const inWindow = events.filter((event) => Date.parse(event.ts) >= from && Date.parse(event.ts) <= nowMs);
  const accepted = inWindow.filter((event) => event.action === ACCEPTED && event.milestoneId);
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
    disputes: inWindow.filter((event) => event.action === WITHDRAWN).length,
    medianMinutesToProposal: median === null ? null : Math.round(median * 10) / 10,
    proposals: minutes.length,
  };
}

/** "under a minute", "4 minutes", "2.5 hours". */
export function durationWords(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${Math.round(minutes)} ${Math.round(minutes) === 1 ? "minute" : "minutes"}`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hours`;
}
