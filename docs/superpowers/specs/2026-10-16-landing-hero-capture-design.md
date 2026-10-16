# Landing hero: Invoice Capture, the shadow-mode note and the sample bills

Date: 2026-10-16. Branch `feat/hero-invoice-capture`. This is a focused pass on the hero of `/`
(`2026-10-11-landing-clarity-design.md` H1, H2).

It came from a UX review that asked what a business owner needs from the first screen:
- what Vestiarion does;
- what happens before money moves;
- how to try it without a wallet;
- where the Chrome extension fits.

The headline's words, the description, both calls to action and their routes are unchanged.

The first version of this pass was revised the same day after a second review. That version showed Google's store badge
at 170 x 48, put a green rule beside the shadow-mode note and a rule above Invoice Capture, and laid the held bill under
the first as a tab. The review found the badge floating apart from its words, the left column broken into too many
small pieces, and the two bills reading as overlapping mockups. This record describes the revised hero.

## What was wrong

- **The Chrome button.**
  - "Add to Chrome" carried a generic puzzle piece and sat alone under the sign-in line.
  - What the extension does was in small grey text beside it.
  - It showed on phones and tablets, where Chrome cannot install an extension.
- **The left column was fragmented.**
  - The shadow-mode sentence, the sign-in line and the Chrome button each had their own type size and spacing.
  - The column stood taller than the sample bills, so the two columns sat out of balance.
- **The sample bills.**
  - From 640 px the checks sat in two columns, so in the hero's 26-29 rem card they wrapped into narrow columns ("Work
    delivered: pull request / merged").
  - On a phone the invoice reference was cut off with an ellipsis, and below 420 px the held bill hid its invoice
    number.
  - Secondary text was 11-12 px.
  - "Agent: pay it" could be read as a payment made, though the bill waits for a person.
  - The held bill hung under the first as a tab with its own border, tint and shadow.
  - The drawn Agree and pay was solid agent blue, a second blue button beside the page's own call to action.

## Decisions

- **HC1 — The extension's own icon, never Chrome's logo.**
  - Google's brand terms ask that a site be approved before it draws a Google logo, Chrome's included.
  - The Chrome Web Store branding guidelines (developer.chrome.com/docs/webstore/branding) exempt one asset: the
    "Available in the Chrome Web Store" badge, resized only.
  - The partner chose, 2026-10-16, a small Add to Chrome button with Vestiarion Invoice Capture's own icon: the V the
    store lists it with, `public/extension/invoice-capture-48.png`, a copy of the extension's 48 px icon, drawn at 18
    px. Chrome is named in words, a use the guidelines allow.
  - The README links the store with Google's badge (`public/badges/chrome-web-store.png`, the bordered medium PNG, 340
    x 96, unchanged).
  - The README's own drawn button, whose Chrome logo was redrawn from circles, is gone, and
    `scripts/readme-buttons.mjs` no longer draws it.
  - Cost if wrong: if Google approves a request to use Chrome's logo, the icon can change in one line.
- **HC2 — Three groups in the left column, set apart by space alone.**
  1. The message: eyebrow, headline, description.
  2. The call to action, with what trying it asks of you right under it.
  3. Invoice Capture.

  No rule beside the shadow-mode note and none above Invoice Capture.
  - The note: "**Start in shadow mode.** Keep paying the way you do today while the agent decides on your real bills."
  - Then a smaller line: "No wallet or funds needed to start.", "Email sign-in, no password.", How shadow mode works.
- **HC3 — Invoice Capture in one line.**
  - "Capture invoices from Chrome", then "Send an invoice from any page to your workspace as a draft."
  - Beside it, the small secondary Add to Chrome button (32 px high, the extension's icon, an arrow out). It stays
    below "Try it on your bills" and "See how it works" in weight.
  - The words say draft: the extension never adds a bill, approves or pays (guides/invoice-capture).
- **HC4 — The button only where Chrome can install it, in CSS.**
  - A fine primary pointer (a mouse or trackpad, `pointer-fine:inline-flex`) gets Add to Chrome.
  - A touch screen gets "Learn about Invoice Capture" (`pointer-fine:hidden`) in its place, so a phone still learns
    that capture exists.
  - No user agent is read and nothing changes once the page runs, so the server's HTML is the browser's and nothing
    shifts.
  - Cost if wrong: a desktop browser that is not Chrome still sees the button. It opens the store page, which says what
    can install the extension.
- **HC5 — A slightly smaller headline.**
  - 3.25 rem from 1024 px (was 3.5) and 4 rem from 1280 px (was 4.25), and the description at 18 px beside the bills.
  - The hero's left column now stands about as tall as the sample bills: the hero is 806 px tall at 1280-1920 px,
    against 842 px before this pass.
- **HC6 — The sample bills as two rows of one list.**
  - One card holds both bills, as Bills & receivables lists them. The held bill is the next row, under a line, not a
    second card tucked under the first.
  - Both rows open alike: a payee's initial, name, invoice reference (13 px, wrapping as whole phrases) and amount (16
    px, aligned on its baseline, with a 12 px USDC). On a 320 px phone the amount takes a line of its own.
  - The first row: "Agent proposes: pay it", the Safety section's wording, beside "Waiting for your verdict". Then the
    reasoning, and the checks in one column until the card is 32 rem wide (a container query), so none wraps.
  - "Do you agree with the agent?" sits under a line. Agree and pay is drawn in agent-soft, not solid blue, and the two
    drawn controls are hidden from screen readers, which hear "In the product: Agree and pay, or Disagree. Shown here as
    a sample." Nothing in the figure can be pressed.
  - The held row: "Held for you", then "Blocked by code, not by the model." in ink before the rule's words.

Rejected:
- Chrome's logo on the button: it needs Google's approval.
- A client-side browser check: it causes a flash or a layout shift, for little gain over HC4.
- A shorter description: the current one names the three outcomes, and the review kept the core copy.
- A card around Invoice Capture: it would add a layer, and the review asked for fewer.

## Checked

`tests/landing-hero.test.tsx` checks:
- the left column's three groups in order, with no rule;
- the capture words say draft, never that the extension adds, approves or pays;
- the guide link shows to touch only;
- Add to Chrome:
  - links to the store listing in a new tab;
  - carries the extension's icon, byte for byte the extension's own;
  - is the small secondary button, shown to a fine pointer only;
- no Chrome logo, Google badge or puzzle piece in the hero;
- the README's badge is Google's file by its SHA-256, and `scripts/readme-buttons.mjs` draws no Chrome icon;
- the two bills:
  - are rows of one card with the same amount style;
  - the drawn Agree and pay is agent-soft;
  - the drawn controls are hidden from screen readers;
  - "Agent: pay it" is gone.

Headless Edge, with reduced motion and touch emulated below 768 px:
- Widths: 320, 375, 390, 430, 768, 1024, 1280, 1366, 1440 and 1920 px.
- No horizontal overflow at any width.
- Add to Chrome is hidden on touch and shown with a mouse, beside its words from 1024 px.
- No check or invoice reference wraps mid-phrase.
- The keyboard order runs from the calls to action to the shadow-mode guide to Add to Chrome, each with the focus ring.
