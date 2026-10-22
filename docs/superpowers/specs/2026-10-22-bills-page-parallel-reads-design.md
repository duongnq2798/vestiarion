# Bills page: reads at once

Date: 2026-10-22. Status: accepted.

## Why

Bills & receivables (`/o/<slug>/invoices`) sends its first byte in 310 to 750 ms in production, but the whole page takes
1.6 to 3.0 s to arrive. No single query was slow. The page read its data in a line: each read waited for the one before
it, even when it did not need that read's answer. What customers said waited for the deals' costs, the payments to book
waited for what customers said, the entries about the invoices waited for the payments applied, the receipts waited for
the projects, the early-payment offers made seven trips one after another, and the header's shadow mode was read last
of all. Some reads were also made more than once: the workspace's members up to five times, and each accounting tool's
connection twice, once for its bills brought in and once for its payments to book.

Against a test database that answers the page's requests in rounds, the Bills tab took 18 rounds.

## What

**R1. Reads that wait on nothing start together.** Everything that needs only the workspace and the address is asked
for at once: the invoices, the counterparties, the figures, the permissions, the recurring payments, the cycle running,
the emailed invoices, each tool's bills and payments to book, the deals, the CRMs' won deals, what customers said, the
drafts captured, the payments applied, the projects for New ▾, and the header's shadow mode and screening (still read
in the workspace's scope, now with the first reads instead of after everything).

**R2. A read that waits on another starts when that one answers.** The entries about the invoices start when the
invoices arrive, and the verdicts when the entries do; each deal's costs and what it collected start when the deals
arrive; the projects when the viewer's permission to add is known. None waits for the rest of the first reads.

**R3. The cards and the tab are read at once.** Once the decisions say which tab, page and cards are shown, these start
together: the payments and FX variances of the cards shown, their pay links, the collections, the members for the bills
waiting and the first-payment facts, who captured each draft, and the tab's own reads (Bills: early-payment offers, term
requests and supplier status links; Payment plan: the plan and the cash priority order; Receivables: the CRM deals to
plan, statement links, pay links asked for and customer discounts). Only the shared receipts wait, on the payments,
which say whether a card offers one. The tab is built beside the cards, and its list is added once the cards are.

**R4. Inside the reads.** `offersView` checks first, as before, that offers are set up (0125), then reads the bills
worth an offer, the offers made, the reserve and the agent's setting at once, then the bills a payment started for, the
offers without counters (before 0127) and the agent's offers at once: three or four trips instead of seven or eight.
`verdictFacts` reads shadow mode and the verdicts given at once. `readCollections` takes the members as a read already
under way and starts its own reads without waiting for it.

**R5. A read two parts need is made once.** The members are read once per page, and each accounting tool's connection
once, by a promise the page keeps. Not React `cache()`: `listMembers` and `connectionFor` also serve server actions,
OAuth callbacks and jobs, where an answer remembered across a write could be stale.

What stays the same: what the page shows; the workspace's scope and permissions (`inOrg`, `viewerCan`); every best-effort
read's catch and its log line; the before-migration tolerance of each read, which keeps its own handling; and a read that
failed the page before still fails it, with the same error. Against the same test database the Bills tab now takes 6
rounds, and so do Receivables. In production, with each round a trip to the database, the whole page should arrive in
well under a second for a workspace with about a hundred invoices.

## Not in this change

- Sections behind their own Suspense boundaries. The page already streams after `loading.tsx`'s frame, and it ends
  when its longest chain of reads does; splitting it would change what shows first, not when the page is done.
- Reading the tab's data before the decisions are known, when the address names the tab. One more round could go.
- One read of shadow mode for the header and the verdicts. They are two reads of one row, made at the same time.
- Migrations, indexes, or anything under `/api/v1`.

## Tests

`tests/bills-page-parallel.test.ts` renders the page against a fake database that holds every request until none has
arrived for a moment, then answers them all, so a read's round says what it waited for:
- the first reads, from the invoices to the header's shadow mode and the Xero connection, are in the first round, and
  the entries about the invoices in the second;
- on Bills, the cards' payments, the members and the tab's reads share a round; the receipts and the offers' own reads
  the next; six rounds in all;
- on Receivables, the statement links, the customer discounts, the collections' open tasks and the members start with
  the cards' pay links;
- on Payment plan, the plan and the cash priority order start together;
- the members are read once, and so is Xero's connection.

`tests/mainnet-copy-pages.test.tsx` holds that the page still hands the header `shellStatus()`, read in the workspace's
scope. The tests that read the page's source, `tests/early-payment-offers-view.test.ts`, `tests/verdicts.test.ts` and
`tests/collections-context-ui.test.tsx` pass unchanged.
