# Bills & receivables: a summary, three tabs and one New menu

Date: 2026-10-12. Status: decided with the partner (layout), the rest decided here under the autonomy grant. Branch
`feat/bills-tabs`. A change of layout only: no server action, permission, payment rule or read changes meaning.

## Why

`/o/<slug>/invoices` grew one stacked section per feature: four figures and a search, then From email, From Xero, From
QuickBooks, To book in Xero, the New invoice form (four tabs), the 14-day Payment plan, Payables in three groups,
Recurring payments, Receivables with Apply payments, and Deals with From HubSpot. A person who opens it to see what needs
them scrolls past forms and plans first, and a demo found that the From Xero list starts with every bill ticked, so one
click on Add adds all of them, a 2,500 USD bill included.

## The layout (decided with the partner, not reopened)

```
Bills & receivables                                     [+ New ▾] [agent controls]
[Needs you] [Due in 7 days] [Overdue] [Receivables]   <- each card opens its tab and filter
Waiting for review: 6 from Xero · 2 from QuickBooks · 1 won deal in HubSpot · 1 to book in Xero   <- only when something waits
──────────────────────────────────────────────────────
 Bills | Payment plan | Receivables
```

### Desktop (1440 and 1024)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Bills & receivables                                              [+ New ▾] [Run a cycle …]    │
│ Your bills, what the agent decided on each, and why.                                          │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ NEEDS YOU ──┐ ┌ DUE IN 7 DAYS ┐ ┌ OVERDUE ─────┐ ┌ RECEIVABLES ──────────┐                 │
│ │ 3           │ │ 2             │ │ 1            │ │ 4,200.00 USDC         │                 │
│ │ waiting for │ │ 1,370.00 USDC │ │ 450.00 USDC  │ │ owed to you · 3 open  │                 │
│ └─────────────┘ └───────────────┘ └──────────────┘ └───────────────────────┘                 │
│ Waiting for review  [6 from Xero] · [2 from QuickBooks] · [1 won deal in HubSpot] · [1 to book]│
│ ┌──────┬──────────────┬─────────────┐                                                          │
│ │ Bills│ Payment plan │ Receivables │   (tabs: links, arrow keys, Home/End)                    │
│ └──────┴──────────────┴─────────────┘                                                          │
│ [Needs you 3] [Upcoming 8] [Scheduled 2] [Paid and closed 40] [All 51] [Recurring 4]          │
│ [ search: invoice number, id, PO, counterparty, amount, transaction ] [Search]  Sort [Due ▾]  │
│ ┌──────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Northwind Hosting            Due Oct 14     1,250.00 USDC  (Held for you)  Add the PO › │ │
│ │ INV-104 · Servers, October                                                               │ │
│ │ ✕ No PO  ✕ Not received                                                                  │ │
│ ├──────────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ Acme Supplies                Overdue Oct 9    450.00 USDC  (Refused by guardrail) Edit limit│
│ │ PO-77 · ✕ Over its limit                                                                 │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────┘ │
│ 1–3 of 3                                                         [‹ Previous] [Next ›]         │
│ Schedules: 4 active · next: Northwind Hosting, Oct 20, 120.00 USDC   (folded)                  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                          ┌──────────── detail (right panel, 44rem) ─────────┐
                                          │                                              [×] │
                                          │ the existing DecisionCard: reasoning, evidence,  │
                                          │ How the agent decided, Where the payment is,     │
                                          │ Agree/Disagree, Add details, Decide in Approvals │
                                          └──────────────────────────────────────────────────┘
