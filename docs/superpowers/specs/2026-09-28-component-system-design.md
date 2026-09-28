# Component system — design

**Status:** decided 2026-09-28 under the standing autonomy grant (decide, record the cost if wrong, report
afterwards). Every decision below carries the alternative it beat.
**Scope:** one design system for every screen: tokens, accessible primitives, motion, feedback, and the
migration of all existing pages and components onto it.
**Follows:** Plans 1–3b (identity, tenancy, members), which added eight workspace pages and five forms, each
styled by hand.

## 1. Goal

> Every screen is built from one set of components that look, move and behave the same way — keyboard,
> screen reader, touch and mouse alike — so the product reads as one finished piece of work, and a new
> screen cannot drift from the rest without a test failing.

**Success criteria**

1. Outside `src/components/ui/`, no file renders a raw `<button>`, `<select>`, `<textarea>` or a non-hidden
   `<input>`. Enforced by a test.
2. No colour literal (hex, `rgb()`, `hsl()`, `oklch()`, Tailwind's default palette, `white`/`black`) appears in a
   `.tsx` file; colours come from the brand tokens. Enforced by a test.
3. Every overlay — menu, dialog, sheet, select, command palette — traps and returns focus, closes on Escape
   and on an outside click, and is fully keyboard-operable. The one exception is deliberate: a confirmation
   dialog ignores outside clicks and asks for an explicit choice.
4. Removing a member, leaving a workspace and revoking an invitation each ask for confirmation first.
5. Every animation is disabled or reduced under `prefers-reduced-motion`.
6. `npm run verify` and `npm run build` are green; `/`, `/login`, `/design` and the workspace pages load with no
   console errors and no hydration warnings.
7. Every workspace section has an icon — a typed map, so a section without one does not compile.

## 2. What exists today

Measured on `main` at `1894825`:

| Concern | Today |
|---|---|
| Buttons | 24 raw `<button>` elements in at least five shapes: `rounded-xl h-11` (auth forms), `rounded-xl h-10` (invite, intake), `rounded-md h-10` without the brand shadow (CSV confirm), `rounded-md h-9 border-ink-3` (verify ledger), `rounded-md px-2.5 py-1 text-xs` (remove, revoke). Two hover models: lift (`-translate-y-0.5`) and tint (`bg-agent/90`). |
| Fields | 39 raw `<input>`/`<select>`/`<textarea>` tags (hidden inputs included); the visible ones come in four shapes: `rounded-xl bg-ground` (auth), `rounded-xl bg-surface shadow-sm` (intake), `rounded-lg bg-ground h-10` (invite), `rounded-md h-9` (milestone). The role select is `h-8`. Labels are wired by hand; nothing sets `aria-describedby` or `aria-invalid`. |
| Overlays | Three hand-rolled: the workspace switcher (a `hidden` div with its own outside-click and Escape handling), the landing menu (the same again), and the navigation drawer (a native `<dialog>` with 60 lines of bespoke CSS). None animates out. |
| Destructive actions | Remove member, leave workspace and revoke invitation run on a single click. |
| Feedback | Inline `aria-live` text only, worded and coloured differently per form; "Copied" swaps a button label. |
| Shape | Eleven radius utilities (`rounded` … `rounded-3xl`, `rounded-[1.75rem]`); custom `surface-shadow`/`brand-shadow` utilities beside an arbitrary `shadow-[…rgb()]`. |
| Colour | Brand tokens in `globals.css`, plus `text-white/75`, `border-white/35`, `bg-white/10` on the landing page and hex fallbacks in `Brand.tsx`. |
| Icons | Fourteen hand-drawn glyphs. `NavGlyph` has no branch for `members`, so that navigation item renders an empty square. |
| Loading, empty | `animate-pulse` blocks; three unrelated empty-state styles. |
| Motion | One keyframe (`arrive`) reused for everything; nothing animates on exit. |

What is worth keeping: the editorial palette (ledger paper, blue-black ink, cobalt agent, jade proof, saffron
held, vermilion refused), the three typefaces (Geist, Geist Mono, Newsreader), the `hatch` texture for simulated
things, the bespoke domain and outcome glyphs, and the proof-first copy.

## 3. Decisions

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Headless primitives | **Radix UI**, through the unified `radix-ui` package (1.6) | **Base UI** 1.8: strong and active, but nothing it adds is needed by this component set, and `cmdk` is built on Radix Dialog — one primitive family instead of two. **React Aria Components**: the best accessibility and i18n, at the price of verbose render-prop styling and a heavier bundle. **Styled kits** (MUI, Mantine, Chakra, HeroUI): each brings its own visual identity and fights Tailwind tokens; the editorial look would be lost. |
| D2 | Ownership | Components live in `src/components/ui/`, written for our tokens in the shadcn manner | **shadcn CLI**: generates its own neutral oklch tokens and kebab-case files; hand-authoring keeps the palette and this codebase's conventions. |
| D3 | Variants and class merging | `class-variance-authority` for variants; `cn()` = `clsx` + `tailwind-merge`, extended with our custom tokens | String concatenation (today): a consumer's `className` cannot reliably override a base class. Plain `tailwind-merge` would treat `text-reasoning` (a font size) as a colour and drop it next to `text-ink`. |
| D4 | Motion | Three layers sharing one set of tokens: CSS keyframes (`tw-animate-css`) keyed off Radix `data-state` for overlays; **Motion** (`motion/react`, `LazyMotion` with `domMax` loaded asynchronously) for shared-layout indicators, exit animations of list items and in-view reveals; a CSS enter animation on page content | **React `<ViewTransition>`** (available through Next 16's React canary): deferred — it snapshots the whole root, captures pointer events while it runs, and its behaviour differs by browser; the page-level effect we want is a mount animation that CSS gives without those costs. **Motion for everything**: overlays would need `forceMount` plumbing for exits Radix already handles with CSS. |
| D5 | Feedback | **Sonner** toasts confirm actions that stay on the page. Errors, and anything a person must read to continue, stay inline in an `aria-live` `FormMessage`. | Toasts for errors: they disappear, and a screen reader user may miss them. Inline-only (today): success is easy to miss and every form words it differently. |
| D6 | Icons | **lucide-react** for every generic UI and section icon, stroke 1.75. The bespoke `DomainGlyph`, `OutcomeGlyph` and `BrandMark` stay — they carry meaning no icon set has (a hatched circle is *simulated*, an octagon is *refused*). | Keeping all hand-drawn glyphs: every new control needs a new drawing, which is how `members` ended up with none. |
| D7 | Command palette | **cmdk** in a Dialog, opened with ⌘K / Ctrl+K and from a visible search button: jump to a section, switch workspace (landing on the same section), create a workspace, sign out | None: eight sections and a workspace switcher are exactly where a palette pays for itself, and it exercises the Dialog and list primitives. Actions with side effects (run a cycle) are left out — a palette is for going somewhere. |
| D8 | Destructive actions | `ConfirmDialog` (Radix AlertDialog) whose confirm button submits the original form through the `form` attribute | Undo toasts: removing a member is a server-side ledger entry; there is nothing to undo client-side. |
| D9 | Form controls | Radix **Select** and **Checkbox** (both submit through `FormData` when given a `name`); the native date input, styled; forms reset by remounting on a `key` | Native `<select>`: renders differently on every OS and cannot be styled to match. `form.reset()` (today): does not reach Radix's internal state. |
| D10 | Disclosure | Native `<details>` with a CSS height animation where `interpolate-size` is supported, for server-rendered lists (audit rows, table disclosures); Radix **Tabs** for the invoice intake | Radix Collapsible for audit rows: a hundred client components on a server-rendered page, and find-in-page no longer opens a closed row. |
| D11 | Enforcement | Structural tests (success criteria 1 and 2) and server-render contract tests of the primitives, in the existing Node Vitest environment | ESLint `no-restricted-syntax` on JSX: works for elements, but the colour rule needs string scanning anyway, and the codebase already pins structure with tests (`access-gates.test.ts`). jsdom + Testing Library: a second test environment for what `renderToStaticMarkup` already shows. |
| D12 | Living reference | A `/design` page rendering every primitive in every state and the domain components with fixture data; `notFound()` in production | Storybook: a second build, a second dependency tree and slower CI for what one route does. |
| D13 | Dark mode | Not now. Tokens stay semantic and the colour ban (criterion 2) keeps a dark theme a token-only change later. | Shipping both themes now doubles the visual verification of every screen, and nothing asks for it yet. |
| D14 | Scale | Tailwind's built-in radius scale with usage rules (§4.3); new shadow, easing and animation tokens in `@theme` | Custom radius tokens: the built-in scale already names every step we use, and `tailwind-merge` understands it without configuration. |

## 4. Architecture

### 4.1 Layers

```
globals.css @theme ─ tokens: colour, shadow, easing, animation
        │
src/components/ui/  ─ generic primitives; know nothing about treasuries or ledgers
        │
src/components/vx/  ─ Vestiarion's domain components (DecisionCard, AuditLedger, Money, …), built only from ui/
        │
src/components/*, src/app/**  ─ feature components and pages, built from ui/ and vx/
```

A primitive never imports from `vx/`, `lib/` or `app/`. Imports are direct (`@/components/ui/Button`); there is
no barrel file, so a server page never pulls a client module it does not render.

### 4.2 Server and client

A primitive is a Server Component unless it needs state, effects, context or a Radix overlay.

| Server-safe | Client (`"use client"`) |
|---|---|
| `Button` (its `asChild` uses Radix `Slot`, which is itself a client module and receives the child as a prop), `Badge`, `Chip`, `Card`, `Callout`, `Eyebrow`, `SectionHeader`, `EmptyState`, `Skeleton`, `Spinner`, `ProgressBar`, `Kbd`, `Separator`, `Avatar`, `Table`, `Disclosure` | `SubmitButton`, `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `FileInput`, `FormMessage`, `Tooltip`, `Dialog`, `ConfirmDialog`, `Sheet`, `DropdownMenu`, `Tabs`, `Command`, `Toaster`, `CopyButton`, `Reveal`, `MotionProvider` |

Field controls are client components because `Field` hands its ids to them through context; every form that
uses them is already a client component (`useActionState`).

`src/app/providers.tsx` (client) wraps the app in `MotionProvider` and `TooltipProvider`; the root layout renders
it around `children` and adds one `<Toaster />`. Server children pass through unchanged.

### 4.3 Tokens

**Colour** — the existing palette, unchanged. Overlays dim the page with `bg-ink/40`.

**Radius** — Tailwind's scale, by role:

| Utility | Used for |
|---|---|
| `rounded-md` (6px) | tags, evidence chips, `Kbd`, inline code |
| `rounded-lg` (8px) | menu and list items, `sm` controls, table-row actions |
| `rounded-xl` (12px) | `md`/`lg` buttons and fields, select triggers, tab lists, callouts, menu and popover surfaces |
| `rounded-2xl` (16px) | cards, dialogs, form panels |
| `rounded-full` | status pills, avatars, progress tracks |

Nothing else (`rounded`, `rounded-sm`, `rounded-3xl`, arbitrary radii) remains after migration.

**Shadow** — defined in `@theme`, so `shadow-surface` etc. are ordinary utilities:
`--shadow-control` (fields), `--shadow-surface` (today's `surface-shadow`), `--shadow-raised` (hovered
interactive cards), `--shadow-overlay` (menus, dialogs, sheets, toasts), `--shadow-brand` (today's
`brand-shadow`), and `--drop-shadow-logo` (today's `logo-shadow`). The three old custom utilities are removed.

**Motion** — easings `--ease-standard: cubic-bezier(0.2, 0.7, 0.2, 1)` (today's `arrive` curve),
`--ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1)`, `--ease-exit: cubic-bezier(0.4, 0, 1, 1)`; animations
`arrive`, `sweep`, `drift` (kept) and `shimmer` (new). Durations by role:

| Role | Duration | Easing |
|---|---|---|
| Hover, press, colour | 150ms | standard |
| Overlay enter / exit | 200ms / 150ms | emphasized / exit |
| Sheet enter / exit | 300ms / 200ms | emphasized / exit |
| Shared-layout indicator | spring, stiffness 500, damping 40 | — |
| Page content enter | 420ms | standard |
| List item exit | 180ms | exit |
| In-view reveal (landing) | 450ms, 60ms stagger | emphasized |

`src/components/ui/tokens.ts` mirrors the values TypeScript needs (`MOTION`, and `THEME_COLOR` for the viewport
metadata); a test asserts each equals its CSS token, so the two cannot drift.

**Focus** — the global `:focus-visible` outline (2px agent, 3px offset) stays for links and buttons. Fields show
focus as `border-agent` plus a `ring-agent-soft` halo instead, and set `outline-none` so the two never stack.

**Touch** — every `md` control is 44px tall below `sm` and 40px from `sm` up; fields use 16px text below `sm`
(iOS zooms into anything smaller).

### 4.4 Motion in practice

- **Overlays** animate with `tw-animate-css` utilities on Radix `data-[state=open|closed]` — fade + 96% zoom for
  menus, selects, tooltips and dialogs; slide from the edge for sheets. Radix keeps the element mounted until
  the exit animation ends.
- **Shared layout** — the active item of the section navigation and of `Tabs` is a Motion `layoutId` pill that
  glides to the newly selected item. Each navigation instance (sidebar, sheet) has its own `LayoutGroup`.
- **Presence** — an invitation that is revoked, and a member row that is removed, fade out (`AnimatePresence`)
  instead of vanishing.
- **Page content** — `ProductShell` gives its content `motion-safe:animate-arrive`: each section fades in and
  rises 6px as it mounts. A refresh (`router.refresh()`) does not remount, so it does not replay.
- **Reveal** — landing sections fade and rise into view once (`whileInView`, `once: true`).
- **Disclosure** — `<details>` height animates where `interpolate-size` is supported and snaps elsewhere.
- **Skeleton** — a slow shimmer; static under reduced motion.
- **Reduced motion** — the existing global rule shortens every CSS animation and transition to 0.01ms;
  `MotionConfig reducedMotion="user"` turns Motion's transforms off.

`LazyMotion` runs in `strict` mode, so only the lightweight `m.*` components can be used.

### 4.5 Forms

- `Field` takes an `id`, a `label`, an optional `description` and an optional `error`, and provides
  `{ id, describedBy, invalid }` to the one control inside it through context. The control sets `id`,
  `aria-describedby` and `aria-invalid` from it; outside a `Field` it works with its own props.
- `SubmitButton` reads `useFormStatus()` for its pending state, so no form passes `pending` down.
- `FormMessage` is the single place an action's result is shown: `role="status"`, `aria-live="polite"`,
  neutral, success or error tone, and an icon so tone is not carried by colour alone.
- On success a form that stays on the page raises a toast and remounts (a `key` that increments) to clear
  every field, including Radix ones.
- Server actions keep their current contracts (`{ ok, message }` state); nothing on the server changes.

### 4.6 Feedback rules

| Situation | Treatment |
|---|---|
| Action succeeded and the page stays | `toast.success(message)` |
| Action failed | inline `FormMessage` (error), never only a toast |
| Something a person must read to continue (a one-time invitation link) | inline, with a `CopyButton` |
| Long-running action (agent cycle) | loading `Button` + indeterminate `ProgressBar` + step text; toast on completion |
| Copy to clipboard | the icon swaps to a check for 2s, plus `toast("Copied")` |
| Destructive action | `ConfirmDialog`; its confirm button shows the pending state |

## 5. Component inventory

Each primitive gets a server-render contract test where it has behaviour worth pinning (marked ✓).

| Component | API sketch | Notes |
|---|---|---|
| `cn` ✓ | `cn(...inputs)` | `extendTailwindMerge` knows `text-reasoning`, the shadow, easing and animation tokens |
| `Button` ✓ | `variant: primary \| secondary \| ghost \| danger \| danger-solid \| link \| inverse`, `size: sm \| md \| lg \| icon \| icon-sm`, `loading`, `asChild` | `type="button"` unless set; `loading` → `aria-busy`, disabled, a spinner in place of the leading icon, width unchanged. Primary lifts 1px on hover and settles on press. `icon` sizes require `aria-label` (a runtime dev warning and the contract test). |
| `SubmitButton` ✓ | `Button` props + `pendingLabel` | `type="submit"`, pending from `useFormStatus` |
| `Badge` ✓ | `tone: neutral \| agent \| proof \| held \| refused \| simulated`, `size: sm \| md`, optional `icon`/`dot` | `simulated` is hatched and dashed |
| `Chip` | `chipVariants({ selected })` | filter pills that are links (`aria-current`) |
| `Card` | `tone: default \| agent \| held \| refused \| simulated`, `interactive`; `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | `interactive` adds lift, `shadow-raised` and an agent border on hover |
| `Callout` ✓ | `tone: neutral \| agent \| proof \| held \| refused`, `title`, `icon`, `role` | replaces the guardrail band, key warnings, sweep status, error boxes |
| `Eyebrow` | children | today's mono uppercase `Label`, renamed so `Label` is not two different things |
| `SectionHeader` | `title`, `meta`, `action` | today's `SectionHead` |
| `EmptyState` | `icon`, `title`, `body`, `action`, `compact` | hatched, dashed |
| `Skeleton` | className | shimmer |
| `Spinner` | `size` | `aria-hidden`; the owner supplies the accessible text |
| `ProgressBar` | `value?` (none = indeterminate), `label` | `role="progressbar"` |
| `Kbd` | children | |
| `Separator` | `orientation` | |
| `Avatar` | `name`, `tone`, `size`, `shape` | initials; workspaces are rounded squares, people are circles |
| `Table` | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | scroll container with a minimum width |
| `Disclosure` | `summary`, `defaultOpen`, `variant: default \| bare` | `<details>`; `bare` for rows that draw their own summary |
| `Field` ✓ | `id`, `label`, `description`, `error`, `hint`, `children` | |
| `Input`, `Textarea` ✓ | native props + `size: sm \| md` | `shadow-control`, invalid styling from `aria-invalid` |
| `Select` | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` (+ `name`, `required`, `size`) | submits through `FormData` |
| `Checkbox` | Radix Checkbox + label | submits `on` like a native checkbox |
| `FileInput` | `accept`, `onFile`, `label`, `hint` | a dashed drop zone around a visually hidden file input; click, keyboard and drop |
| `FormMessage` ✓ | `tone`, `children` | |
| `Tooltip` | `<Tooltip content side>` + `TooltipProvider` | for icon-only controls; never the only carrier of essential text |
| `Dialog` | `Dialog`, `DialogTrigger`, `DialogContent` (title and description required), `DialogFooter`, `DialogClose` | |
| `ConfirmDialog` | `trigger`, `title`, `description`, `confirmLabel`, `tone`, `formId`, `pending` | confirm is `type="submit" form={formId}` |
| `Sheet` | `side: left \| right \| top \| bottom`, `title` | Radix Dialog; replaces the native drawer and the landing menu |
| `DropdownMenu` | `DropdownMenu`, `…Trigger`, `…Content`, `…Item`, `…Label`, `…Separator`, `…Group` | items accept `asChild` for links |
| `Tabs` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Motion indicator |
| `Command` | `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut` | cmdk, styled |
| `Toaster` | — | Sonner, `unstyled` with our classes; bottom-right, full width on phones |
| `CopyButton` | `value`, `label` | |
| `Reveal` | `delay`, `as` | Motion `whileInView` |
| `MotionProvider` | — | `LazyMotion` (async `domMax`, `strict`) + `MotionConfig reducedMotion="user"` |

## 6. Screens

| Screen or component | Change |
|---|---|
| Root layout | `Providers` + `Toaster`; `themeColor` from `THEME_COLOR` |
| `AppFrame`, `AppNav` | Workspace switcher → `DropdownMenu`; drawer → `Sheet`; a search button with `Kbd` opens the command palette; section icons from a typed `Record<NavKey, LucideIcon>`; animated active pill; the sidebar footer becomes an account menu (all workspaces, create, sign out). Mobile top bar gains a search button. The `.nav-drawer` CSS is deleted. |
| `ProductShell`, `PageHead`, `loading.tsx`, `error.tsx` | Status strip from `Badge`s; page content enter animation; `Skeleton`s; error card from `Card` + `Callout` + `Button`. `PageHead` keeps its name — `navigation.test.ts` finds each page's title through it. |
| `SiteHeader`, `SiteMenu`, `SiteFooter` | `Button` links; the landing menu becomes a top `Sheet` |
| Landing | Buttons, interactive `Card`s, `Reveal` on section headings and grids; the CTA band uses the `inverse` button and on-agent tokens instead of white |
| Login, onboarding, invite, both not-found pages | `Card`, `Field`, `SubmitButton`, `Callout` for errors, `EmptyState` for invalid invitation states; onboarding's workspace list as interactive cards with `Avatar` |
| `MembersPanel` | `Table` with avatars; role `Select` (`sm`); remove, leave and revoke through `ConfirmDialog`; toasts on success; the one-time link inline with `CopyButton`; revoked invitations fade out |
| `CounterpartyIntake`, `InvoiceIntake`, `InvoiceCsvImport`, `MilestoneVerification` | `Field` + controls, `SubmitButton`, `FormMessage`, toasts, remount on success; CSV through `FileInput` and a `Table` preview; the invoice intake's two `<details>` become `Tabs` |
| `AgentControlsClient` | Loading `Button` with a play icon, `ProgressBar`, step text, toast on completion |
| `VerifyLedgerBadge` | Secondary `Button`; the verdict as a `Callout` (proof, refused or neutral for "not checked") |
| `DecisionCard` | `Card` tones; the guardrail band as a refused `Callout`; evidence as `Badge`s |
| `Treasury` (`StatTile`, `AccountsList`, `ForecastPanel`, `MoreLink`) | `Card` (interactive when linked), `SectionHeader`, `Eyebrow`; `MoreLink` → `Button variant="link"` |
| `AuditLedger`, `DomainFilter`, `CycleReport` | Rows as `Disclosure variant="bare"`; full hash, previous hash, body hash and signature each get a `CopyButton`; filters as `Chip` links; the cycle report as an agent-toned `Card` |
| Compliance, counterparties, contractors, invoices, audit, insights, members pages | Page chrome from the primitives: `Callout`, `Card`, `Badge`, `EmptyState`, `Disclosure`, `Button` links |
| `InsightsCharts` | Chart chrome only: `Card`, `Badge` provenance, `EmptyState`, `Disclosure` + `Table`. The SVG drawing is unchanged. |
| `Glyphs.tsx` | Keeps `DomainGlyph`, `OutcomeGlyph` and the domain constants; the generic glyphs are deleted in favour of lucide |
| `vx/Primitives.tsx` | Keeps `Money`, `fmt`, `Hash`, `Reasoning`, `OutcomeBadge` and `ModeBadge` (now `Badge` compositions); `Card`, `Label`, `SectionHead` move to `ui/` |

Copy does not change, except where a control's label must name its action (e.g. the account menu).

## 7. Accessibility

- Radix supplies roles, `aria-expanded`/`aria-controls`, roving focus, typeahead, focus trapping and return.
- Every dialog and sheet has a title (visually hidden where the design has none) and a description.
- Icon-only buttons have an `aria-label`; their tooltip repeats it for sighted mouse users.
- Tone is never the only signal: badges, callouts and form messages carry an icon or a word.
- Status text stays in `aria-live` regions; Sonner's own region announces toasts.
- The skip link, `lang`, and the `main` landmark stay as they are.
- Targets are at least 44×44px on touch widths (§4.3).

## 8. Enforcement and testing

- **`tests/ui-consistency.test.ts`** — scans `src/**/*.tsx`: (1) raw interactive elements outside
  `src/components/ui/` (hidden inputs allowed); (2) colour literals and default-palette utilities anywhere except
  `src/components/ui/tokens.ts`; (3) `MOTION` and `THEME_COLOR` equal their CSS tokens; (4) no removed radius
  utilities (`rounded`, `rounded-sm`, `rounded-3xl`, arbitrary) outside `ui/`.
- **`tests/ui-primitives.test.tsx`** — `renderToStaticMarkup` in Node: `Button` (default type, `loading`,
  `asChild`, icon label), `SubmitButton` outside a form, `Field` wiring (`for`, `aria-describedby`,
  `aria-invalid`), `FormMessage` live region, `Badge`/`Callout` tones, `cn` merging our tokens.
- Vitest's `include` gains `tests/**/*.test.tsx`; the environment stays `node`.
- The existing 1073 tests stay green; `navigation.test.ts`'s `<PageHead title={sectionTitle(…)}` contract is kept.
- **Browser verification** (the in-app preview): `/design` at 1280px and 375px — every state, every overlay by
  keyboard (Tab, arrows, Escape, focus return), the command palette, toasts, the form lab's submitted `FormData`;
  `/`, `/login`, `/onboarding` and 404; console and hydration warnings. Workspace pages need a signed-in session;
  they are verified with the partner's sign-in in the preview, and after deploy on production.
- `npm run build` output is compared before and after for route sizes, and recorded in the PR.

## 9. The `/design` page

Sections: foundations (colour swatches, type, radius, shadow, motion), actions, forms (with a form lab that
submits to a client handler and prints the `FormData` it received — the check that Radix controls submit),
feedback, overlays, navigation, data display, and the domain components rendered from fixtures
(`src/app/design/fixtures.ts`): decision cards in every outcome, stat tiles, accounts, forecast, an audit ledger,
a cycle report, the provenance bar and the risk dial. It links nowhere and is `notFound()` when
`NODE_ENV === "production"`.

## 10. Rollout

One branch (`feat/component-system`), one PR, merged on green CI. No database, API or server-action change, so
Vercel's instant rollback undoes it completely. After deploy: `/` and `/login` return 200 with no console errors;
the partner opens the workspace pages. Dependencies added: `radix-ui`, `motion`, `sonner`, `cmdk`,
`lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`; dev: `tw-animate-css`.

## 11. Out of scope

Dark mode (D13); redrawing the charts (only their chrome changes); Storybook and screenshot-diff testing;
internationalisation; keyboard shortcuts beyond ⌘K; any new product behaviour besides the command palette and
the confirmations.

## 12. Risks

| Risk | Cost if it happens | Mitigation |
|---|---|---|
| Radix Select or Checkbox does not reach a server action's `FormData` | a form silently drops a field | the form lab on `/design`; `name` on every control |
| Workspace pages cannot be seen before merge (sign-in) | a layout bug reaches production | the same components render on `/design` from fixtures; partner check after deploy; instant rollback |
| Bundle grows on the public landing page | slower first load | lazy `domMax`; `lucide-react` is import-optimised by Next; sizes compared in the PR |
| Platform-dependent shortcut label (⌘ vs Ctrl) | hydration mismatch | `useSyncExternalStore` with a server snapshot |
| `tailwind-merge` misreads a custom token | a class silently disappears | extended config + contract test |
| A shared-layout indicator animates between the sidebar and the sheet | a pill flies across the screen | one `LayoutGroup` per navigation instance |
| D1 proves wrong (Radix stalls) | primitives need a new engine | Radix is imported only inside `src/components/ui/`, so a switch to Base UI touches that folder alone |
