import {
  acceptanceKpis as linearKpis,
  type AcceptanceEvent,
  type AcceptanceKpis,
  type HeldReason as LinearHeldReason,
  type LinkState,
  type ReadPlan,
  type WithdrawReason as LinearWithdrawReason,
} from "../linear/acceptance";

/**
 * Accepting contractor work delivered in Jira (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR9 to JR13,
 * JR21): what a read of a linked issue does to the link, who may accept the work, and the figures the Jira card shows.
 * Pure and browser-safe: no I/O, no clock of its own. The rules are Linear's (`../linear/acceptance`), reused, not copied:
 * - An issue done in Jira is never by itself proof of quality, and never permission to move money: anyone on the Jira
 *   site can move it to Done, the contractor included. It makes the link **ready for acceptance**, and only a person's
 *   acceptance verifies the milestone.
 * - Without acceptance criteria the link is held: a done issue waits for a person to write them.
 * - After acceptance, an issue reopened (or done again at another time), resolved as not done, with a deliverable
 *   changed, or no longer shown by Jira takes the acceptance back before payment executes; the milestone is held.
 * - A held link stays held until a person accepts again: no read moves it back to accepted.
 * - Nothing here names an amount, a payee or an address.
 *
 * Jira has no archived state of its own (JR10): what Jira answers for an archived issue is whatever it answers, a 404
 * most likely, so every read here says `archived: false`, and Jira's held reasons are Linear's without it.
 */

export { acceptable, planRead, type LinkFacts, type LinkState, type ReadFacts, type ReadPlan } from "../linear/acceptance";

export type HeldReason = Exclude<LinearHeldReason, "archived">;
export type WithdrawReason = Exclude<HeldReason, "no_criteria">;

/**
 * The one narrowing (JR10): no Jira read says `archived`, so Linear's plan never answers it; were it ever to, the issue is
 * one Jira no longer shows the connection.
 */
export function heldReasonOf(reason: LinearWithdrawReason): WithdrawReason;
export function heldReasonOf(reason: LinearHeldReason | null): HeldReason | null;
export function heldReasonOf(reason: LinearHeldReason | null): HeldReason | null {
  return reason === "archived" ? "issue_unreachable" : reason;
}

/** Linear's plan in Jira's reasons. */
export type JiraReadPlan =
  | { kind: "set"; state: Exclude<LinkState, "accepted">; heldReason: HeldReason | null; becameReady: boolean }
  | { kind: "keep" }
  | { kind: "withdraw"; reason: WithdrawReason };

export function jiraPlan(plan: ReadPlan): JiraReadPlan {
  if (plan.kind === "set") return { ...plan, heldReason: heldReasonOf(plan.heldReason) };
  if (plan.kind === "withdraw") return { kind: "withdraw", reason: heldReasonOf(plan.reason) };
  return plan;
}

/**
 * Who is the payee, and who would accept (JR12), as Linear's (LN9): the contractor or payee never accepts their own
 * work, or approves its payout. Known by the payee's email in Vestiarion (the counterparty's notice email) against the
 * member's own; and in Jira, by the Atlassian accounts found by the payee's email on the site, against the member's own
 * account (the connection's, `/myself`, when they connected Jira, else the one found by their email). The account ids are
 * compared here, in memory, and never kept (JR19).
 */
export interface Identities {
  memberEmail: string | null;
  payeeEmail: string | null;
  /** The Atlassian accounts found by the payee's notice email on the connected site. */
  payeeJiraIds: string[];
  /** The member's own Atlassian account: the connection's when they connected Jira, else the one found by their email. */
  memberJiraIds: string[];
}

export type SelfRefusal = "payee_member" | "payee_jira";

const norm = (email: string | null) => (email ? email.trim().toLowerCase() : null);

export function selfAcceptance(identities: Identities): SelfRefusal | null {
  const member = norm(identities.memberEmail);
  if (member && member === norm(identities.payeeEmail)) return "payee_member";
  if (identities.memberJiraIds.some((id) => identities.payeeJiraIds.includes(id))) return "payee_jira";
  return null;
}

export const SELF_WORDS: Record<SelfRefusal, string> = {
  payee_member: "You are this milestone's payee, so someone else accepts the work.",
  payee_jira: "Your Atlassian account is this milestone's payee, so someone else accepts the work.",
};

/** Why a link is held, in the card's words (JR22). A canceled issue's line names Jira's resolution when it is known. */
export const HELD_LINES: Record<HeldReason, string> = {
  reopened: "The issue was reopened in Jira after the work was accepted, so the acceptance was taken back before any payment. Accept it again once it is done.",
  canceled: "Jira resolved the issue as not done. Nothing is accepted from it: reopen it, or link another issue.",
  deliverable_changed: "The deliverables changed in Jira after the work was accepted, so the acceptance was taken back before any payment. Check the new version, then accept it again.",
  issue_unreachable:
    "Jira no longer shows this issue to the connection: it was deleted or archived, the person who connected Jira lost access to its project, or another Jira site is connected now. Restore it, link another issue, or reconnect Jira.",
  no_criteria: "The issue is done, but the milestone has no acceptance criteria. Add the criteria from the agreement, then accept the work.",
  unlinked: "The issue was unlinked after the work was accepted, so the acceptance was taken back before any payment.",
};

const canceledLine = (resolution: string) => `Jira resolved the issue as ${resolution}, which is not done. Nothing is accepted from it: reopen it, or link another issue.`;

/** The link's state in words, for the card and the evidence page; `resolutionName` is Jira's own, as last read. */
export function stateWords(state: LinkState, heldReason: HeldReason | null, afterPayment: boolean, resolutionName: string | null = null): { label: string; line: string } {
  switch (state) {
    case "waiting":
      return { label: "Waiting for the issue", line: "Not done in Jira yet. It is read again when it changes there. Deliverables are read once it is done." };
    case "ready":
      return { label: "Ready for acceptance", line: "Done in Jira. Check the deliverables against the criteria, then accept the work: the agent decides on pay only after that." };
    case "accepted":
      return { label: "Accepted", line: "A person accepted the work against its criteria. The agent decides on pay under every guardrail." };
    case "held": {
      if (afterPayment) {
        return { label: "Changed after payment", line: "The issue changed in Jira after the payment was sent. Review it with the contractor: Vestiarion does not take a payment back." };
      }
      const reason = heldReason ?? "reopened";
      return { label: "Held for review", line: reason === "canceled" && resolutionName ? canceledLine(resolutionName) : HELD_LINES[reason] };
    }
  }
}

/** The ledger actions of a Jira acceptance and of one taken back: Jira's own, so Asana's and Linear's cards count none. */
export const ACCEPTED_ACTION = "jira_work_accepted";
export const WITHDRAWN_ACTION = "jira_acceptance_withdrawn";

export type { AcceptanceEvent, AcceptanceKpis } from "../linear/acceptance";

/** The card's figures (JR21): Linear's rule, over Jira's two actions only. */
export function acceptanceKpis(events: readonly AcceptanceEvent[], nowMs: number, days = 30): AcceptanceKpis {
  return linearKpis(events, nowMs, days, { accepted: ACCEPTED_ACTION, withdrawn: WITHDRAWN_ACTION });
}
