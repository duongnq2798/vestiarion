import { appVersion } from "./app-version";
import type { SurfaceKind } from "./commands/actor";
import { db } from "./dal";

/**
 * Why a person went against the agent, asked in the moment (docs/superpowers/specs/2026-10-14-capability-and-reasons-
 * design.md R9-R14): a disagreement in shadow mode, a bill rejected or returned to the agent, a bill the agent held paid
 * anyway. The reason is optional everywhere, and nothing waits on it: a person who
 * gives none goes on exactly as before, and a reason that cannot be saved never stops what they did.
 *
 * One row in `decision_reasons` (migration 0120) per reason given, with where in the product it came from (`feature`,
 * `decision`), the surface it was given on, and the build of the app that asked for it, so Vestiarion's team can see
 * which screens and which versions people disagree with most. Only the console asks for one, and says so where it asks. Every export runs inside an organization scope; reads go
 * through `db()`, so row-level security confines them to the workspace.
 *
 * Until 0120 runs here, nothing is saved and nothing is read (42P01 / PGRST205): the reasons list says it is not set up.
 */

export const REASON_MAX = 280;

/** Where in the product a reason was asked for, and what the person did there. */
export const REASON_SOURCES = {
  "shadow_mode.disagree": "Disagreed with the agent",
  "approvals.reject": "Rejected a bill",
  "approvals.return": "Returned a bill to the agent",
  "approvals.pay_held": "Paid a bill the agent held",
} as const;

export type ReasonSource = keyof typeof REASON_SOURCES;
export type ReasonFeature = ReasonSource extends `${infer F}.${string}` ? F : never;

/** How each surface is named beside a reason. */
export const SURFACE_WORDS: Record<SurfaceKind, string> = {
  console: "Console",
  slack: "Slack",
  telegram: "Telegram",
  api: "API",
  github: "GitHub",
  chrome: "Chrome extension",
};

export interface DecisionReasonInput {
  source: ReasonSource;
  surface: SurfaceKind;
  subject: "invoice" | "milestone";
  subjectId: string | null;
  reason: string | null | undefined;
  givenBy: string;
}

export interface DecisionReason {
  source: ReasonSource;
  /** What the person did, in words: "Rejected a bill". */
  what: string;
  surface: string;
  subject: string;
  subjectId: string | null;
  reason: string;
  appVersion: string;
  givenAt: string;
}

/** A reason as it is kept: trimmed, one line, at most 280 characters; null when nothing was said. */
export function cleanReason(typed: string | null | undefined): string | null {
  const reason = (typed ?? "").replace(/\s+/g, " ").trim();
  if (reason === "") return null;
  return reason.length > REASON_MAX ? reason.slice(0, REASON_MAX).trimEnd() : reason;
}

/** Postgres's or PostgREST's "no such table": migration 0120 has not run here yet. */
export function reasonsNotSetUp(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (["42P01", "PGRST205", "42703", "PGRST204"].includes(error.code ?? "")) return true;
  return /decision_reasons/.test(error.message ?? "") && /schema cache|does not exist/.test(error.message ?? "");
}

/**
 * Keeps a reason a person gave. Best effort and never throws: true once saved; false when there was nothing to keep,
 * before migration 0120 runs, or when the write failed, none of which the person's decision waits on.
 */
export async function recordDecisionReason(input: DecisionReasonInput): Promise<boolean> {
  const reason = cleanReason(input.reason);
  if (reason === null) return false;
  const [feature, decision] = input.source.split(".") as [string, string];
  try {
    const result = await db().from("decision_reasons").insert({
      feature,
      decision,
      surface: input.surface,
      subject: input.subject,
      subject_id: input.subjectId,
      reason,
      app_version: appVersion(),
      given_by: input.givenBy,
    });
    if (result.error) {
      if (!reasonsNotSetUp(result.error)) console.error("decision reason not kept", result.error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error("decision reason not kept", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

function sourceOf(feature: string, decision: string): ReasonSource | null {
  const key = `${feature}.${decision}`;
  return key in REASON_SOURCES ? (key as ReasonSource) : null;
}

export interface DecisionReasonRow {
  feature: string;
  decision: string;
  surface: string;
  subject: string;
  subject_id: string | null;
  reason: string;
  app_version: string;
  given_at: string;
}

/** A stored row, in the words a page shows; null for a feature this build does not know. */
export function reasonFromRow(row: DecisionReasonRow): DecisionReason | null {
  const source = sourceOf(row.feature, row.decision);
  if (!source) return null;
  return {
    source,
    what: REASON_SOURCES[source],
    surface: SURFACE_WORDS[row.surface as SurfaceKind] ?? row.surface,
    subject: row.subject,
    subjectId: row.subject_id,
    reason: row.reason,
    appVersion: row.app_version,
    givenAt: row.given_at,
  };
}

export interface DecisionReasonsRead {
  /** False until migration 0120 has run here, or when the read failed. */
  available: boolean;
  reasons: DecisionReason[];
}

/** The workspace's latest reasons, newest first. Never throws. */
export async function readDecisionReasons(limit = 20): Promise<DecisionReasonsRead> {
  try {
    const result = await db()
      .from("decision_reasons")
      .select("feature, decision, surface, subject, subject_id, reason, app_version, given_at")
      .order("given_at", { ascending: false })
      .limit(limit);
    if (result.error) {
      if (!reasonsNotSetUp(result.error)) console.error("decision reasons not read", result.error.message);
      return { available: false, reasons: [] };
    }
    const rows = (result.data ?? []) as DecisionReasonRow[];
    return { available: true, reasons: rows.map(reasonFromRow).filter((reason): reason is DecisionReason => reason !== null) };
  } catch (error) {
    console.error("decision reasons not read", error instanceof Error ? error.message : "unknown error");
    return { available: false, reasons: [] };
  }
}
