import data from "@/lib/data/quality-lab.json";
import type { QualityLabResults } from "./judge";
import { QUALITY_LAB_GROUPS, type QualityLabGroup } from "./scenarios";

/**
 * The Quality Lab's committed results (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL5), as the last run
 * wrote them: tests/quality-lab.test.ts fails while they are not the run's, so what the pages show is what the code does.
 * Imported, never read at request time.
 */
export const QUALITY_LAB_RESULTS = data as QualityLabResults;

/** Each group, in order, with how many of its scenarios were right. */
export function groupCounts(results: QualityLabResults = QUALITY_LAB_RESULTS): Array<{ group: QualityLabGroup; right: number; total: number }> {
  return QUALITY_LAB_GROUPS.map((group) => {
    const mine = results.scenarios.filter((scenario) => scenario.group === group.id);
    return { group, right: mine.filter((scenario) => scenario.right).length, total: mine.length };
  });
}
