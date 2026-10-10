# Evidence chain: plan

Spec: `docs/superpowers/specs/2026-10-10-evidence-chain-design.md`. Branch `feat/evidence-chain`. No migration.

## Tasks

1. **Labels and the step rule** (`src/lib/evidence-chain.ts`): the seven kinds, their words, the weakest-first order,
   and `weakest(kinds)`. Test first (`tests/evidence-chain.test.ts`).
2. **The builder for a payable**, test first, fixture by fixture:
   - paid with full evidence (purchase order and goods stated, agent paid, Arc matches, receipt shared, signatures
     verify): every step and label;
   - paid with no purchase order (a person paid it after a hold): the commitment step is Missing, with what fills it;
   - a delivery a person stated: stays Stated by a person although its entry is signed (never upgraded);
   - an unreachable link: Arc did not answer, a revoked receipt: Could not open, never Verified outside;
   - an open bill: the payment and receipt steps are Missing ("Not paid yet"), the page is read-only.
3. **The builder for a milestone**, test first: GitHub evidence (Verified outside, the pull request linked), a person's
   verification by hand with a deliverable link (Stated by a person, "Not opened by Vestiarion"), GitHub unavailable
   (Could not open). No bill or receipt step.
4. **The reader** (`src/lib/evidence-read.ts`): DAL reads in scope, the checks (`verifyEntry`, `readOnChain`, the
   receipt), members' emails; not found for a receivable or an unknown id. Test with the fake Supabase client.
5. **The page** `src/app/o/[slug]/evidence/[kind]/[id]/page.tsx` and its components (`src/components/vx/EvidenceChain.tsx`,
   the browser check `src/components/EvidenceBrowserCheck.tsx`): render test with a built chain.
6. **The download** `src/app/api/evidence/route.ts`: session, membership, cross-site; JSON `vestiarion-evidence/1`.
   Route test.
7. **Entry points**: the card footer link (DecisionCard, payables and milestones) and the trail's last line.
8. **Docs**: `content/docs/guides/evidence.mdx` (nav, content map, docs-guides quotes), a screenshot from
   `/docs-shots` (`evidence-chain`), mentions in first-payment, pay-a-contractor and report, README, ARCHITECTURE.
9. `npm run verify`, `npm run build`, PR.
