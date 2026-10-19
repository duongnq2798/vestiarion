# Bill Journey Visual System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the selected bill-journey direction through a shared visual foundation, a truthful landing, and consistent remaining public pages in three reviewed and merged PRs.

**Architecture:** [RECOMMENDATION] Add opt-in CSS tokens and server primitives before migrating any production page. The landing then reads sanitized evidence through the DAL, sharing one bill model between its product view and journey while keeping its initial HTML synchronous. Migrate remaining public routes only after the landing merges.

**Tech Stack:** [FACT] Next.js 16.3.6 App Router, React 19.2.8, Tailwind CSS 4, TypeScript, existing cva/cn helpers, Supabase DAL and existing Vitest/PGlite tests. No dependency additions.

**Spec:** `docs/superpowers/specs/2026-10-19-bill-journey-design.md`. Read it together with `ARCHITECTURE.md`, local `AGENTS.md`, and the relevant installed Next.js guide in `node_modules/next/dist/docs/` before implementation.

## Global Constraints

- [FACT] The selected direction is C, The bill's journey, with four mandatory corrections: (1) positioning as the h1 while “Every bill. A clear way through.” stays large; (2) an app-like hero with sidebar/status/actions; (3) real ledger/payment evidence labeled “Vestiarion team workspace”; (4) accessible blue surfaces with inverse focus.
- [FACT] The sequence is PR1 -> review -> merge -> PR2 -> review -> merge -> PR3 -> review -> merge. Start every PR in a fresh worktree and `codex/` branch from freshly fetched `origin/main` after the preceding PR is actually merged. Never begin PR2 while PR1 is only open or locally complete.
- [FACT] PR1 is additive CSS/tokens/primitives only and makes no new live claim. PR2 owns the landing and internal real-data projection. PR3 changes remaining public pages' appearance while preserving behavior.
- [FACT] Keep `agent=#3048c9`, `ground=#f3f0e7`, and all existing palette roles unchanged. Add `on-agent-muted=#e9edff`, matching the existing agent-soft value. Keep radii md/lg/xl/2xl at 6/8/12/16px.
- [FACT] Keep existing default component styling and existing motion behavior stable. New public primitives are server components. No blanket heading resets or global page migrations.
- [FACT] The landing remains synchronous with independent Suspense evidence boundaries; its original live signature check stays. No hardcoded proof fallback, invented completed stage or mixed testnet/mainnet monetary figure.
- [FACT] Tenant reads use `withOrg` and `db()`; only whitelisted service-role RPCs select public cross-workspace proof. No credentials/private names/reasoning/ids reach the public view. No landing GET writes data or creates a receipt link.
- [RECOMMENDATION] Use existing meaningful tests, add only coverage for new contracts and failure cases, and run one bounded verification pass per PR after focused checks. Update the architecture for each shipped PR; add the integrator changelog only if `/api/v1` or webhooks change.

## Review Focus

1. [RECOMMENDATION] Defaults inherited by existing workspace screens must render identically when new tokens/Card variants land; Task 1 pins default class output and token values.
2. [RECOMMENDATION] Small secondary text and keyboard focus on saturated blue must stay readable after real rendering/opacity; Tasks 1 and 4 check contrast and every blue band.
3. [RECOMMENDATION] Missing private facts, clipped ledger reads, late ledger timestamps and repeated decisions must not create an invented chronology; Task 3 exercises these mappings.
4. [RECOMMENDATION] A confirmed Arc burn without a Base mint must not claim the Base payment settled; Task 3 pins both routes and explorer hosts.
5. [RECOMMENDATION] An unresolved/unavailable evidence read or absent JavaScript must not delay or hide positioning, CTAs or the generic journey explanation; Tasks 4 and 6 cover pending reads and static HTML.

## File responsibilities

| PR | File or family | Responsibility |
| --- | --- | --- |
| 1 | `src/app/globals.css`, `src/components/ui/tokens.ts` | Add semantic type/space/radius/duration/flat elevation and inverse-muted color tokens |
| 1 | `src/components/ui/Heading.tsx`, `Section.tsx`, `Card.tsx` | Server primitives and optional flat Card elevation |
| 1 | `tests/ui-tokens.test.ts`, `ui-public-primitives.test.tsx`, existing display/button/motion tests | Values, contrast, public primitive semantics and default stability |
| 1 | This spec/plan and `ARCHITECTURE.md` | Accepted direction and shipped foundation |
| 2 | Next unused `supabase/migrations/*_landing_team_journeys.sql`, `src/lib/dal/index.ts` | Narrow service-role read RPC and whitelist |
| 2 | `src/lib/platform/team-journeys.ts`, `src/lib/team-journey.ts` | Validation/cache/private identity removal and pure journey view projection |
| 2 | `src/app/page.tsx`, `src/components/landing/Hero.tsx`, new focused journey/evidence components and scoped styles | C composition, app view, streaming and honest evidence controls |
| 2 | Existing latest/recent/open-number readers, `SignatureCheck.tsx`, settlement/receipt readers | Preserve contracts and reuse supported semantics; modify only if needed |
| 2 | New migration/view tests; `tests/landing-stream.test.tsx`, hero/proof/signature tests | Privacy, real facts, failures, streaming and rendered claims |
| 3 | `src/components/vx/SiteChrome.tsx`, remaining public route families and their existing tests | Visual migration with stable behavior |

