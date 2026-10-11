# Docs clarity: a path to the first decision, and the controls in one place

Date: 2026-10-11. Branch `feat/docs-clarity`. From a review of the docs relayed by the partner.

## What was there

The docs at `/docs` already had a sound frame, kept as it is: a sticky header with search (Ctrl K) and Open console, a
sidebar, an article column of at most 48rem, "On this page" from `xl` up, Copy page and the Markdown view, previous and
next links, and tests that hold every quoted UI label, link, anchor and screenshot to the code.

What a first-time reader met:

- The Overview described an API ("The API gives your integration read access…"), and the page called **Quickstart**
  created an API key. A business owner's way in, "Try it in 5 minutes", was one of fifteen equally weighted guides.
- The sidebar ran Overview, Guides (15), Research, Get started, API reference (one entry per operation), Webhooks, AI
  integration, Changelog: business and developer pages interleaved, section labels in 10px type.
- `##` headings were 20px and `###` headings 16px, the size of body text, so long guides read as one block.
- Nothing on one page said, together, what the agent may pay, what stops it, who approves, and where money can move.
- Screenshots were 2x PNGs shrunk to the column, unreadable on a phone (the Workspace status panel above all).

## Changes

| Id | Change |
| --- | --- |
| N1 | Sections by what a reader is doing: Start here, Everyday work, Trust and controls, Connect your tools, Developers, then API reference, Webhooks, Changelog. Order is the learning order the pager follows. Every page keeps its address; titles changed only for "See your first decision" (`guides/try-it`) and "Developer quickstart" (`get-started/quickstart`). |
| N2 | API reference and Webhooks are disclosures in the sidebar, open when they hold the page being read. Section labels 11px at higher contrast; links 15px on a phone, 14px from `lg`. |
| T1 | Body 16px at 1.75; `##` 24px with more space above than below; `###` 19px; the article's description 17px; "On this page" 13.5px. |
| T2 | A numbered `## 1. …` heading draws its number in a badge. Its id, its line in "On this page" and its accessible name are unchanged, so no anchor moves. |
| C2 | `<Callout kind>`, with kind note, tip, important, warning or real-money: the kind is written beside the title on the page and leads the quote in the Markdown view, so it never rests on colour alone. |
| C3 | A screenshot is a button that opens it in a dialog, as wide as the dialog allows and never narrower than its 1x size, scrolling sideways on a phone. Escape closes it and focus returns to the image. |
| C4 | `<Action href>`: one button-styled link for a guide's next step in the app, used on the quickstart and shadow mode (`/onboarding?shadow=1`). |
| Q1 | "See your first decision" rewritten around the shadow-mode checklist a new workspace shows: sign in, create the workspace in shadow mode, add a supplier, add one bill, see the decision, read why, agree or disagree; then two separate next paths (keep evaluating in shadow mode, or prepare to go live), and sample data as the alternative. No wallet before the first decision. |
| S1 | New "How payments are controlled" (`guides/controls`): a decision is not a payment; the checks in code as a table with what each does (from `src/lib/agent/guardrails.ts`); limits; people; stopping it; where money can move by workspace; who holds the keys; failures; the record. Each part links to the guide that goes into it. |
| S2 | The workspace guide explains every row of Workspace status, as `src/components/vx/workspace-status.ts` words it, and what an unread fact shows. |
| H1 | The Overview speaks to a business first, with four ways in (first decision, shadow mode, controls, developer quickstart) and a note on testnet and mainnet; the developer sections stay below it. |

## Accuracy

Every label the quickstart and the controls page quote is held to its source file by `tests/docs-guides.test.ts`
(labels for the counterparty and invoice forms, the shadow-mode checklist, the verdict, the approval card, the pause
control, two approvals, the spending limit and the payments switch). Facts checked in code on 2026-10-11: a sandbox in
shadow mode decides with no wallet and simulates an agreed payment; a high-risk payee is flagged and never paid, even
by approval; a duplicate is flagged; a missing purchase order or receipt asks for information; the other rules hold;
`agent.run_cycle` is owners' and admins'; `agent.pause` owners', admins' and approvers'; the person who entered a bill,
or gave a new payee's address, cannot approve it unless they are the only approver; Arc mainnet starts with two
approvals above 100 USDC and a 50/150 USDC spending limit; developer-controlled wallets are signed by Circle on
Vestiarion's behalf, and a wallet-held treasury on Arc mainnet pays only through its own contract.

## Deferred

- A remembered open or closed state for each sidebar section (P2).
- A feedback widget, dark mode, search filters (P2). Search, Copy page and Markdown are unchanged and still work.

## Quickstart screenshots (Q2, follow-up)

The quickstart shows each step as the app draws it, from the app's own components with made-up data
(`src/app/docs-shots/shots.tsx`, `try-it-*`): the workspace form with a test workspace and shadow mode ticked, the
**Get started in shadow mode** checklist, the counterparty form filled for the example supplier (Northwind Hosting, a
vendor with a 500.00 USDC limit and no purchase orders), the New invoice form for its 120.00 USDC bill, and the bill's
card waiting for a verdict. The first payment's invoice shot and the quickstart's share one form (`NewInvoice`).
