# The bill's journey: selected public visual direction

Date: 2026-10-19. Status: direction C selected, with the four corrections below. Delivery is three separately reviewed and merged PRs.

## Evidence and decisions

[FACT] The partner selected **C, The bill's journey**, after the isolated `/design/directions/a`, `/b` and `/c` studies. Those studies live in the separate `vestiarion-directions` worktree; they are references, not a production dependency or a branch to merge wholesale. The selected idea follows one bill from its arrival through the agent's checks, a decision, payment and the record.

[FACT] The partner's corrections, preserved as acceptance requirements:

1. **Positioning is prominent.** “Your AI agent for bills and payments” is the landing's h1. “Every bill. A clear way through.” remains large, in the display style, without adding a second h1.
2. **The hero shows the product.** Compose an application view with the sidebar, workspace context, real status and a clear next action, taking direction A's application clarity into C. Keep the journey's editorial composition; the paper ticket alone is insufficient as the hero's product explanation.
3. **Evidence is read.** The journey's bill, dates, times, amounts, decisions, holds, approvals, transactions and recorded stages come from real ledger/payment reads. Give the evidence a way to be checked and label it **Vestiarion team workspace**. Do not present it as a customer result, invent a completed stage, or fall back to hardcoded historical facts.
4. **Blue is accessible.** Text on every blue surface passes WCAG AA; every blue region has inverse keyboard focus. Keep the existing agent blue `#3048c9` and warm ground `#f3f0e7`, together with the existing proof, held and refused roles. Add `on-agent-muted` using the existing `agent-soft` value `#e9edff` for secondary text on agent blue.

[RECOMMENDATION] The controlling sentence remains “The AI suggests. Your rules in code decide.” The journey can explain the general process in fixed copy, while its claims about the featured bill are always derived from that bill's recorded facts.

## Delivery gates

[FACT] The authorized sequence is **PR1 visual system -> review -> merge -> PR2 landing -> review -> merge -> PR3 remaining public pages -> review -> merge**. Each PR starts in a fresh isolated worktree and `codex/` branch from freshly fetched `origin/main`, after the preceding PR is actually merged. An open PR, a local commit, or a review approval is not the next gate's merge.

[FACT] PR1 contains additive foundation work only. It makes no new live-data claim and does not implement the landing journey, data RPC, API behavior, or public-page restyling. PR2 consumes the merged foundation. PR3 consumes the merged landing and changes the remaining public pages' appearance while preserving their behavior.

## PR1: the shared visual system

[FACT] Existing CSS and TypeScript tokens are in `src/app/globals.css` and `src/components/ui/tokens.ts`; `tests/ui-tokens.test.ts` holds their shared values together. Existing `Card` uses `rounded-2xl`, a border and `shadow-surface`; its default must remain identical.

[RECOMMENDATION] Add semantic type tokens without resetting existing headings or replacing existing utility defaults:

| Token / utility | Size | Line height |
| --- | --- | --- |
| `text-eyebrow` | 11px | 1.5 |
| `text-caption` | 12px | 1.5 |
| `text-ui` | 14px | 1.5 |
| `text-body` | 16px | 1.5 |
| `text-lede` | `clamp(1rem, 1.2vw, 1.125rem)` | 1.65 |
| `text-positioning` | `clamp(2rem, 4.2vw, 3.75rem)` | 1.08 |
| `text-section` | `clamp(2rem, 4.6vw, 4rem)` | 1.05 |
| `text-display` | `clamp(3.5rem, 7.8vw, 7rem)` | 0.96 |

[RECOMMENDATION] Add `--spacing-page: clamp(1.25rem, 5vw, 4.5rem)` and `--spacing-section: clamp(3rem, 6vw, 6rem)` for `px-page` and `py-section`. Explicitly name the existing radii: `md` 6px, `lg` 8px, `xl` 12px and `2xl` 16px. Preserve their current values and every existing palette role. The only additional color is `--color-on-agent-muted: #e9edff`, mirrored in `COLOR.onAgentMuted`.