## PR1 — additive foundation

### Task 1: semantic tokens and server primitives

**Interfaces:** [RECOMMENDATION] `HeadingProps = ComponentProps<"h2"> & { as?: "h1"|"h2"|"h3"|"p"; size?: "positioning"|"display"|"section" }`; defaults h2/section. `SectionProps = ComponentProps<"section"> & { tone?: "ground"|"surface"|"agent"|"ink"; containerClassName?: string }`; default ground, inner `mx-auto max-w-7xl px-page py-section`. `Card` adds `elevation?: "surface"|"flat"`, default surface.

- [ ] [RECOMMENDATION] Add assertions to `tests/ui-tokens.test.ts` for exact semantic sizes, line heights, spacing/radius values, `on-agent-muted`, flat shadow, and parity of every existing `MOTION.duration` with CSS. Pin retained palette values; calculate normal text and inverse focus contrast rather than assuming that a named token passes.
- [ ] [RECOMMENDATION] Add static-render tests in `tests/ui-public-primitives.test.tsx` for independent Heading level/size, native/ARIA/data attributes, inherited color, class overrides, Section's bounded inner container, and `focus-inverse` on agent/ink only. Pin Card's previous default classes plus opt-in `shadow-flat`; existing button and interactive Card behavior must remain the same.
- [ ] [RECOMMENDATION] Run `npx vitest run tests/ui-tokens.test.ts tests/ui-public-primitives.test.tsx tests/ui-display.test.tsx tests/ui-button.test.tsx tests/ui-motion.test.tsx`; confirm the new assertions fail for the missing contract before implementation.
- [ ] [RECOMMENDATION] Add tokens and primitives with the interfaces above. Type sizes are eyebrow 11px, caption 12px, ui 14px, body 16px, lede clamp(16px,1.2vw,18px), positioning clamp(32px,4.2vw,60px)/1.08, section clamp(32px,4.6vw,64px)/1.05, display clamp(56px,7.8vw,112px)/0.96. Smaller line heights are specified in the spec. Add no new `use client` boundary.
- [ ] [RECOMMENDATION] Add page/section spacing clamps from the spec and explicit existing radii. Add CSS transition-duration micro/overlay/sheet/page/exit/reveal at 150/200/300/420/180/450ms, leaving the TypeScript durations unchanged. Add `COLOR.onAgentMuted="#e9edff"` and `--shadow-flat:0 1px 0 rgb(24 33 28 / 0.04)`.
- [ ] [RECOMMENDATION] Re-run the focused command; expected all pass. Review `Card` default/interactive class output and ensure no production route has migrated to new primitives in this PR.

### Task 2: verify, review and merge the foundation

- [ ] [RECOMMENDATION] Update `ARCHITECTURE.md` for the opt-in foundation and confirm this spec/plan match the final names and values. Record that PR1 reads no new live data and adds no claim.
- [ ] [RECOMMENDATION] Run `npm run verify` and `npm run build` once after focused checks pass; expected exit 0. Fix an attributable failure and repeat only affected checks before the necessary final validation.
- [ ] [RECOMMENDATION] Compare production `/`, `/open`, a representative workspace route and `/design` against the parent commit at the fixed review widths. Confirm existing appearance/focus/motion stay stable, shared server markup changes only when a new primitive is explicitly used, and no client dependency or client boundary was added. Record stylesheet and client JavaScript byte deltas.
- [ ] [RECOMMENDATION] Request fresh independent diff review, address actionable findings, create/attach PR1, and merge only after review and checks pass. Stop at the merge gate if approval or a check is pending. Do not start Task 3 before PR1 is merged into `origin/main`.

## PR2 — selected landing and real evidence

### Task 3: read and project team payment journeys

**Consumes:** [FACT] The merged PR1 tokens/primitives and existing `withOrg`, `db()`, `platformDb().rpc`, `ledgerPublicKeyPems`, settlement/receipt semantics and `verifySignedLink`.

