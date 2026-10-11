/**
 * How often people agreed with the agent in shadow mode (docs/superpowers/specs/2026-10-10-shared-report-design.md S7):
 * agreed out of agreed plus disagreed, to a whole percent, as /open counts it. The console's shadow mode panel, the
 * report and the shared report all say it with this one function. Null before any verdict. Browser-safe.
 */
export function agreementRate(counts: { agreed: number; disagreed: number }): number | null {
  const given = counts.agreed + counts.disagreed;
  return given > 0 ? Math.round((counts.agreed / given) * 100) : null;
}