```

### Mobile (390 and 320)

```
┌──────────────────────────────┐
│ Bills & receivables          │
│ Your bills, what the agent … │
│ [+ New ▾]  [Run a cycle]     │
│ ┌ NEEDS YOU ┐ ┌ DUE IN 7 ──┐ │   (two columns from 420px, one below)
│ │ 3         │ │ 2          │ │
│ └───────────┘ └────────────┘ │
│ Waiting for review           │
│ [6 from Xero] [2 from QB] …  │   (wraps)
│ [Bills][Payment plan][Recei…]│   (tab list scrolls inside itself, never the page)
│ [Needs you 3][Upcoming 8] →  │   (filter chips wrap)
│ [search……………………] [Search]    │
│ Sort [Due date ▾]            │
│ ┌──────────────────────────┐ │
│ │ Northwind Hosting  1,250.00 USDC │
│ │ INV-104 · Due Oct 14     (Held)  │
│ │ ✕ No PO ✕ Not received          │
│ │ Next: Add the purchase order  › │
│ └──────────────────────────┘ │
│ detail: full-width view over the page, × at the top │
└──────────────────────────────┘
```

## Decisions

**B1. Three tabs, each its own server render.**
- `Bills` (default), `Payment plan`, `Receivables`. A tab is a link to `?tab=…`; the server renders the summary, the
  strip and only the active tab's content. The inactive panels are present but empty and `hidden`, so every tab's
  `aria-controls` names an element.
- Client state survives a change of search params in this Next.js (`layout-router` keys a page's state without its
  search params), so a tab or filter change keeps an open sheet's typing and the review lists' ticks.
- Cost if wrong: a tab switch waits for the server (as a filter or search did before). The tab shows a pending mark
  while it loads (`useLinkStatus`).

**B2. WAI-ARIA tabs with manual activation.**
- `role="tablist"`, each tab `role="tab"` with `aria-selected`, `aria-controls`, a roving `tabindex`; Left/Right move
  focus and wrap, Home/End go to the ends, Enter or Space opens the tab. Manual, not automatic, because opening a tab
  reads it from the server (APG: use manual activation when a panel cannot show at once). The panel is `role="tabpanel"`,
  labelled by its tab, focusable.
- Cost if wrong: one more key press than automatic tabs.

**B3. The address holds the view.**
- `tab` (`bills` | `plan` | `receivables`), `filter`, `q`, `sort`, `page`, `open` (a bill's detail), `review` (a
  review list opened over the page). Written with `billsHref`, defaults left out: Bills at its default filter is plain
  `/invoices`. Opening a detail or a review list pushes `open=`/`review=` onto the history (Back closes it); closing goes
  back. Refresh lands on the same view, panel included.
- Default filter: Needs you when something needs a person, else Upcoming when something is open, else All. Receivables
  defaults to Outstanding, else All. A search with no filter searches All. Paid and closed and Received sort latest
  first; everything else by the day that matters (the scheduled day, else the due date), as before.
- Cost if wrong: a person who expects the same list each time sees Upcoming one day and Needs you another; the chips say
  which is shown.

**B4. Every address the page answered before still lands where it meant.** `src/lib/bills-view.ts`
(`readBillsQuery`, `resolveBillsView`, `legacyHashHref`), pinned by `tests/bills-view.test.ts`. A fragment never
reaches the server: `LegacyHashRedirect` rewrites the address once the page loads.

| Old address (who makes it) | Lands on |
|---|---|
| `/invoices` (nav, palette, console "See all", Scheduled payments, shadow-mode summary, Getting started, report, Slack/Telegram intake, toasts' "Add details", stuck-payment email for several) | Bills, default filter |
| `/invoices?add=1`, `?add` (palette "Add a bill") | Bills, New ▾ › Bill to pay open |
| `/invoices?add=deal` | Receivables, New ▾ › Deal open |
| `/invoices?history=all` | Bills › Paid and closed, every one, 25 a page |
| `/invoices?history=all#trail-<id>` (evidence page "How the agent decided, step by step") | that bill's detail, at How the agent decided |
| `/invoices#trail-<id>` (toasts, Slack and Telegram decision posts, stuck-payment email) | that bill's detail, at How the agent decided, over the filter and page that hold it |
| `/invoices#settlement-<id>` (Treasury, Payments in flight) | that bill's detail, at Where the payment is |
| `/invoices?status=held\|flagged\|awaiting_info\|processing` | Bills › Needs you |
| `/invoices?status=scheduled` / `pending\|matched` / `paid` | Bills › Scheduled / Upcoming / Paid and closed |
| `/invoices?status=received\|rejected` | Receivables › Received |
| `/invoices?q=…` (a shared search) | the search on Bills, or on Receivables when only receivables or payments to apply match |
| `/invoices?hubspot=<row>#plan-from-hubspot` (HubSpot's Plan collections) | Receivables, Plan collections form filled in |
| `/invoices#from-hubspot` (Settings, HubSpot) | Receivables, at From HubSpot |
| `/invoices#deals` (a deal's "All deals") | Receivables, at Deals |
| `/invoices#from-xero`, `#from-quickbooks` (Settings) | the review list, opened over the page |
| `/invoices#to-book-xero`, `#to-book-quickbooks` | To book in …, opened over the page |
| `/invoices#email-inbox` (Slack "Review in Bills & receivables") | From email, opened over the page |
| `/invoices#payment-plan` | Payment plan |

- The links the app makes now are written in the new form (`invoiceHref(id, "trail")` → `/invoices?open=<id>#trail-<id>`,
  `?review=xero`, `?tab=receivables#deals`), so they land in one load; the table keeps every old one working, links
  already sent included.
- `?open=<id>` with no tab or filter picks the tab and the filter that hold the bill (Needs you, Upcoming or Paid and
  closed; Outstanding or Received) and the page it is on; the detail is rendered even when the bill is on no page
  shown. An id of another workspace is ignored.
- Cost if wrong: an old link opens the right page without its detail. Each row of the table has a test.

**B5. Reads stay on the server, once each, and only for the tab shown.**
- Every tab: invoices, counterparties, the head entry, the stats, the permissions, the entries for all invoices (one
  `ledger_entries_for_targets` call, as before: Needs you counts the bills code refused, which only the entries say), the
  verdict facts, the allocation book, deals, recurring schedules and the review lists (Xero, QuickBooks, bookings,
  HubSpot, email), because the cards and the strip count them.
- Bills only: payment intents and settlements, shared receipts — for the 25 rows on the page (and an open detail),
  not for every bill.
- Payment plan only: the plan (it reads the chain's balance), its outcomes and the sole-approver check.
- Receivables only: pay links and reminders for the rows on the page, payments to apply, the HubSpot prefill.
- No new query, no query twice. Before, the page read the plan, payment intents and pay links on every load, for every
  invoice.
- Cost if wrong: a figure on a card computed from something not read on that tab. The cards use only the every-tab reads.

**B6. A row says who, what, when, how much, where it stands, what is in the way and what to do next.**
- Columns (≥ 640px): counterparty with its reference (memo) under it; the date that matters ("Due Oct 14", "Overdue
  Oct 9" in the held tone, "Pays Oct 20"); the amount, right-aligned with its currency; one badge, the agent's decision
  in a few words (the existing `OutcomeBadge`: Held for you, Scheduled for Oct 20, Refused by guardrail, Settled on Arc,
  Waiting for your verdict); the next action.
- Under the name, only what stands in the way (`billBlockers`: No PO, Not received, Over its limit, High risk, Not
  screened, Waits for a verdict) — the checks that passed are in the detail. A part-paid receivable says what is still
  owed; a receivable made from a deal names it.
- The next action (`billNextStep`, the order `WaitingPayableAction` offers them): Give your verdict; Add the purchase
  order and/or goods receipt (opens the detail where Add details is); the rule's fix (Edit limit, Add address, Review
  screening …) for an owner or admin; Decide in Approvals; Waits for an owner or approver. A bill on its way has none.
- Under 640px the row stacks: name and amount, reference and date with the badge, the blockers, then "Next: …".
- Cost if wrong: a person misses a check that passed but matters; the detail is one click away.

**B7. The detail is the existing card, in a panel.**
- A right-side panel (`Sheet`, 44rem) on desktop; the full width of the screen under 640px. It holds the same
  `DecisionCard` with the same footer as before (verdict first, then Add details / fix / Decide in Approvals, Share
  receipt, the pay link, payments applied, the deal), unchanged.
- The row's name is a link to `?open=<id>` (works in a new tab and without JavaScript, as a full page with the detail
  open); a click opens the panel without a reload. Focus moves to the panel; Escape, the close button or Back close
  it and focus returns to the row that opened it. `#trail-<id>` / `#settlement-<id>` scroll the panel to that section and
  unfold it.
- Opening, previewing or closing a detail sends nothing: every action inside is the card's own button, as before.
- Cost if wrong: two details side by side are not possible; Back goes to the list.

**B8. Filters are links with counts.** A labelled list of links (`aria-current` on the one shown) — Needs you, Upcoming,
Scheduled, Paid and closed, All, Recurring — each with its count. Due in 7 days and Overdue are reached from the cards and
show as an extra chip while chosen. Counts and lists come from the same functions (`billFilterMatches`), so a card's
number is its list's length. Search keeps tab, filter and sort and goes back to page 1.

**B9. Pagination.** 25 a page, on the server, over the filtered and sorted list: "26–50 of 87", Previous and Next as
links (page in the address). A page past the end shows the last.

**B10. The cards.** Needs you (the Needs you filter's count; before, it counted waiting statuses only and linked to
Approvals), Due in 7 days and Overdue (every open bill, with their totals, USDC and EURC never added), Receivables
(what customers still owe on open receivables, part payments taken off, and how many are open and overdue: money owed,
never called cash). Each card opens its tab and filter.

**B11. Waiting for review strip.** Only when something waits: bills from Xero or QuickBooks to add (or closed or partly
paid there since), payments to book in Xero or QuickBooks, emailed invoices to decide, HubSpot won deals to plan (or
changed since). Xero, QuickBooks, bookings and email open their existing review component in a panel over the page
(`review=` in the address); HubSpot opens Receivables at From HubSpot, where its deals are planned. The components are
unchanged but for B12.

**B12. Bills from an accounting tool start unticked.** `AccountingBillsReview` starts with nothing ticked and has
Select all (tri-state, ticks only the bills that can be added). Add stays disabled until one is ticked. The server's
checks are unchanged.

**B13. New ▾.** Bill to pay, Invoice to a customer, From a document, Import a list, Recurring, Deal. Each opens the
existing form in a right-side sheet: 40rem for the forms, 56rem for From a document and Import a list (a table), the
full width under 640px. The forms' validation, idempotency keys, permissions and server actions are untouched; Bill to
pay and Invoice to a customer start the form's direction as payable or receivable (the counterparty chosen still sets
it, as before).
- Unsaved changes: once anything is typed, closing asks "Discard what you entered?" (Keep editing / Discard), and
  leaving the page asks the browser's question.
- After a save the form says what its action said (the toast), and the sheet says "Added. Show it in the list"
  (`?filter=all&sort=added`, the newest first, the row marked "Just added"); nothing says paid or approved. Deal keeps its
  own behaviour: it opens the new deal.
- Only owners and admins see New ▾ (`records.write`, as the form before); a viewer sees "Only an owner or admin of this
  workspace can add or import invoices." The Deal item shows only where deals are set up.
- Cost if wrong: a bigger form feels cramped in a sheet; the sheet scrolls inside itself, never the page.

**B14. Payment plan, scannable.** The same `PaymentPlanSection` data and figures, no new arithmetic:
- A summary row: Cash now, Cushion, Lowest balance with this plan (its day), Discounts this plan would take, Not covered
  by the cash (only when there is some).
- Payments grouped by day, each day's heading with the balance after it (the plan's own `days[].balance`, marked when
  under the cushion as the cash-effect table marks it).
