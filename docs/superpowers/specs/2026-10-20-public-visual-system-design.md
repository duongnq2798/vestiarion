# Public pages in the Vestiarion visual system

## Scope

Continue the merged tokens/primitives, bill journey and hero work from `origin/main` at
`24b09ce5ed1b1f44bd69522a848826631b6b4db7`. This is a presentation change only, delivered in one PR.
The implementation order is counterparty token pages, sign-in/sign-up, `/open`, then docs header/footer.

Read `docs/design/visual-system.md` and the installed Next.js CSS and Server/Client Components guides before editing.
Keep agent-blue, cream ground, paper surfaces, Geist typography, the radius scale and existing primitives.
Use scoped CSS for compact public layouts; add no dependency, client boundary or animation.

## Presentation

- Token pages remain one readable column with a clear page heading, quiet paper evidence panels and deliberate
  spacing. The payee's progress remains first in the journey and retains its existing words and semantic order.
- Use a shared server-rendered public main/container for consistent gutters and widths. It owns only presentation,
  responsive wrapping and generous touch areas; it does not own data, state, actions or copy.
- Retain the app's existing form primitives, labels, descriptions, errors, pending states and disabled states.
  Enlarge public touch areas to at least 44px, including check labels, disclosures and inline proof links.
- Keep the form and record hierarchy at 375px and 520×900px, with readable metadata and long identifiers wrapping.
  Status always remains named in words. Use solid semantic text colours, flat evidence elevation and scale radii.
- Restyle sign-in around its current form. `/signup` still redirects to `/login` with the same validated `next`.
- `/open` uses the same public type, spacing and evidence surfaces. Its readers, period controls, number formatting,
  customer/team split, network split, error handling and every claim remain intact.
- Docs changes stop at its header and footer. Preserve the 64px header and sticky offsets. Do not restyle MDX,
  article content, sidebars, search behaviour, copy-page controls or pagination.

## Behaviour and content invariants

1. `/payee/[token]` passes only `payeeView(status)` into the client journey. Never pass the raw status, full address,
   private hold reasons or other fields dropped by that projection.
2. Preserve `moveOn`, action-answer advancement, `answered`/`over`, refresh fallback, the journey section ref and
   the effect that moves focus to the new step's `h1` while respecting focus the payee moved elsewhere.
3. Preserve all safety checkboxes, chain choices, hidden fields, passkey lazy loading, form validation, upload/date
   limits, refresh intervals, disclosures and conditional content. Add no action or data read.
4. All current text remains verbatim, including quoted guide labels in their existing source files, errors,
   privacy/safety copy, simulated-payment explanations and network formatter calls. Add no money disclaimer.
5. Preserve token metadata, noindex, invalid/expired/unavailable branches and their privacy boundaries.
6. No auth logic, redirect, Supabase email template, RPC, migration, API or webhook change. If a migration ever
   appears necessary, stop and ask; it would be 0135. None is planned.

## Accessibility and delivery

- One `h1` in each rendered state, no horizontal scroll at 1440/768/520/375px, controls at least 44px.
- Keep mobile input text at 16px and all label/error associations. Preserve keyboard order and visible focus.
- Check actual composed text contrast to AA and focus indicators to 3:1; use `focus-inverse` on dark regions and
  restore `focus-default` on nested light controls. Nothing animates at rest; reduced motion retains all content.
- Keep all controls in `src/components/ui`; no raw controls, hex colours, palette utilities or off-scale radii.
- Keep JavaScript within the current budget: no motion library or new client boundary; compare encoded/decoded/
  transferred JS and production LCP before/after with the same slow-4G profile. Do not infer causality from local runs.

## Verification and evidence

Use the same deterministic, explicitly labelled fabricated records for before/after token captures. Exercise actual
production routes/components with an external local-only allowlisted read fixture harness; never create real token
links, share receipts, send email, submit payments or modify production data. Unknown/mutation requests are blocked.
Keep the harness outside shipped source. Do not present these records as production evidence.

Capture each page at 1440, 768, 520×900 reduced motion and 375px. Cover payee address/invoice/confirmation/payment,
supplier status, open/received pay invoice, receipt checks/disclosure, statement/forms, login and signup redirect,
`/open`, and representative docs chrome. Capture invalid/expired/error states where applicable.
Record section heights and inspect screenshots after scrolling their sections into view. Compare rendered text and
links against baseline. Record bounded keyboard paths and payee heading focus after action answers; use existing
payee DOM/action tests as additional regression evidence, not a substitute for unexplored browser states.

Run focused copy/guardrail/UI tests, full `npm run verify`, and production build before pushing. Rerun any timeout
file alone with its original timeout; do not weaken checks. Add an Unreleased changelog entry and update architecture
for the shared presentation layer. Open one PR, attach it, and enable Auto-fix if the app exposes that control;
report a tooling limitation explicitly if it cannot be enabled. Keep commits neutral and local paths out of PR text.

Report in Vietnamese: changed files, before/after screenshot matrix, heights, LCP/JS, accessibility, verification,
build, preserved data claims and any uncertainty or untested state.
