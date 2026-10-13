import type { ApGuardrailResult } from "./guardrails";
import { usdcMinor } from "../projects/model";
import type { ReserveAnswer, ReservedFigures } from "../projects/reserve";
import { SAME_WORK_RULE, type SameWorkMatch } from "../projects/same-work";

/**
 * The two checks that run after every other guardrail, for a payment the agent would make or schedule
 * (docs/superpowers/specs/2026-10-13-project-budgets-design.md P5, P9):
 *
 * - `obligation.duplicate_reference`: a bill and a milestone for the same purchase order or the same delivered work;
 *   the second waits for a person.
 * - `project.budget_exceeded`: a bill or milestone of a project whose budget, less its buffer, cannot hold it; nothing
 *   is set aside for it, and it waits for a person.
 *
 * Each can only hold. A payment another check stopped is left exactly as it was, so the agent never pays anything it
 * would not have paid before (`afterGuardrails`; tests/obligation-checks.test.ts). Pure; the reservation itself is the
 * database's (src/lib/projects/reserve.ts).
 */

export { SAME_WORK_RULE };
export const PROJECT_BUDGET_RULE = "project.budget_exceeded";
export type ObligationRule = typeof SAME_WORK_RULE | typeof PROJECT_BUDGET_RULE;

/** `execution.heldBecause` on a decision held for its project's budget, which the follow-up reopens once there is room. */
export const HELD_FOR_PROJECT = "project_budget";

/** What the project check found for one decision: null for a bill or milestone in no project, or nothing to set aside. */
export type ProjectCheck =
  | { state: "reserved"; figures: ReservedFigures; already: boolean }
  | { state: "over"; figures: ReservedFigures }
  | { state: "archived"; figures: ReservedFigures }
  | { state: "unreadable"; projectId: string };

/** The reservation's answer as the decision weighs it. A project's money read before 0111 runs is no project. */
export function projectCheckOf(answer: ReserveAnswer): ProjectCheck | null {
  switch (answer.state) {
    case "reserved":
      return { state: "reserved", figures: figuresOf(answer), already: answer.already };
    case "over":
    case "archived":
      return { state: answer.state, figures: figuresOf(answer) };
    default:
      return null;
  }
}

function figuresOf(answer: ReservedFigures): ReservedFigures {
  return {
    projectId: answer.projectId,
    projectName: answer.projectName,
    neededMinor: answer.neededMinor,
    budgetMinor: answer.budgetMinor,
    bufferMinor: answer.bufferMinor,
    reservedMinor: answer.reservedMinor,
    paidMinor: answer.paidMinor,
    availableMinor: answer.availableMinor,
  };
}

/** What the decision's entry records of the project (`observed.project`), so its figures are on the record. */
export function projectRecord(check: ProjectCheck): Record<string, unknown> {
  if (check.state === "unreadable") return { id: check.projectId, state: "unreadable" };
  const { figures } = check;
  return {
    id: figures.projectId,
    name: figures.projectName,
    state: check.state,
    ...(check.state === "reserved" ? { already: check.already } : {}),
    neededMinor: figures.neededMinor,
    budgetMinor: figures.budgetMinor,
    bufferMinor: figures.bufferMinor,
    reservedMinor: figures.reservedMinor,
    paidMinor: figures.paidMinor,
    availableMinor: figures.availableMinor,
  };
}

export interface ObligationHold {
  rule: ObligationRule;
  reasoning: string;
  /** Held for the project's budget: decided again once the project has room (`HELD_FOR_PROJECT`). */
  heldForProject: boolean;
}

type Subject = "bill" | "milestone";

const PERSON: Record<Subject, string> = {
  bill: "a person pays it in Approvals",
  milestone: "a person pays it with Pay now on Contractors",
};

/** A sentence as the middle of a guardrail note: no capital to start, no full stop to end, as the card reads the note back. */
function noteClause(sentence: string): string {
  return `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`.replace(/\.$/, "");
}

/** The same work, billed once already as the other kind: held for a person, the first match named. */
export function sameWorkHold(matches: readonly SameWorkMatch[], reasoning: string, verb: string, subject: Subject): ObligationHold | null {
  const first = matches[0];
  if (!first) return null;
  return {
    rule: SAME_WORK_RULE,
    reasoning: `${reasoning} [guardrail override: ${noteClause(first.explanation)} — ${verb} refused before execution; ${PERSON[subject]} if both are owed]`,
    heldForProject: false,
  };
}

/** A project that cannot hold it: held for a person, with the project's own figures. Null when its money was set aside. */
export function projectBudgetHold(check: ProjectCheck | null, reasoning: string, verb: string, subject: Subject): ObligationHold | null {
  if (!check || check.state === "reserved") return null;
  const then = `${PERSON[subject]}, moves it, or raises the project's budget`;
  if (check.state === "unreadable") {
    return {
      rule: PROJECT_BUDGET_RULE,
      reasoning: `${reasoning} [guardrail override: the budget of its project could not be checked — ${verb} refused before execution; held for a person]`,
      heldForProject: false,
    };
  }
  const { figures } = check;
  if (check.state === "archived") {
    return {
      rule: PROJECT_BUDGET_RULE,
      reasoning: `${reasoning} [guardrail override: its project "${figures.projectName}" is archived, so nothing more is set aside in it — ${verb} refused before execution; ${then}]`,
      heldForProject: false,
    };
  }
  const left = Math.max(0, figures.availableMinor);
  const buffer = figures.bufferMinor > 0 ? ` after its ${usdcMinor(figures.bufferMinor)} buffer` : "";
  return {
    rule: PROJECT_BUDGET_RULE,
    reasoning: `${reasoning} [guardrail override: project "${figures.projectName}" has ${usdcMinor(left)} of its ${usdcMinor(figures.budgetMinor)} budget left to set aside${buffer}, less than the ${usdcMinor(figures.neededMinor)} this needs — ${verb} refused before execution; ${then}]`,
    heldForProject: true,
  };
}

/**
 * The guardrails' result with these checks after it. A result already blocked, or a decision that pays nothing, is
 * returned as it is: these checks never let through what another stopped, and never change why it stopped.
 */
export function afterGuardrails(prior: ApGuardrailResult, action: string, hold: ObligationHold | null): ApGuardrailResult {
  if (prior.blocked || (action !== "pay" && action !== "schedule" && action !== "release") || !hold) return prior;
  return { blocked: true, status: "held", rule: hold.rule as ApGuardrailResult["rule"], reasoning: hold.reasoning };
}
