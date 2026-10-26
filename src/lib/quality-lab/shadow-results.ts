import data from "@/lib/data/quality-lab-shadow.json";
import type { ShadowReplayResults } from "./shadow-replay";
import { answerWords, replayClassWords, replayOutcomeWords, verdictWords } from "./words";

/**
 * The replay of the team's shadow-mode decisions, as the last run committed it
 * (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SR9): tests/quality-lab-shadow.test.ts fails
 * while the file is not the run's, so what the pages show is what the code does. Imported, never read at request time.
 */
export const QUALITY_LAB_SHADOW_RESULTS = data as ShadowReplayResults;

/** The columns of the docs page's table of decisions, on the page and in its Markdown alike (SR11). */
export const SHADOW_TABLE_HEAD = ["Decision", "The model's answer", "Verdict", "Then", "Now", "Result"] as const;

/** "Oct 8": a decision's day as the table names it. */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** One row per decision, in the order they were made: its id and day, the answer, the verdict, then, now, and the class. */
export function shadowRows(results: ShadowReplayResults = QUALITY_LAB_SHADOW_RESULTS): string[][] {
  return results.decisions.map((decision) => [
    `${decision.id}, ${dayLabel(decision.day)}`,
    answerWords(decision.answer),
    verdictWords(decision.verdict),
    replayOutcomeWords(decision.then),
    replayOutcomeWords(decision.now),
    replayClassWords(decision),
  ]);
}