[RECOMMENDATION] Expose existing `MOTION.duration` values as Tailwind `--transition-duration-*` tokens: micro 150ms, overlay 200ms, sheet 300ms, page 420ms, exit 180ms and reveal 450ms. Keep the existing easing, 60ms stagger and reduced-motion policy. Add `--shadow-flat: 0 1px 0 rgb(24 33 28 / 0.04)` and optional `Card elevation="surface" | "flat"`, defaulting to `surface`; preserve tones, radius, padding, interactive hover and existing default rendering.

[RECOMMENDATION] New server primitives:

- `Heading`: native h2 attributes, `as?: "h1" | "h2" | "h3" | "p"` (default `h2`), `size?: "positioning" | "display" | "section"` (default `section`) and `className`. Heading level and visual size are independent. Inherit the surrounding text color; allow normal class overrides.
- `Section`: native section attributes, `tone?: "ground" | "surface" | "agent" | "ink"` (default `ground`), `className` and `containerClassName`. Its inner container is `mx-auto max-w-7xl px-page py-section`. Agent and ink tones use `text-on-agent focus-inverse`; ground and surface use `text-ink`. It adds no observer, animation, client boundary or data read.

[FACT] Opaque white on the retained agent blue has approximately 7.25:1 contrast; `#e9edff` has approximately 6.22:1. These calculated pairs exceed the 4.5:1 requirement for small text. Opacity, overlays and a different immediate background change the result and must be measured as rendered.

## PR2: one bill, real evidence

[FACT] The current landing is synchronous (`src/app/page.tsx`). It starts mainnet/testnet open-number reads and the latest-decision read, then streams proof through independent Suspense boundaries. `SignatureCheck` checks a signed body hash and its previous-link hash in the reader's browser.

[FACT] Existing public readers are intentionally insufficient for a complete journey:

| Reader | Safe output it already provides | Missing journey evidence |
| --- | --- | --- |
| `latest_team_decision()` (`0087`, `0088`) | Decision sequence/time/action/network/amount, code rule/hold/status, schedule day, verdict, confirmed Arc hash, signed link | Intake and approval times, earlier stages, destination mint |
| `recent_team_decisions()` (`0100`) | Sanitized latest decision per bill, failed-payment marker, weekly counts | Bill history, signatures and source identity |
| `open_numbers()` (`0075`) | Aggregates and eligible team payments' `at`, `amount`, `token`, `txHash`, `chain` | Linked entries, destination-chain mint and stages |
| `featured-proof.ts` and prototype C's `proof.ts` | Historical facts transcribed into source | A database read; these are not the new reader's fallback |

[RECOMMENDATION] Add one narrow, read-only platform RPC, `landing_team_journeys()`, in the next unused migration, and a validated server reader `src/lib/platform/team-journeys.ts`. Select one eligible confirmed direct mainnet bill and one eligible confirmed Arc-to-Base bill deterministically, newest confirmation then a stable tie-break. A missing result is null. Keep selection and projection in this reader/RPC, not in components. It may return the organization/source identity to the server for a scoped follow-up and public key lookup; remove that identity before returning the public view.

[RECOMMENDATION] Preserve the eligibility and access contract of `0087/0088/0100`: founding workspace or a platform team member's workspace, live workspace, real payable, non-sample payee, confirmed live payment on the stated network. Never include customer, sandbox or creator-deleted non-founding workspaces. Make the function stable, security definer with empty search path, revoke execution from public/anon/authenticated/tenant, and grant only service_role. Add only its name to `PLATFORM_RPCS`; tenant tables remain inaccessible through `platformDb().from`. Any follow-up uses `withOrg` and `db()`.

[RECOMMENDATION] Whitelist public output: network, amount/token actually paid, safe status/action/rule markers, recorded times and their provenance, sequence and signed-link fields, public keys, valid transaction hashes, destination chain and supported fee data. Derive `hasPurchaseOrder` from the observed PO value without releasing that value. Allow recorded `goodsReceived`, screening outcome and match requirements as explicit safe fields. Omit raw ledger summaries/details, model reasoning, human reasons, names, addresses unless needed for already-public transaction evidence, invoice/payee/person ids and workspace ids. The UI labels the source “Vestiarion team workspace”; it does not publish the workspace's name.

