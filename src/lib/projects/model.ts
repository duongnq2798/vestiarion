import { formatMinor, parseMinor } from "../deals/money";

/**
 * Projects (docs/superpowers/specs/2026-10-13-project-budgets-design.md): a budget in USDC, a buffer kept back from it,
 * and what is set aside for the project's open bills and milestones. An earmark in the application: the treasury stays
 * one pool, nothing is locked on chain, and a payment still needs its cash when it is sent. Pure and browser-safe; the
 * database's figures are read in `read.ts`, and counted there exactly as migration 0111's reservation check counts them.
 */

/** A project counts in USDC cents. */
export const PROJECT_CURRENCY = "USDC";
export const PROJECT_DIGITS = 2;

/** At most this many characters name a project, as migration 0111 checks. */
export const PROJECT_NAME_MAX = 80;

/** The ledger entries a project's changes are signed as (domain `ap`). */
export const PROJECT_ACTIONS = {
  created: "project_created",
  changed: "project_changed",
  assigned: "project_assigned",
} as const;

export type ProjectStatus = "active" | "archived";

export interface Project {
  id: string;
  name: string;
  budgetMinor: number;
  bufferMinor: number;
  status: ProjectStatus;
  createdAt: string;
}

/** What `project_figures` (0111) counts for one project, in USDC cents. */
export interface ProjectMoney {
  /** Set aside now for open bills and milestones. */
  reservedMinor: number;
  /** Paid: bills at what their transfer carried, and milestones. */
  paidMinor: number;
  /** Open bills and milestones: not paid, rejected or closed. */
  openMinor: number;
  openCount: number;
  /** Of those, what holds no reservation: over the budget when it was weighed, or not weighed yet. */
  unreservedMinor: number;
  unreservedCount: number;
}

export const NO_MONEY: ProjectMoney = { reservedMinor: 0, paidMinor: 0, openMinor: 0, openCount: 0, unreservedMinor: 0, unreservedCount: 0 };

/** Payments the agent held for a project's budget, from its signed decisions. */
export interface ProjectHolds {
  /** Bills and milestones still held for it now. */
  now: number;
  /** Decisions held for it in the last 30 days. */
  last30Days: number;
}

export interface ProjectFigures extends ProjectMoney {
  budgetMinor: number;
  bufferMinor: number;
  /** What the agent may still set aside: the budget, less its buffer, less what is reserved and paid. Below zero when over. */
  availableMinor: number;
  /** Reserved and paid together: the money the project has committed. */
  committedMinor: number;
  /** How far reserved and paid go past the budget less its buffer, or 0. */
  overMinor: number;
  /** The share of the open bills and milestones, by amount, that holds a reservation; null with nothing open. */
  coveragePercent: number | null;
  holds: ProjectHolds;
}

export function projectFigures(project: Pick<Project, "budgetMinor" | "bufferMinor">, money: ProjectMoney, holds: ProjectHolds = { now: 0, last30Days: 0 }): ProjectFigures {
  const committedMinor = money.reservedMinor + money.paidMinor;
  const availableMinor = project.budgetMinor - project.bufferMinor - committedMinor;
  const coveredMinor = Math.max(0, money.openMinor - money.unreservedMinor);
  return {
    ...money,
    budgetMinor: project.budgetMinor,
    bufferMinor: project.bufferMinor,
    availableMinor,
    committedMinor,
    overMinor: Math.max(0, -availableMinor),
    coveragePercent: money.openMinor > 0 ? Math.floor((coveredMinor / money.openMinor) * 100) : null,
    holds,
  };
}

/**
 * A bill's or milestone's amount in USDC cents, to the cent above: what it sets aside and counts as paid
 * (`project_minor`, 0111). Exact on the six decimals an amount carries.
 */
export function obligationMinor(amount: number | string): number {
  const text = typeof amount === "number" ? amount.toFixed(6) : amount.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return Math.ceil(Number(amount) * 100);
  const micro = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  return Number((micro + 9_999n) / 10_000n);
}

/** USDC cents for a person: `1,250.50 USDC`. */
export function usdcMinor(minor: number): string {
  return `${formatMinor(minor, PROJECT_DIGITS)} ${PROJECT_CURRENCY}`;
}

export interface ProjectDraft {
  name: string;
  budgetMinor: number;
  bufferMinor: number;
}

export type ProjectFormField = "name" | "budget" | "buffer";

/** The new project form, or a change to one: a name, a budget, and a buffer within the budget (0 when left empty). */
export function parseProjectForm(input: { name: string; budget: string; buffer: string }): { ok: true; draft: ProjectDraft } | { ok: false; field: ProjectFormField; message: string } {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) return { ok: false, field: "name", message: "Name the project." };
  if (name.length > PROJECT_NAME_MAX) return { ok: false, field: "name", message: `A project's name is at most ${PROJECT_NAME_MAX} characters.` };
  const budgetMinor = parseMinor(input.budget, PROJECT_CURRENCY, { allowZero: true });
  if (budgetMinor === null) return { ok: false, field: "budget", message: "Enter the budget in USDC, for example 12,000 or 12000.00." };
  const bufferText = input.buffer.trim();
  const bufferMinor = bufferText === "" ? 0 : parseMinor(bufferText, PROJECT_CURRENCY, { allowZero: true });
  if (bufferMinor === null) return { ok: false, field: "buffer", message: "Enter the buffer in USDC, or leave it empty for none." };
  if (bufferMinor > budgetMinor) return { ok: false, field: "buffer", message: "The buffer is part of the budget, so it cannot be more than the budget." };
  return { ok: true, draft: { name, budgetMinor, bufferMinor } };
}

/** What a bill or milestone of a project is, as its page lists it. */
export type ProjectWorkState = "reserved" | "not_reserved" | "paid" | "closed";

export interface ProjectWork {
  kind: "bill" | "milestone";
  id: string;
  label: string;
  counterpartyName: string;
  amountMinor: number;
  status: string;
  state: ProjectWorkState;
  /** Held by the agent for the project's budget, as its newest decision says. */
  heldForBudget: boolean;
  /** Held by the agent as the same work as another bill or milestone. */
  heldAsSameWork: boolean;
  dueOn: string | null;
}

const CLOSED_BILL = new Set(["rejected"]);
const CLOSED_MILESTONE = new Set(["closed"]);

/** Where one bill or milestone of a project stands: paid, closed, or open with or without its money set aside. */
export function workState(kind: "bill" | "milestone", status: string, reserved: boolean): ProjectWorkState {
  if (status === "paid") return "paid";
  if ((kind === "bill" ? CLOSED_BILL : CLOSED_MILESTONE).has(status)) return "closed";
  return reserved ? "reserved" : "not_reserved";
}

export const WORK_STATE_WORDS: Record<ProjectWorkState, string> = {
  reserved: "Set aside",
  not_reserved: "Not set aside",
  paid: "Paid",
  closed: "Closed",
};

/** One sentence on a project's money, for its card. */
export function figuresSentence(figures: ProjectFigures): string {
  if (figures.overMinor > 0) return `Over by ${usdcMinor(figures.overMinor)}: the agent sets nothing more aside until money is released or the budget is raised.`;
  if (figures.unreservedCount > 0) {
    return `${figures.unreservedCount === 1 ? "One bill or milestone waits" : `${figures.unreservedCount} bills or milestones wait`} for room: ${usdcMinor(figures.unreservedMinor)} not set aside.`;
  }
  return `${usdcMinor(Math.max(0, figures.availableMinor))} left to set aside.`;
}