**Produces:** [RECOMMENDATION] `landing_team_journeys()` returns only selected eligible proof projections plus server-only identity needed for scoped follow-up. `readTeamJourneys(): Promise<TeamJourneys | null>` validates/caches and strips identity. `TeamJourneys` has a nullable direct bill journey and nullable Base payment; its public records contain whitelisted facts with provenance, signed links/public keys and actual chain hashes, never raw tenant rows. `teamJourneyView(facts, publicKeys): TeamJourney | null` is a validated pure projection; generic process headings are separate from historical facts.

- [ ] [RECOMMENDATION] Fetch/verify PR1 merged on `origin/main`, create a fresh worktree and branch, and read the current architecture/Next guides. Perform a scoped read-only availability audit of the intended proof fields. Record missing fields without credentials or tenant content. Do not mutate data to make the narrative complete.
- [ ] [RECOMMENDATION] Add PGlite migration tests proving service-role-only access, deterministic eligible selection, correct org-scoped joins, exclusion of customers/samples/sandboxes/deleted creators, valid network/mode/status and a public-output whitelist. Assert private sentinel names/reasoning/PO/person/source/workspace ids do not reach the public view.
- [ ] [RECOMMENDATION] Add pure view tests for missing intake/check/hold/approval evidence, repeated decisions on one bill, ledger reads at the cap, invalid dates/hashes, post-payment approval recording, no elapsed claim without both supported events, and no “first payment” inference. Test confirmed/pending/failed/simulated payments and mismatched recording entries.
- [ ] [RECOMMENDATION] Add cross-chain tests: Arc burn/Base mint have distinct correct explorer hosts; confirmed burn without mint never yields Paid on Base; missing or wrong destination/network is omitted. Test actual amount/fee fields and omit unsupported contract/version/speed claims.
- [ ] [RECOMMENDATION] Run the new tests and confirm failures, then implement the next unused additive read migration, DAL RPC whitelist entry, validation/cache reader and pure projection. Copy the existing team-reader access rules; never expose an unrestricted tenant-table platform read. Reuse existing reducer/receipt rules rather than inventing a second payment lifecycle.
- [ ] [RECOMMENDATION] Fetch public keys within the selected workspace scope and return sanitized evidence. Use real intake/AP/approval/recording events; preserve unknown when absent or clipped. Cache successful reads about 60 seconds, discard failures, and resolve unreadable/empty proof honestly. Never import `FEATURED_PAYMENT` or prototype `BASE_PAYMENT` as a fallback.
- [ ] [RECOMMENDATION] Run focused new tests together with `tests/latest-decision-migration.test.ts`, `tests/recent-decisions-migration.test.ts`, `tests/settlement.test.ts` and `tests/receipts-facts.test.ts`. Expected pass; keep all reads free of write-side imports/calls.

### Task 4: compose C with a clear application hero

**Consumes:** [RECOMMENDATION] The shared `Promise<TeamJourneys|null>`, merged Heading/Section/Card, existing onboarding CTA URL and current open-number/latest-decision promises.

**Produces:** [RECOMMENDATION] Synchronous `LandingPage`, one positioning h1 and large display tagline, a readable product shell, one consistent bill through the page, real ledger/transaction evidence and preserved live latest-decision verification.

- [ ] [RECOMMENDATION] Update hero/render tests to require the positioning as the sole h1, large display tagline, sidebar/workspace/status/action context and the explicit Vestiarion team workspace label. Derive displayed bill status and next-action wording from the supplied view; unauthenticated marketing controls link to genuine existing destinations rather than impersonating payment actions.
- [ ] [RECOMMENDATION] Extend `tests/landing-stream.test.tsx`: leave every new and old promise pending and assert `LandingPage()` is not a Promise; h1/tagline/CTA/app shell/generic explanation and accessible loading states still appear. Add empty/unavailable responses with no historical fallback or fabricated numbers.
- [ ] [RECOMMENDATION] Test that each supplied date/time/amount/rule/hash changes the matching rendered fact, that missing facts do not produce completed ticks, and that hero/journey share the same bill. Require the correct explorer links and honest signed-link explanation; preserve original latest-decision check success/tamper/unavailable behavior.
- [ ] [RECOMMENDATION] Implement the selected composition with new focused components. Start the shared journey read in the synchronous page; place only evidence behind Suspense. Keep structural copy and the product frame in first HTML. Use positioning h1 and display paragraph, readable secondary text on blue, and `focus-inverse` for every blue band.
- [ ] [RECOMMENDATION] Apply one purposeful journey progression that ends within 2.5 seconds and preserves complete static content. Under reduce use the existing fade/color policy without travel/scale/scroll movement. Keep h1/lede/CTA still and avoid new Motion dependencies.
- [ ] [RECOMMENDATION] Run the new view/stream/hero tests, existing relevant landing/proof/signature/prefetch/motion/network tests and token tests. Expected pass; investigate only failures or changed contracts.

