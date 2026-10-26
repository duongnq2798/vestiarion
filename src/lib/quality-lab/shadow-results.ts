import data from "@/lib/data/quality-lab-shadow.json";
import type { ShadowReplayResults } from "./shadow-replay";
import { answerWords, replayOutcomeWords, replayResultWords, verdictWords } from "./words";

/**
 * The replay of the team's shadow-mode decisions, as the last run committed it
 * (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SR9): tests/quality-lab-shadow.test.ts fails
 * while the file is not the run's, so what the pages show is what the code does. Imported, never read at request time.
 */
export const QUALITY_LAB_SHADOW_RESULTS = data as ShadowReplayResults;

/**
 * The columns of the docs page's table of decisions, on the page and in its Markdown alike (SR11). The answer is the
 * model's, as the line above the table says: a short head keeps the table inside the page's column.
 */
export const SHADOW_TABLE_HEAD = ["Decision", "Answer", "Verdict", "Then", "Now", "Result"] as const;

/** What the list under the table is called, on the page and in its Markdown alike (SR11). */
export const SHADOW_NOTES_HEAD = "Notes";

/** A reason the table gives once, under it: its number, the decisions it applies to in the table's order, and the reason. */
export type ShadowNote = { number: number; decisions: string[]; reason: string };

/** "Oct 8": a decision's day as the table names it. */
export function decisionDay(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Each distinct reason once, numbered in the order the table first meets it (SR11). A reason is long and several
 * decisions often share one, so the table's result names its note instead of repeating it in every row.
 */
export function shadowNotes(results: ShadowReplayResults = QUALITY_LAB_SHADOW_RESULTS): ShadowNote[] {
  const notes = new Map<string, ShadowNote>();
  for (const decision of results.decisions) {
    if (!decision.reason) continue;
    const note = notes.get(decision.reason) ?? { number: notes.size + 1, decisions: [], reason: decision.reason };
    note.decisions.push(decision.id);
    notes.set(decision.reason, note);
  }
  return [...notes.values()];
}

/** "shadow-01, shadow-04: It was decided on or before ...": a note as the list under the table says it. */
export function shadowNoteWords(note: ShadowNote): string {
  return `${note.decisions.join(", ")}: ${note.reason}`;
}

/**
 * One row per decision, in the order they were made: its id and day, the answer, the verdict, then, now, and the result,
 * which names the note that gives its reason (`shadowNotes`).
 */
export function shadowRows(results: ShadowReplayResults = QUALITY_LAB_SHADOW_RESULTS): string[][] {
  const notes = new Map(shadowNotes(results).map((note) => [note.reason, note.number]));
  return results.decisions.map((decision) => [
    `${decision.id}, ${decisionDay(decision.day)}`,
    answerWords(decision.answer),
    verdictWords(decision.verdict),
    replayOutcomeWords(decision.then),
    replayOutcomeWords(decision.now),
    replayResultWords(decision, decision.reason ? (notes.get(decision.reason) ?? null) : null),
  ]);
}