- Each line: payee, amount, where it stands, its flags' short names, and "moves from <day>" when the plan proposes a
  move. Its reason, each flag's sentence, Decide in Approvals and Approve (move to the plan's day) open on demand.
- How the plan chooses days, the cash-effect table, money expected in and the last 30 days stay, folded.
- No chart: the repo has no generic chart primitive (`ScenarioChart`, `PaymentsChart` are tied to their own data), and
  a new dependency is out of scope.

**B15. Receivables.** Filters Outstanding / Overdue / Received / All, the search, sort and pages, Apply payments above
the list (as before, unchanged), rows with the collection state (Reminder 2 sent Oct 9, Reminders paused until …, Pay
link ready · reminders off), then Deals with From HubSpot (won deals, Plan collections, billing emails). Expected money
is never called cash.

**B16. Recurring.** A filter on Bills (bills a schedule made) and a small Schedules block under the list
(`RecurringSummary`, unchanged, with Stop), not a tab.

**B17. Permissions and money are untouched.** Every action is the same component calling the same server action;
the server still decides. Opening, filtering, previewing or rescheduling a view fires nothing. Approvals keeps its page
and its decisions.

## Components

| Component | Kind | What |
|---|---|---|
| `src/lib/bills-view.ts` | pure | the address, filters, sorts, pages, legacy mapping |
| `src/components/vx/bill-next-step.ts` | pure | row blockers, next action, collection state |
| `src/components/bills/BillsSummary.tsx` | server | the four cards |
| `src/components/bills/ReviewStrip.tsx` | client | the strip and its review panels |
| `src/components/bills/BillsTabs.tsx` | client | the tab list (links, keys, pending) and its panels |
| `src/components/bills/BillsList.tsx` | server | filter chips, search and sort, rows, pages, empty states |
| `src/components/bills/BillsPanels.tsx` | client | the detail panel: open/close, history, focus, section scroll; `RowLink` |
| `src/components/bills/NewMenu.tsx` | client | New ▾, its sheets, unsaved changes, after a save |
| `src/components/bills/LegacyHashRedirect.tsx` | client | rewrites an old fragment |
| `src/components/bills/BillsScreen.tsx` | server | puts them together from prepared props (the page and /docs-shots) |
| `src/components/vx/PaymentPlan.tsx` | changed | summary row, day headings with the balance after, lines folded |
| `src/components/AccountingBillsReview.tsx` | changed | starts unticked, Select all |
| `InvoiceIntake`, `InvoiceDocumentIntake`, `BillImport`, `RecurringPayableIntake` | changed | an optional starting direction / success callback for the sheet; nothing else |
| `src/app/o/[slug]/invoices/page.tsx` | changed | reads per B5, builds the rows and details, renders `BillsScreen` |
| `src/app/docs-shots/bills/[state]/page.tsx` | new, flag-gated | the page's states with sample data, for screenshots |

## Regression risks

- **A link that lost its target.** Covered by B4's table and its test; the app's own links move to the new form.
- **Tests that read the page's source.** decision-rows, payment-plan-ui, allocations-ui, control-ui, settlement-track,
  deals-view, navigation, mainnet-copy-pages, access-gates, docs-guides and docs-screenshots read `page.tsx`. They are
  rewritten to hold the same facts where they now live (waiting rows keep `withVerdict(needsYouFor)`, settlements are
  read for payables only, etc.), never deleted.
- **Counts that disagree.** A card's count and its filter's list come from one function.
- **A heavy page.** Only the tab shown is built; 25 cards at most are in the page instead of every bill's.
- **Focus lost.** Sheets restore focus to what opened them; the detail panel to its row.
- **Review lists.** Unticked by default means one more click; Select all keeps it one.
- **Docs.** Guides that name New invoice, Payables, Needs you, Paid and closed, Show all, the order of sections, are
  rewritten; their screenshots re-shot; the guide tests hold each quoted label to its new source file.
