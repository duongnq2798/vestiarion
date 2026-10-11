import { currentOrgId } from "./context";
import { db, type OrgDb } from "./dal";
import { assertLedgerCanSign } from "./ledger";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { missingTable } from "./report-shares";
import type { BaselineState, ReportBaseline } from "./report-value";

/**
 * An owner's answer about how the business handled a bill before Vestiarion (docs/superpowers/specs/2026-10-10-shared-
 * report-design.md S8, S9): how many minutes one bill took, and how many people touched it. Each answer is a new row of
 * `report_baselines` (0095), which the tenant role can only add to, and a signed `report_baseline_answered` entry; the
 * newest answer is read. Who may answer (`org.administer`) is the command's check.
 *
 * Until migration 0095 runs, reading answers `available: false` and answering refuses with `not_ready`.
 */

export const BASELINE_ACTION = "report_baseline_answered";
export const MINUTES_MAX = 6000;
export const PEOPLE_MAX = 100;

export type BaselineErrorCode = "not_ready" | "minutes" | "people";

export const BASELINE_MESSAGES: Record<BaselineErrorCode, string> = {
  not_ready: "Your answer is not set up on this deployment yet.",
  minutes: "Type the minutes one bill took, a whole number from 1 to 6,000.",
  people: "Type how many people touched one bill, a whole number from 1 to 100.",
};

export class BaselineError extends Error {
  constructor(readonly code: BaselineErrorCode) {
    super(BASELINE_MESSAGES[code]);
    this.name = "BaselineError";
  }
}

const COLUMNS = "id, minutes_per_bill, people_per_bill, answered_by, answered_at";

type BaselineRow = { id: string; minutes_per_bill: number; people_per_bill: number; answered_by: string | null; answered_at: string };

const toBaseline = (row: BaselineRow): ReportBaseline => ({
  id: row.id,
  minutesPerBill: Number(row.minutes_per_bill),
  peoplePerBill: Number(row.people_per_bill),
  answeredBy: row.answered_by,
  answeredAt: row.answered_at,
});

/** A whole number from 1 to `max`, as typed: digits, with commas between thousands; null for anything else. */
function wholeNumber(typed: string | number, max: number): number | null {
  const text = String(typed).trim();
  if (!/^\d{1,3}(?:,\d{3})*$|^\d+$/.test(text)) return null;
  const value = Number(text.replaceAll(",", ""));
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;
}

/** The newest answer, or none yet; `available: false` before migration 0095 runs. */
export async function readBaseline(orgDb: OrgDb): Promise<BaselineState> {
  const read = await orgDb.from("report_baselines").select(COLUMNS).order("answered_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (read.error) {
    if (missingTable(read.error, "report_baselines")) return { available: false };
    throw new Error(read.error.message);
  }
  const row = ((read.data ?? []) as BaselineRow[])[0];
  return { available: true, answer: row ? toBaseline(row) : null };
}

export async function answerBaseline(input: { actorId: string; minutesPerBill: string | number; peoplePerBill: string | number }): Promise<ReportBaseline> {
  const minutes = wholeNumber(input.minutesPerBill, MINUTES_MAX);
  if (minutes === null) throw new BaselineError("minutes");
  const people = wholeNumber(input.peoplePerBill, PEOPLE_MAX);
  if (people === null) throw new BaselineError("people");
  // An unreadable signing key refuses the answer before its row is written, rather than leave it unsigned.
  assertLedgerCanSign();

  const write = await db()
    .from("report_baselines")
    .insert({ minutes_per_bill: minutes, people_per_bill: people, answered_by: input.actorId })
    .select(COLUMNS)
    .single<BaselineRow>();
  if (write.error) {
    if (missingTable(write.error, "report_baselines")) throw new BaselineError("not_ready");
    throw new Error(write.error.message);
  }
  const answer = toBaseline(write.data);

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: BASELINE_ACTION,
    summary: `Answered how bills were handled before Vestiarion: ${minutes.toLocaleString("en-US")} ${minutes === 1 ? "minute" : "minutes"} a bill, ${people} ${people === 1 ? "person" : "people"}`,
    detail: { by: input.actorId, baselineId: answer.id, minutesPerBill: minutes, peoplePerBill: people },
  });
  return answer;
}
