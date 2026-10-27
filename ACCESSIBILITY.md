# Accessibility

Written on 2026-10-27. This statement covers the app and the public pages at
[www.vestiarion.xyz](https://www.vestiarion.xyz), the docs at
[www.vestiarion.xyz/docs](https://www.vestiarion.xyz/docs), and the code in this repository that draws them. It says
what we aim for, what is built and held by tests today, what we have not done, and how to tell us about a barrier.

## Our target

We aim for [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA. That is a target, not a claim: Vestiarion has not been
audited against it, and we do not say that it conforms. The one thing the repository claims to meet AA is the contrast
of text in the colours the design system defines.

## What is in place, and what holds it

Each item names the code that does it and, where there is one, the test that fails if it stops.

- **Text contrast.** Thirty pairs of text and background colours from the design system must reach 4.5:1, the AA
  figure for small text, computed with WCAG 2's formula (`tests/ui-tokens.test.ts`). The step labels of the landing
  page's dark safety section, and the secondary text in a highlighted menu, select or command row, are checked the
  same way.
- **Visible keyboard focus.** A focused control shows one solid 2px outline (`src/app/globals.css`), turned white
  inside agent-blue and dark sections so it does not vanish into them. `tests/ui-consistency.test.ts` fails on a focus
  style that is only a soft halo, and on an agent-blue region that does not turn the outline white.
- **One set of controls.** Screens are built from the components in `src/components/ui`. Its dialogs, side sheets,
  menus, selects, tabs, checkboxes, radio groups, popovers and tooltips are built on Radix UI, which supplies their
  roles, keyboard handling and focus management. A raw `<button>`, `<select>`, `<textarea>` or visible `<input>`
  anywhere else fails `tests/ui-consistency.test.ts`.
- **Labels and errors.** A field's label is tied to its control, its description and error are announced with it, and
  an error marks the field invalid and shows an icon and words, not colour alone (`src/components/ui/Field.tsx`,
  `tests/ui-forms.test.tsx`). The message a form shows after it is sent is in a live region that is in the page from the
  start, so a screen reader announces it (`src/components/ui/FormMessage.tsx`). Toasts appear in a live region labelled
  "Notifications" (`src/components/ui/Toaster.tsx`).
- **Names for dialogs and buttons.** A dialog or side sheet does not type-check without a title, and a title that is
  not shown is still there for screen readers (`src/components/ui/Dialog.tsx`, `src/components/ui/Sheet.tsx`). In
  development, a button that shows only an icon logs an error when it has no accessible name
  (`tests/ui-button.test.tsx`).
- **Status in words.** A status is named in words as well as shown in colour (`docs/design/visual-system.md`,
  `tests/ui-display.test.tsx`).
- **Page structure.** Pages declare English (`lang="en"`) and start with a "Skip to content" link, which appears when it
  takes focus and leads to the page's `<main id="main">` (`src/app/layout.tsx`); no test checks that every page has
  one. A table with a label becomes a named region the keyboard can scroll (`tests/ui-display.test.tsx`).
- **Reduced motion.** When the device asks for reduced motion, animations are cut, transitions change only colour or
  opacity, smooth scrolling stops, and content that would slide in appears where it stands. Nothing on the landing page
  animates without end, apart from a loading placeholder (`tests/motion-policy.test.ts`).
- **Zoom and phones.** No page stops the browser from zooming. Approvals and Contractors, where a person decides a
  held payment, were checked at 375px wide, and their decision buttons are 44px tall on a phone
  (`tests/decide-from-a-phone.test.tsx`).
- **Images and videos in the docs.** Every screenshot in the guides needs alt text and a caption
  (`tests/docs-screenshots.test.tsx`). Each of the 14 guide videos plays in the browser's own player, never starts,
  loops or mutes itself, and has a full transcript under "Read the transcript" (`tests/docs-videos.test.tsx`).

## What we have not done

- No independent accessibility audit, and no conformance report such as a VPAT.
- No recorded test with a screen reader: nothing in the repository records a test with NVDA, JAWS, VoiceOver, TalkBack
  or Narrator.
- No accessibility testing in a real browser. The tests check source files and rendered markup, some in a simulated
  DOM; none opens a page in a browser, moves through it with Tab, or runs a checker such as axe. Lint has six
  accessibility rules, from `eslint-config-next`, at warning level, so they do not fail CI.
- Our design notes ask for Tab and Shift+Tab to be checked in the composed page (`docs/design/visual-system.md`), but
  no record of those checks is kept.
- No test checks heading order across the app, or that every field in the app has a label: the components' own wiring
  is tested, not every screen that uses them.

## Known barriers and limits

- **The copy button on code samples.** In the docs' dark code blocks, the copy button (named "Copy code") shows its
  focus outline in agent-blue on the dark panel, about 2.27:1 against it, under the 3:1 that WCAG asks of a focus
  indicator (success criterion 1.4.11). We found this by reading the code (`src/components/docs/CodeBlock.tsx`); it is
  not yet confirmed in a browser or fixed.
- **The `[` key.** On a wide screen, `[` on its own shows or hides the workspace sidebar. It is ignored while you type
  in a field, but it cannot be turned off or changed, which WCAG asks of a single-key shortcut (2.1.4).
- **Phones.** Only Approvals and Contractors have had a pass at 375px. Bills & receivables and Settings have not, and
  the New payment tabs (34px tall) and copy buttons (32px) are under the 44px we aim for on a phone.
- **Video captions.** The guide videos have transcripts but no synchronized captions, which WCAG asks for (1.2.2). The
  README's two films on YouTube, the demo and the product tour, have no transcript in this repository.
- **Contrast is tested by colour pair, not on every screen.** A colour used on a background the tests do not list would
  not be caught: `ink-3` on the `raised` background, for one, is 4.29:1, under 4.5:1, and the design rules keep it off
  that background for text.
- **No high-contrast or dark styles.** The app has no dark theme, and no styles for forced colours (such as Windows
  contrast themes) or for a preference for more contrast. Nothing records how it looks in those modes.
- **Outside these checks.** The email templates and the Chrome extension's popup are not covered by the design-system
  tests; both declare English, and the popup labels its fields. Screens that are not ours, such as a browser's passkey
  prompt, a wallet extension or a connected tool's sign-in page, are outside what we can change.

## Report a barrier

If something in Vestiarion stops you, or makes a task hard, with a keyboard, a screen reader, magnification, voice
control or any other way you work, please tell us.

- **On GitHub:** open an issue with the
  [Accessibility barrier form](https://github.com/duongnq2798/vestiarion/issues/new?template=accessibility-barrier.yml).
  It asks for the page, what you were trying to do, what got in the way, and what you use.
- **Without GitHub:** send a direct message to [@vestiarionhq](https://x.com/vestiarionhq) on X. We will write it up as
  an issue, without your name or handle unless you ask us to include them.

Issues are public: leave out personal data, and never paste an API key, a sign-in link or a wallet key. A barrier that
lets someone reach data or money they should not belongs in a private report instead, as [SECURITY.md](SECURITY.md)
says.

## What happens next

The form labels the issue `accessibility`. We do not promise a response time. Fixes land on `main`, which the hosted
app runs, and pull requests labelled `accessibility` are listed under Accessibility in a release's generated notes.
When a report shows that this page is wrong, we correct this page.