[RECOMMENDATION] Read `create_invoice` for intake, the bill's AP decisions and their observed checks for the suggestion/hold, `approval_given` / `approval_paid` and recorded approval facts for the person's action, and the intent plus its transaction-recording entry for payment/recording. Use `settlement-facts.ts`, `settlement.ts` and `receipts/facts.ts` for existing payment semantics; add only the journey-specific intake/check/hold projection. A clipped ledger read makes a missing stage unknown. Never infer all five stages from a confirmed hash or reuse another bill's latest decision to fill a gap.

[FACT] Historical `featured-proof.ts` records approval at 09:43:17 UTC while its explorer confirmation is 09:43:13 UTC: the ledger is written after the send. `executed_at` can be rewritten by reconciliation. A ledger timestamp is the recording time, not necessarily the action or block time.

[RECOMMENDATION] Label each time by its source: “bill recorded”, “decision recorded”, “approval recorded”, “Circle confirmation recorded”, or a chain's block time if actually read. Use `approved_at` / `detail.approvals[].at` only when available. Compute elapsed time from supported events, and omit it when the events are absent, incompatible or inverted. Do not hardcode the prototype's date, 19 seconds, confirmation speed, fee, contract version or “first payment” claim.

[RECOMMENDATION] For Arc-to-Base require live mainnet confirmation, `destination_chain="BASE"`, an Arc burn `tx_hash` and a Base `mint_tx_hash`. The burn goes to Arc Explorer; the mint uses `chainById("BASE").explorerTx`. A burn alone is never “Paid on Base.” Existing latest-decision `paidTxHash` is the Arc hash and cannot provide the Base proof. Preserve mainnet versus testnet labels and keep their monetary figures separate.

[FACT] Receipt tokens are stored as one-way hashes. `shareReceipt()` creates/rotates a token and writes ledger/database state; a landing GET cannot use it to manufacture a link. An existing `receipt_shared` entry is required before claiming a shared receipt is on file.

[RECOMMENDATION] Expose explorer links and ledger entry evidence anchors with browser signature controls. Preserve the existing live latest-decision signature check independently. Its claim remains narrow: the key signed this private body hash, and the chain link matches; it does not prove the extracted public wording, timestamp, a full continuous ledger, or settlement on chain. Keep verified, failed and unavailable outcomes distinct.

[RECOMMENDATION] Keep `LandingPage` and the hero's structural shell synchronous. Start reads without awaiting and pass the same journey promise to the hero's evidence area and the detailed journey, each behind bounded Suspense fallback. Prominent positioning, large tagline, the app shell, CTAs and generic process explanation are first HTML. Evidence loads independently. On an unreadable/missing migration or empty result show an honest unavailable/empty state; never import hardcoded proof as a fallback. Cache successful reads for about 60 seconds and discard failed cached promises.

[ASSUMPTION] Production contains eligible records with sufficient evidence for both modules. This source audit did not read production. To verify: the PR2 implementer performs a scoped, read-only check after PR1 merges, records field availability without secrets, and accepts an honest missing-data state if the condition is false. Do not seed, pay, run the agent, create a share or migrate production merely to fill the design.

## PR3: remaining public pages

[RECOMMENDATION] Inventory remaining public routes from the freshly merged tree: shared SiteChrome, informational pages, `/how-it-decides`, `/open`, docs shells, authentication/onboarding and public token page wrappers. Apply the merged type, section, spacing and card language in small route-family groups. Preserve existing content meaning, URLs, metadata, forms/actions, authorization, token validity, loading/error/empty states, signature checks and payment behavior. Workspace `/o/[slug]` screens are outside this public-page restyling. Do not make a global selector do a route migration accidentally.

## Verification and measurements

[RECOMMENDATION] Each PR receives a fresh diff review, fixes actionable findings, runs bounded focused checks plus one full `npm run verify` and `npm run build` before merge, and records actual results. Retry an isolated environmental timeout once before classifying it; broaden only for a new change, failure or unresolved concern. Update `ARCHITECTURE.md` with the shipped scope. The `/api/v1`/webhook changelog rule applies only if those interfaces actually change.

