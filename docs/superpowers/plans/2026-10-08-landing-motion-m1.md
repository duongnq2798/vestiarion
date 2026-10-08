# Plan: landing motion M0 + M1

Spec: `docs/superpowers/specs/2026-10-08-landing-motion-design.md`. Branch `feat/landing-motion`. Inline execution.

1. **Motion policy (M0).** Test `tests/motion-policy.test.ts` reads `src/app/globals.css`: the reduce block sets
   `transition-property` to the allowed list and does not set `transition-duration`; keyframe animations stay cut
   except `[data-calm-motion]`. Then change the rule. `Reveal` fades without lifting under reduce (`data-reveal="fade"`).
2. **Step state.** `stepState(index, active)` in `src/components/landing/pipeline/steps.ts`: `active` for the active
   step, `done` before it, `idle` after; with no active step (server HTML) every step is `lit`. Tested directly.
3. **The section.** `HowItWorks` keeps its words; the five steps move into a list the client component
   `DecisionPipeline` observes (IntersectionObserver, a band through the middle of the viewport) and marks with
   `data-state`. The diagram `PipelineDiagram` (SVG, `aria-hidden`) takes the same states. CSS in `landing-hero.css`:
   dimming, lit colours, the pulse on the active connector, the arriving entry; reduce variants. Test
   `tests/landing-pipeline.test.tsx`: every step's words, diagram hidden, no step dimmed in the server's HTML.
4. **Check frames** in a real browser at 375, 520 and 1280 px, motion on and reduce on.
5. **Docs**: ARCHITECTURE (motion policy), then PR with Auto-fix, merge on green.
