import { WAITING_STATUSES } from "../agent/approvals";
import { db } from "../dal";
import { ONBOARDING_MARKS, type OnboardingMark } from "./role-checklists";

/**
 * What a member's checklist is ticked from, in the workspace in scope (docs/superpowers/specs/2026-10-13-role-onboarding-
 * evidence-access-design.md R4): the marks of migration 0114, and the person's own signed acts in the ledger. Reads go
 * through `db()` only, so row-level security confines them to the workspace; the person is the session's, passed in by
 * the page, never a value from a form.
 *
 * Until 0114 runs, the marks read as not set up (42P01, PGRST205, 42703): `available` is false, nothing is marked, and
 * the page shows each checklist from the other rows, without its Dismiss button. Recording a mark then saves nothing.
 */

const KNOWN: ReadonlySet<string> = new Set(ONBOARDING_MARKS);

/** Postgres's or PostgREST's "no such table" or "no such column": the migration has not run here yet. */
export function onboardingNotSetUp(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (["42P01", "PGRST205", "42703", "PGRST204"].includes(error.code ?? "")) return true;
  return /onboarding_marks/.test(error.message ?? "") && /schema cache|does not exist/.test(error.message ?? "");
}

export interface OnboardingMarksRead {
  /** False until migration 0114 has run here, or when the read failed. */
  available: boolean;
  /** This person's marks in this workspace. */
  mine: ReadonlySet<OnboardingMark>;
  /** Anyone in the workspace kept its limits as they are: the limits are the workspace's, not one person's. */
  limitsConfirmed: boolean;
}

const NONE: OnboardingMarksRead = { available: false, mine: new Set(), limitsConfirmed: false };

/** The workspace's marks for this person, and whether anyone kept the limits. Never throws. */
export async function readOnboardingMarks(userId: string): Promise<OnboardingMarksRead> {
  try {
    const result = await db().from("onboarding_marks").select("user_id, mark").limit(1000);
    if (result.error) {
      if (!onboardingNotSetUp(result.error)) console.error("onboarding: marks not read", result.error.message);
      return NONE;
    }
    const rows = (result.data ?? []) as Array<{ user_id: string; mark: string }>;
    const mine = new Set(rows.filter((row) => row.user_id === userId && KNOWN.has(row.mark)).map((row) => row.mark as OnboardingMark));
    return { available: true, mine, limitsConfirmed: rows.some((row) => row.mark === "limits_confirmed") };
  } catch (error) {
    console.error("onboarding: marks not read", error instanceof Error ? error.message : "unknown error");
    return NONE;
  }
}

/**
 * Records that this person did what the marks name, once each: a mark already there is left as it is. Best effort: true
 * once saved, false before migration 0114 runs or when the write fails, which the page never fails on.
 */
export async function recordOnboardingMarks(userId: string, marks: readonly OnboardingMark[]): Promise<boolean> {
  const wanted = [...new Set(marks)].filter((mark) => KNOWN.has(mark));
  if (wanted.length === 0) return true;
  try {
    const result = await db()
      .from("onboarding_marks")
      .upsert(
        wanted.map((mark) => ({ user_id: userId, mark })),
        { onConflict: "org_id,user_id,mark", ignoreDuplicates: true }
      );
    if (result.error) {
      if (!onboardingNotSetUp(result.error)) console.error("onboarding: marks not recorded", result.error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error("onboarding: marks not recorded", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

/** A person deciding what the agent held: a payable approved, rejected or returned, a verdict, a milestone paid or closed. */
export const DECISION_ACTIONS = [
  "approval_given",
  "approval_paid",
  "approval_rejected",
  "approval_returned",
  "decision_verdict",
  "milestone_approval_given",
  "milestone_approval_paid",
  "milestone_closed",
] as const;
/** An accountant's own acts: a booking approved, money received applied, a month handed off. */
const BOOKED = "accounting_payment_approved";
const APPLIED = "ar_payment_applied";
const HANDED_OFF = "handoff_exported";
/** The workspace's limits set by a person: the agent's spending limit, or the figure above which two approvals are needed. */
export const LIMIT_ACTIONS = ["agent_budget_changed", "approval_policy_changed"] as const;

export interface PersonActs {
  decided: boolean;
  booked: boolean;
  applied: boolean;
  handedOff: boolean;
}

const NO_ACTS: PersonActs = { decided: false, booked: false, applied: false, handedOff: false };

/**
 * What this person did, from the workspace's signed ledger: each of these entries names who acted (`detail.by`). The
 * agent's own matching of a payment (`ar_payment_applied` with `by: null`) is never this person's. Never throws: a read
 * that fails ticks nothing.
 */
export async function readPersonActs(userId: string): Promise<PersonActs> {
  try {
    const result = await db()
      .from("ledger_entries")
      .select("action")
      .in("action", [...DECISION_ACTIONS, BOOKED, APPLIED, HANDED_OFF])
      .eq("actor", "human")
      .eq("detail->>by", userId)
      .order("seq", { ascending: false })
      .limit(200);
    if (result.error) {
      console.error("onboarding: acts not read", result.error.message);
      return NO_ACTS;
    }
    const actions = new Set(((result.data ?? []) as Array<{ action: string }>).map((row) => row.action));
    return {
      decided: DECISION_ACTIONS.some((action) => actions.has(action)),
      booked: actions.has(BOOKED),
      applied: actions.has(APPLIED),
      handedOff: actions.has(HANDED_OFF),
    };
  } catch (error) {
    console.error("onboarding: acts not read", error instanceof Error ? error.message : "unknown error");
    return NO_ACTS;
  }
}

/**
 * Whether a bill waits on Approvals now, as the page lists them (`listWaitingPayables`): what opening it shows an approver,
 * its reasons on its card (R2). Never throws: a read that fails says none waits, and ticks nothing.
 */
export async function billWaitingOnApprovals(): Promise<boolean> {
  try {
    const result = await db().from("invoices").select("id").eq("direction", "payable").in("status", [...WAITING_STATUSES]).limit(1);
    if (result.error) {
      console.error("onboarding: waiting bills not read", result.error.message);
      return false;
    }
    return ((result.data ?? []) as unknown[]).length > 0;
  } catch (error) {
    console.error("onboarding: waiting bills not read", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

/** Whether a person set the workspace's limits: its spending limit or its two-approval figure. Never throws. */
export async function readLimitsSet(): Promise<boolean> {
  try {
    const result = await db().from("ledger_entries").select("seq").in("action", [...LIMIT_ACTIONS]).eq("actor", "human").limit(1);
    if (result.error) {
      console.error("onboarding: limits not read", result.error.message);
      return false;
    }
    return ((result.data ?? []) as unknown[]).length > 0;
  } catch (error) {
    console.error("onboarding: limits not read", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}