[RECOMMENDATION] Review production-build captures at 1440, 1024, 768, 520 and 375 CSS pixels, 900px high; test the 520px partner pane with classic scrollbars and reduced motion. Also inspect 320px minimum-width overflow, keyboard focus on every colored band, zoom/wrapping, JavaScript disabled, pending/unavailable data and reduced motion. Scroll sections into view before captures. No essential content depends on animation; the h1, lede and CTAs stay still; purposeful movement plays once and ends within 2.5 seconds, with the existing calm reduced state.

[RECOMMENDATION] Record baseline and candidate source commit, same-browser cold-load LCP (three runs and median), CLS, transferred/decoded JavaScript bytes, stylesheet bytes, total page/section heights and horizontal overflow. Hold viewport, network and CPU throttling constant and record their exact settings. PR1 adds zero client boundaries or client imports; report any client-JavaScript delta and preserve production route rendering. PR2/PR3 investigate a median LCP regression above 10%, a compressed script increase above 30KB, any new horizontal overflow or CLS above 0.1 before merge. These are review budgets, not measurements already achieved.

[FACT] There are no analytics or verified conversion results for the selected production direction yet. This design claims clearer product positioning, accessible surfaces and traceable evidence as acceptance requirements, not a measured increase in conversion.

## PR2 implementation evidence

[FACT] The read-only audit found a confirmed 1 USDC Arc-to-Base payment in an eligible team workspace, with all five recorded events, but no direct payment in that one selected scope. Approval recording follows payment confirmation recording. The public view labels recording times and never infers elapsed duration.

[FACT] Before migration `0134_landing_team_journeys.sql` is released, only a missing-function error uses the already-whitelisted latest-team selector plus the same scoped real-data validation. This narrower selection can leave a route unknown; it never imports historical fixtures. All other read failures resolve unavailable. No production migration or payment was performed for the preview.

[FACT] The existing historical safety case remains separate from the live bill journey and links to its committed source. It was not found in the founding scope during this audit, so no new live-verification claim is made for it.

## Hero refinement — 2026-10-20

[FACT] The partner requested three substantive steps in the existing HTML application frame: the agent's recorded schedule and condensed reason, the code's hold in ordinary words, and a human approval followed by the confirmed destination and recording time. Each step links to its own ledger entry; the Arc mainnet burn and Base mint links remain separate.

[FACT] The audited Base bill's `ap_schedule` entry #4641 precedes its exact payment record #4643. Its recorded payment day is 2026-10-22 and its timing reason says there is no early-payment discount and the cash stays available until due. The hero's short sentence is a supported paraphrase, not a verbatim quotation. The confirmed intent fee is 0.055026 USDC; 0.055 is its rounded display, not the agent's earlier fee quote.

[FACT] The server reads only the selected signed schedule entry within its existing team scope, matching sequence/action/actor/body hash. Only a validated day and constrained reason marker reach the page; arbitrary reasoning and names stay private. A different day changes the text; missing or unsupported evidence stays unknown. SQL migration 0134 is unchanged by this refinement.

[FACT] With migration 0134 active, both direct and Base slots can contain real payments. Hero and the detailed journey use one shared selector over those two candidates. A full story needs a supported decision (including a schedule day when applicable), a hold with known words, approval, a payment entry and a recorded confirmation. Intake and the optional schedule reason may be missing. Complete Base wins a tie, then complete direct; only when neither is complete does direct take precedence over Base. All hero entry links stay on that selected bill. The dark “Another team payment” panel shows the remaining bill, with its own route, time, fee and proof links; it never repeats the selected payment. This selection does not search all historical bills within each route.

[FACT] Hero navigation labels are read from the app's shared navigation data. Hero captions and labels use at least 12px, and step prose stacks in a 520px pane. Card links have 5rem scroll margin to keep reverse keyboard focus below the sticky public header. No screenshot of the app is used.

[FACT] The desktop hero columns align at the top: growth when real evidence streams in must not vertically recenter the positioning copy and product frame. Separate desktop stream measurements remain distinct from the primary 520px LCP samples.
