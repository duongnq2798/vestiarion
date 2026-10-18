# Landing integrations: what a connection does, then the rest

Date: 2026-10-18. Branch `feat/landing-integrations-redesign`. Component: `src/components/landing/Integrations.tsx`.
Follows `2026-10-16-landing-integrations-design.md` and `2026-10-16-landing-arc-circle-design.md`.

## Why

A UI/UX review (Codex, about 8.2/10) found the section read as a directory: nine tools at the same weight in three rows,
with nothing showing what a connection accomplishes. It asked for a hierarchy (the accounting tools a business pays its
bills from first, the rest compact, Arc and Circle apart as infrastructure), one real workflow from a tool to a
controlled payment and back, and one link to every integration.

## Decisions

- **W1 — the heading stays.** "Keep your tools. Vestiarion connects to them." The sentence beside it says the tools stay
  in place, what comes in from them, that nothing is paid until it passes the business's rules, and that the tools that
  support it get the outcome back. From 1024 px the two sit side by side.
- **W2 — Xero and QuickBooks Online first.** Two cards, each with its mark, how it connects ("Reads and books back",
  "Read-only"), what comes in and what goes back, its setup guide and its walkthrough film. Xero is the only tool with a
  booking back, and only for an entry a person approves; QuickBooks Online writes nothing and still connects to sandbox
  companies only (L5 of the earlier spec). The two cards are not equal claims: each says its own.
- **W3 — Xero's loop, as the product runs it.** "From your existing tools to a controlled payment.": a bill approved in
  Xero comes in for review and a person adds it; the agent proposes and code checks limits and approvals, what fails
  waiting for a person; what passes is paid on Arc in USDC or EURC; the payment is booked against the bill once a person
  approves the entry. Labelled "With Xero · the supported workflow": it shows no transaction, amount or date, so it is
  not read as one payment's record. Its note says payments in shadow mode and on Arc testnet are booked only into a Xero
  demo company (accounting write-back W1). Four steps in a row from 1024 px, two by two from 640 px, a list below. It
  supersedes L3's "no arrow diagrams": the arrows sit between boxes that carry the conditions in words.
- **W4 — the other nine, compact.** Zoho Books, HubSpot, Pipedrive, Zoho CRM, Asana, GitHub, Slack, Telegram and Invoice
  Capture, each with the job it does as a small label and one sentence on what is particular to it, in three full rows
  of three from 768 px and one list below. GitHub and the Chrome extension are new to the section: both are in the docs'
  "Connect your tools" and were missing here. GitHub's mark is the one the footer already draws; the extension shows its
  own store icon. The npm SDK line moved out: the developers' section that follows offers the SDK.
- **W5 — Arc and Circle apart.** "Built on Arc, with Circle", "Not tools you connect", as one ruled panel with a row
  each: who it is and its site, what the product does on it, and the evidence. "Built on", never "powered by" (L11):
  the marks test holds it. Arc's spending-limit fact left with the safety section, which says it.
- **W6 — one link for every integration.** "Explore all integrations" leads to a new docs page,
  `/docs/guides/integrations` ("Every integration at a glance"), first in "Connect your tools": one table of what each
  tool brings in, what goes back and who allows that, and how it connects (read-only, reads and writes, event-triggered,
  an app, a chat bot, a browser extension), then what none of them does, what the payments run on, BlindPay's bank
  payouts with their sandbox status, and the API for anything not listed. Cards keep "Setup guide" (L6): the link leads
  to the tool's guide.

## Sizes

Measured on the dev server against the live page: desktop 1,892 px (was 1,676), tablet 2,415 (2,036), mobile 3,858
(2,969). The section gains the workflow, two tools and two richer cards; each tool's sentence and the panel were cut to
keep the growth to about an eighth on a wide screen.

## Tests

`tests/brand-marks.test.tsx` ("the landing page's integrations"): the order of the featured tools, the nine others and
their kinds, the five headings, what each featured tool brings in and what goes back, the sandbox status, the workflow's
steps and label and that it shows no one payment's facts, every sentence that carries a condition, every link and mark
in order, and no endorsement wording. `tests/docs-content.test.ts` places the new docs page; the copy ratchet counts the
section's third "Arc testnet", the booking rule.
