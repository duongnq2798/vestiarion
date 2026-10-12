import { missingDetails, waitingHint, type AddedDetails, type OnFile } from "@/lib/added-details";
import { approvalAnchor } from "@/lib/auth/org-paths";
import { utcDay } from "@/lib/copy";
import { MATCH_INCOMPLETE, ruleNextStep } from "@/lib/next-step";
import type { PayLinkState } from "@/lib/platform/pay-links";
import { payableSignals } from "./decision-signals";
import type { Decision } from "./types";

/**
 * What a row on Bills & receivables says before it is opened (docs/superpowers/specs/2026-10-12-bills-tabs-design.md
 * B6): what stands in a bill's way, the one thing a person does next, and where a receivable's reminders stand. Pure
 * words over what the card already knows: the detail keeps the reasoning and the actions, and the server decides
 * everything they do.
 */

export interface NextStep {
  text: string;
  /** held: a person is needed; agent: the agent asks a person; muted: a fact, nothing to do. */
  tone: "held" | "agent" | "muted";
  /** A page that does it, relative to the workspace; without one, the row's detail holds the action. */
  href?: string;
  opens?: "detail";
}

export interface NextStepFacts {
  status: string;
  /** For a bill waiting for a person: the purchase order and goods receipt on file, and what was added since. */
  waiting: { onFile: OnFile; added: AddedDetails | null } | undefined;
  /** The guardrail rule that stopped it, or the hold it is under. */
  rule: string | null;
  /** An owner or admin: adds details, fixes what a rule checked. */
  canWrite: boolean;
  /** Decides payments in Approvals. */
  canDecide: boolean;
  counterparty: { id: string; name: string };
}

const APPROVALS = (id: string): NextStep => ({ text: "Decide in Approvals", tone: "held", href: `/approvals#${approvalAnchor(id)}` });

/** What the three-way match lacks, as the thing to do. */
function addWords(missing: { poReference: boolean; goodsReceived: boolean }): string {
  if (missing.poReference && missing.goodsReceived) return "Add the purchase order and goods receipt";
  return missing.poReference ? "Add the purchase order" : "Confirm the goods were received";
}

/**
 * The one thing a person does next on a bill, in the order its card offers it (`WaitingPayableAction`): a verdict the
 * agent asks for, the details the match lacks, the fix for a rule, Approvals. None for a bill on its way.
 */
export function billNextStep(decision: Decision, facts: NextStepFacts): NextStep | null {
  if (decision.domain !== "ap") return null;
  const verdict = decision.verdict;
  if (verdict && verdict.heldForVerdict && verdict.open && verdict.given === null) return { text: "Give your verdict", tone: "agent", opens: "detail" };

  const refused = decision.outcome === "refused";
  if (facts.waiting) {
    if (facts.waiting.added) return { text: waitingHint(facts.waiting.onFile, facts.waiting.added) as string, tone: "muted", opens: "detail" };
    const step = ruleNextStep(facts.rule, facts.counterparty);
    const missing = missingDetails(facts.waiting.onFile);
    if (facts.canWrite && missing && (step === null || facts.rule === MATCH_INCOMPLETE)) return { text: addWords(missing), tone: "held", opens: "detail" };
    if (facts.canWrite && step?.fix && facts.rule !== MATCH_INCOMPLETE) return { text: step.fix.label, tone: "held", href: step.fix.path };
    if (facts.canDecide) return APPROVALS(decision.id);
    return { text: "Waits for an owner or approver", tone: "muted", opens: "detail" };
  }
  if (refused) return facts.canDecide ? APPROVALS(decision.id) : { text: "Refused by a rule", tone: "held", opens: "detail" };
  return null;
}

/**
 * What stands in a bill's way, a word or two each, from the checks its card shows: only those marked in the way. A
 * shadow-mode hold has none: its row says why it waits instead ("Shadow mode: it waits for a person to agree.").
 */
export function billBlockers(decision: Decision): string[] {
  if (decision.domain !== "ap") return [];
  return payableSignals(decision)
    .filter((signal) => signal.state === "missing")
    .map((signal) => signal.label);
}

const day = (iso: string) => utcDay(iso);

/** Where a receivable's reminders stand, from its pay link (collections R1, R2); null with no link. Never that money came in. */
export function collectionState(link: PayLinkState | null | undefined, today: string): string | null {
  if (!link) return null;
  if (link.remindersOnAt) {
    if (link.deferredUntil && link.deferredUntil.slice(0, 10) > today) return `Reminders paused until ${day(link.deferredUntil)}`;
    const last = link.sent.at(-1);
    return last ? `Reminder ${last.number} sent ${day(last.sentAt)}` : "Reminders on";
  }
  return link.url || link.legacy ? "Pay link ready · reminders off" : null;
}
