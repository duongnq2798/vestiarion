# PR2 — The bill's journey

The approved scope and sequence are in `2026-10-19-visual-system-plan.md` and the accepted bill-journey design spec. PR1 merged as `487ea00e8`; this branch starts there in a fresh worktree. PR3 remains behind the PR2 merge gate.

## Implementation and evidence

- [FACT] Use the merged Heading/Section tokens, retaining agent blue and cream. The positioning is the sole h1; the large tagline remains a display paragraph.
- [RECOMMENDATION] Render a synchronous application shell, sharing one read promise between hero and journey. Stream only factual evidence; absent events remain unknown. Retain independent latest/recent decisions, signature verification and open numbers.
- [FACT] A read-only availability audit found a real eligible team Base payout. Ledger approval recording follows payment confirmation recording; labels must describe recording times, without invented elapsed duration or chronology.
- [RECOMMENDATION] Implement the narrow additive service-role selector, validate its result, then use scoped reads. Until the migration exists, only a missing-function error may fall back to the existing eligible-team selector and the same scoped validation. Never fall back to historical constants.
- [RECOMMENDATION] Verify privacy, eligibility, transaction state, streaming and real-data substitution with focused tests. Review rendered AA contrast/focus, no-JS, reduced motion and five responsive widths. Remeasure production LCP with three interleaved before/after pairs; keep preliminary runs separate.
- [RECOMMENDATION] Complete full verify/build and independent review before pushing and creating PR2. Do not merge or begin PR3 in this execution.

## Additive read migration rollback

- [FACT] Migration `0134_landing_team_journeys.sql` creates a read-only function; it does not rewrite rows or create payments. Public, anonymous, authenticated and tenant roles receive no execution grant. Only the existing service role can call it.
- [RECOMMENDATION] Apply the migration through the normal reviewed release process, never as a preview step. Review the function's scoped joins and eligible-team filters before release.
- [RECOMMENDATION] If the function causes a release problem, revert this landing change, then drop only `public.landing_team_journeys()` in a follow-up migration. The reader resolves missing/unavailable evidence honestly; the existing selector fallback stays within existing privileges. No data restoration is required.
- [FACT] No `/api/v1` or webhook contract changes are planned, so the integrator changelog is not part of this PR.
