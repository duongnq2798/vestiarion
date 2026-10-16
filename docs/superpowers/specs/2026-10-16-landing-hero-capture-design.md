# Landing hero: Invoice Capture, the shadow-mode note and the sample bills

Date: 2026-10-16. Branch `feat/hero-invoice-capture`. A focused pass on the hero of `/`
(`2026-10-11-landing-clarity-design.md` H1, H2), from a UX review that compared it with the page a business owner needs:
what Vestiarion does, what happens before money moves, how to try it without a wallet, and where the Chrome extension
fits. The headline, the description, the two calls to action and their routes are unchanged.

## What was wrong

- **The Chrome button.** "Add to Chrome" carried a generic puzzle piece, sat alone under the sign-in line, and said what
  the extension does in small grey text beside it. It showed on phones and tablets, where Chrome cannot install an
  extension.
- **The shadow-mode note was three pieces.** A bold lead with a sentence, a smaller grey line (email sign-in and the
  guide), then the Chrome button, each with its own type size and spacing.
- **The sample bills.** The checks sat in two columns at every width from 640 px, so at the hero's 26-29 rem card they
  wrapped into narrow columns ("Work delivered: pull request / merged"). The invoice reference was cut off with an
  ellipsis on a phone ("milestone 2 …"), and the held bill hid its invoice number below 420 px. Secondary text was 11-12 px.
  "Agent: pay it" could be read as a payment made, though the bill waits for a person.

## Decisions

- **HC1 — Google's badge, not Chrome's logo on our button.** Google's Chrome Web Store branding guidelines
  (developer.chrome.com/docs/webstore/branding) let a site use the "Available in the Chrome Web Store" badge without
  asking: resized only, in proportion, always linking to the item's store page, never the page's main element. Using
  Google's logos otherwise needs Google's written approval (Google's brand terms). So the hero and the README show the
  badge, the bordered medium PNG as Google ships it (`public/badges/chrome-web-store.png`, 340 x 96, drawn at 170 x 48),
  and the README's own drawn "Add to Chrome" button, whose Chrome logo was redrawn from circles, is gone
  (`scripts/readme-buttons.mjs` no longer draws it). The store page's own button is Add to Chrome, which the guide names.
  Cost if wrong: if Google approves a request to use Chrome's logo, the badge can become a button of our own.
- **HC2 — Invoice Capture as one quiet row under the note.** "Capture invoices from your browser", then "A Chrome
  extension saves an invoice from any page or file to your workspace as a draft, for you to check and add.", a link to
  the guide (Learn about Invoice Capture) and the badge, after a rule. The words say draft, and that a person adds it:
  the extension never adds a bill, approves or pays (guides/invoice-capture). The badge is white and smaller than the
  calls to action, so "Try it on your bills" stays first and "See how it works" second.
- **HC3 — The badge only where Chrome can install it, in CSS.** It shows to a fine primary pointer
  (`pointer-fine:inline-flex`, a mouse or trackpad) and is hidden on touch screens; the guide link shows everywhere, so a
  phone still learns that capture exists. No user agent is read and nothing changes once the page runs, so the server's
  HTML is the browser's and nothing shifts. A desktop browser that is not Chrome still sees the badge; it names the
  Chrome Web Store, and the store says which browsers can install it. Cost if wrong: a Firefox or Safari visitor opens
  the store page and learns there that it needs Chrome.
- **HC4 — One note for what trying it asks of you.** The shadow-mode sentence and the email sign-in line sit together
  behind a 2 px proof-green rule, the copy unchanged. "Turn on payments later" stays the title of the next section
  (How it works), so the hero does not repeat it.
- **HC5 — Sample bills.** Checks in one column until the card is 32 rem wide (a container query on the figure), 13 px,
  so none wraps; invoice references at 13 px, wrapping whole ("milestone 2 of 3" kept together) instead of cut off;
  amounts aligned on their baseline with a 12 px USDC; "Agent proposes: pay it", the wording of the Safety section,
  beside "Waiting for your verdict"; the held bill tinted held-soft, its number on its own line, "Blocked by code, not by
  the model." in ink before the rule's words. The layering, labels and caption stay. The drawn Agree and pay and
  Disagree are hidden from screen readers, which hear "In the product: Agree and pay, or Disagree. Shown here as a
  sample." instead; nothing in the figure can be pressed, as before.

Rejected: a client-side browser check for the badge (a flash or a layout shift, for little gain over HC3); stacking the
two bills as separate cards (the layering already reads as one list; the tint makes the held one distinct); a larger
shadow-mode card (the rule groups it without adding weight).

## Checked

`tests/landing-hero.test.tsx`: the badge links to the store listing in a new tab, is Google's file by its SHA-256 at
340 x 96, drawn in proportion, hidden by default and shown to a fine pointer; the capture words say draft and never that
the extension adds, approves or pays; the guide link; the shadow-mode note holds the sign-in line and its guide; the
drawn controls are hidden from screen readers and said to be a sample's; "Agent: pay it" is gone.

Headless Edge at 320, 375, 390, 430, 768, 1024, 1280, 1440 and 1920 px, reduced motion, touch emulated below 768:
no horizontal overflow, the badge hidden on touch and shown with a mouse, no check wrapping at any width.