### Task 5: measure, review and merge the landing

- [ ] [RECOMMENDATION] Update `ARCHITECTURE.md` with the reader's eligibility/projection, limited verification claim, unavailable state and streaming boundary. This internal RPC does not by itself require the `/api/v1`/webhook changelog.
- [ ] [RECOMMENDATION] Run `npm run verify` and `npm run build` once; expected exit 0. Use the production build for the capture/measurement checklist below and retain artifacts outside source.
- [ ] [RECOMMENDATION] Request fresh independent review of privacy, money-state wording, chronology, static streaming and accessibility as well as appearance. Fix findings, create/attach PR2, and merge after review/checks pass. Do not begin Task 6 until PR2 is actually merged into `origin/main`.

## PR3 — remaining public pages

### Task 6: migrate public route families visually

**Consumes:** [FACT] Merged PR1 visual primitives and merged PR2 public composition; existing page content, actions, metadata and state contracts.

**Produces:** [RECOMMENDATION] Consistent public visual hierarchy and section spacing without changed routes, data access, actions or payment behavior.

- [ ] [RECOMMENDATION] Fetch/verify PR2 merged, create a fresh worktree and branch, then inventory current public routes and their existing tests. Record a concrete route list before edits: shared SiteChrome; informational/how-it-decides/open; docs; auth/onboarding; public token wrappers. Exclude workspace `/o/[slug]` routes and report any route outside this inventory before expanding the migration.
- [ ] [RECOMMENDATION] For each route family, identify its existing behavior checks and add only a missing meaningful regression: sole h1/heading hierarchy, action/link preservation, token invalid/revoked/expired states or static/pending content. Preserve semantic controls and native attributes; a visual primitive must not wrap away a form/action.
- [ ] [RECOMMENDATION] Apply Heading/Section/optional flat Card in small route-family changes. Keep metadata/canonical URLs, links, CTA targets, token access, form field names/actions, signature controls and all loading/error/empty state meanings. Use inverse-muted text only on appropriate dark surfaces and inverse focus on every blue region.
- [ ] [RECOMMENDATION] Run each changed family's focused tests once after editing it. Check JavaScript-disabled and reduced-motion pages with the original content fully readable; verify keyboard focus and long/error content at narrow widths.
- [ ] [RECOMMENDATION] Update `ARCHITECTURE.md`, run one full verify/build pass, and perform the bounded measurement/capture pass. Request fresh diff review, fix findings, create/attach PR3 and merge after review/checks pass.

## Bounded capture and measurement checklist

- [ ] [RECOMMENDATION] Record baseline/candidate commit, production build, browser version and exact network/CPU settings. Capture 1440/1024/768/520/375 x 900; at 520 include classic scrollbars and reduced motion. Inspect 320px overflow and zoom wrapping. Scroll each section into view before photographing it.
- [ ] [RECOMMENDATION] Check every blue text/link/button/focus pair as rendered: normal text >=4.5:1, large text >=3:1, focus/non-text indicator >=3:1. Do not count a named token as evidence if opacity or an overlay alters the pair.
- [ ] [RECOMMENDATION] On baseline/candidate use three cold loads and compare median LCP, CLS, transferred/decoded script bytes and stylesheet bytes. Also record total/section heights, horizontal overflow and running animations after rest. Do not claim a metric improvement from one run.
- [ ] [RECOMMENDATION] PR1: zero new client boundaries/imports or dependencies; report any script-byte delta. PR2/3: investigate LCP regression >10%, compressed scripts +30KB, CLS >0.1, any new horizontal overflow, or unreadable/hidden content before merge. Retest a failed or uncertain case, not the whole matrix indefinitely.
- [ ] [RECOMMENDATION] Preserve an explicit final record of pass/fail/unavailable, environmental limitations, unresolved findings and merge status. No production transaction, agent cycle, seed, receipt-share creation or database migration is a visual verification step.

## Evidence status

[FACT] This plan separates confirmed source contracts and accepted partner requirements from implementation recommendations. [ASSUMPTION] Production has both eligible proof records with enough event detail; the PR2 read-only audit owns verification after PR1 merges. No conversion, live-stage availability or performance improvement has been measured by this planning document.
