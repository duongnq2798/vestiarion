# Public visual system implementation plan

> **For agentic workers:** Use the approved restyle scope in the linked spec. Root integrates each phase in order;
> independent capture and invariant audits run alongside it. Do not edit another owner's files.

**Goal:** Bring public pages into the merged visual system without changing behaviour or copy.

**Architecture:** Shared server-side public layout and scoped CSS; existing forms, actions and readers remain.
No new client boundary, dependency, migration or auth change.

**Tech Stack:** Next.js 16.3.6, React 19, Tailwind 4, CSS Modules, existing UI primitives, Vitest, headless Edge.

**Spec:** `docs/superpowers/specs/2026-10-20-public-visual-system-design.md`.

## Global constraints

Preserve all strings and their source locations, quoted guide labels, data formatting, network names, guardrails,
action-answer/focus behaviour and redirects. One h1, no overflow, 44px targets, labelled errors, AA text contrast,
inverse focus on dark. No resting animation, new JS dependency, raw control or database migration.

## Review focus

- Payee action answers advance immediately while newer reads supersede them and outside focus is respected.
- Masked address/hold privacy remains at both initial render and action response.
- Long names, amounts, hashes, four progress labels and button labels wrap at375/520 without hiding information.
- Error/expired/empty/payment-check states retain their labels, distinctions and original conditional content.
- Shared chrome changes preserve docs sticky offsets and do not change MDX/article or workspace controls.

## Tasks

- [x] Create detached worktree from latest main, branch, npm ci; read brief and installed Next guides.
- [x] Audit token invariants, quoted strings and route inventory. Baseline focused group:2816 tests; one scan timeout
  passed alone unchanged. Freeze baseline source for before/after evidence.
- [ ] Write and self-review this spec/plan. Prepare local-only fabricated read harness and capture baseline pages.
- [ ] Add shared public main/container and scoped presentation; apply to token pages in listed order. Keep all
  conditional logic, action calls, refs and strings. Adjust payee progress wrapping, touch areas and flat panels.
  Run payee DOM/action/privacy, token UI, quoted copy and consistency tests.
- [ ] Restyle `/login` around its form; leave signup redirect/actions/templates unchanged. Test auth and quoted copy.
- [ ] Restyle `/open` without changing its reads, claims or formatting. Run open-number/UI tests.
- [ ] Restyle docs header/footer through scoped shared chrome; retain64px header and MDX. Run docs shell/guides tests.
- [ ] Add Unreleased entry and architecture note. Review diff for behaviour/copy drift and unwanted scope.
- [ ] Build production candidate. Capture before/after1440/768/520reduced/375, section heights, contrast, keyboard,
  action-answer focus and no resting motion. Compare exact rendered copy, links, JS bytes and slow-4G LCP.
- [ ] Obtain independent review, resolve findings, run full verify and unchanged-timeout retries if needed.
- [ ] Commit neutral changes, verify source provenance, push once, open/attach one PR, enable Auto-fix if exposed.
- [ ] Report in Vietnamese with artifacts, exact checks, remaining uncertainty and remote CI status; do not merge.
