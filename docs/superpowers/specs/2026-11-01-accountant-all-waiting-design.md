# Everything waiting, across every workspace (2026-11-01)

Status: accepted, and built on branch `feat/accountant-all-waiting`, not merged yet. No migration. Where the build reads
the rules more narrowly, "As built" at the end says so.

## Why

The accountant console (`/accountant`, `2026-10-13-accountant-console-design.md` A3; `2026-10-22-accountant-queue-design.md`)
is where a person who serves several businesses looks first. It lists ten kinds of item, but four kinds of work that wait
on a person are still found only by opening each workspace:

- **Verdicts in shadow mode.** A workspace opened from an accountant's client link starts in shadow mode
  (`2026-10-23-accountant-client-links-design.md`). Every decision the agent holds there waits for a person's verdict.
  The console lists such a bill as an ordinary decision and never says that a verdict is what it waits for.
- **Invoices to review.** Invoices emailed to the workspace's address, files dropped into its Google Drive folder
  (`2026-11-01-google-drive-intake-design.md`), and invoices captured in Chrome or sent through a payee's invoice link.
  They wait in a review list on Bills & receivables until an owner or admin adds them, and nothing in the console says
  they are there.
- **Work to accept.** A contractor milestone linked to an Asana task or a Linear issue that is ready for acceptance, or
  held after a change, waits on Contractors.
- **Last month's close.** On the first days of a month the accountant closes the last one. The close pack
  (`2026-10-25-monthly-close-pack-design.md`) is on each workspace's evidence page. Nothing says which clients' months
  are still to be closed.

This change puts these four kinds in the same queue. They are read the same way, routed the same way, and never summed.

Code comments and test names cite the ids, for example "(all waiting AW3)".

## Rules

- **AW1. Same reading as the console.**
  - Each new kind is read in its own workspace, through that workspace's tenant client, as the person (A2).
  - Each is its own `part(...)`, so a failure names it on the workspace's card in "not read" and the rest still show.
  - No service-role read, no read across tenants, no new SQL.
  - Nothing calls a model, Google, Asana, Linear, Xero, QuickBooks, Zoho or Circle. Only Vestiarion's own tables and
    ledger are read.
  - Each part reads at most `ROWS` (200) rows.
  - Amounts stay on their own item, in their own currency, as A5 says.
- **AW2. `verdict`: waiting for a verdict.**
  - Which bills: a held, flagged or awaiting_info payable whose newest agent decision waits for a verdict that can still
    be given. The test is `verdictHolds(...).waiting` (shadow mode S4), read once for the workspace's open payables.
  - Never twice: the bill's `decision` item becomes a `verdict` item. A bill past its decide-by day stays
    `past_decide_by`, and its detail adds "It also waits for a verdict in shadow mode."
  - Who acts: whoever may give a verdict, by the same permission the verdict action checks. Find it in the code; do not
    guess. For anyone else the item says who may.
  - Link: where the verdict is given for that bill.
  - Detail: the agent's decision in a few words (held, flagged, asked for details) and "Give a verdict: agree or
    disagree with the agent."
  - Bills where someone disagreed (`verdictHolds(...).disagreed`) stay `decision` items. Their detail says "Someone
    disagreed with the agent in shadow mode: return or reject it", the refusal `approveAndPay` meets.
- **AW3. `to_review`: invoices to review.** One item per document waiting to be added.
  - **Email and Google Drive.** The workspace's `inbox_emails` rows that are ready, needs_details or unreadable, read the
    way `inboxEmailsToDecide` reads them, through the tenant client. A row's `source` names how it came.
  - **Chrome capture and payee invoice links.** Captured drafts still open: not added, not dismissed, not expired. They
    are read the way the Bills page reads them.
  - Each item shows:
    - Title: the supplier or sender the read named, else the file name or subject, else "An emailed invoice".
    - Detail: how it came ("Emailed to the workspace's address", "Added to the Google Drive folder <name>", "Captured in
      Chrome", "Sent through the payee's invoice link"), and its state ("ready to add", "needs details: <first
      reason>", "could not be read").
    - Amount and currency: as read, when the read has them; else none.
    - Since: when it arrived or was found.
  - Who acts: `records.write`, an owner or admin, who adds or dismisses it. An accountant sees it routed to them.
  - Link: the Bills page with the matching review open (`?review=email`, `?review=captured`).
  - Bills brought in from Xero, QuickBooks or Zoho Books wait in the workspace's own review list (`accounting_bills`,
    `review_state` review, `source_status` open), filled by each tool's sync, and the Bills page reads them from there.
    They are not listed here yet, and the guide says so. They could be read through the tenant client with no outside
    call: a later change.
  - Personal data: the console never shows an email address or an email's words. A sender is shown masked, as the
    review list masks a Drive file's last modifier. A subject is never shown.
- **AW4. `accept_work`: work to accept.**
  - Which milestones: those linked to an Asana task (`asana_task_links`) or a Linear issue (`linear_issue_links`), in a
    live link whose state is ready (completed, criteria written) or held (reopened, a deliverable changed, archived, no
    criteria, unreachable).
  - The words are those of `src/lib/work-tool-cards.ts` and the Contractors card.
  - Title: the contractor's name and the milestone.
  - Detail:
    - ready: "Completed in Linear (ENG-12). Accept it against its criteria."
    - held: "Held: <the link's hold reason in words>."
  - Amount: the milestone's amount in its currency.
  - Since: the completion time, or the hold time.
  - Who acts: the permission the accept action checks. Find it; do not guess.
  - Link: the milestone's card on Contractors.
  - Before migration 0115 (Asana) or 0147 (Linear), the table is missing (42P01 or PGRST205). That tool then adds
    nothing, and nothing is named as unread.
- **AW5. `month_close`: last month to close.**
  - The month: the last full UTC month (`closePackMonth`'s previous month). Only once it has ended, which is always true
    for the previous month.
  - One item per workspace, when both:
    - the month holds at least one payment the close pack would list;
    - no `close_pack_exported` entry for that month exists in the workspace's ledger, by anyone, as a download or a
      Google Sheets export.
  - Count the month's payments with a light count, never by building the pack.
  - Title: the month, "October 2026".
  - Detail: "<n> payments. The close pack has not been downloaded or exported yet."
  - Since: the first day of the following month.
  - Who acts: whoever may download the close pack (`workspace.read`, as `/api/evidence/close-pack` checks). This item
    is routed to every member.
  - Link: `/o/<slug>/evidence/close-pack?month=YYYY-MM`.
  - The item disappears once anyone downloads or exports that month.
  - An item says nothing about months before the last one.
- **AW6. Order.** `TRIAGE_KINDS` becomes past_decide_by, decision, verdict, cosign, confirm_address, accept_work,
  to_review, customer_says_paid, disputed, to_book, month_close, receivable_overdue, connector, limit. What the viewer
  can act on still comes first (A3), then by kind, then the oldest.
- **AW7. Words.**
  - `KIND_TITLES`:
    - Waiting for a verdict / Decisions waiting for a verdict;
    - Invoice to review / Invoices to review;
    - Work to accept / Work to accept;
    - Month to close / Months to close.
  - `DOING`: "give a verdict", "review and add it", "check it and accept it", "download the close pack".
  - `HOLDERS` gains any permission the new kinds use that it lacks.
  - The kind filter, the workspace cards' counts, the age buckets (A6) and "Yours to act on" cover the new kinds with no
    other change.
- **AW8. Hand-off export.** If `GET /api/accountant/handoff` lists open items from the same queue (A7), the new kinds
  appear there with their kind ids.
  - This is not `/api/v1`, so `content/docs/changelog.mdx` needs no entry unless the export is documented there. Check
    and say which.
  - The CSV column for the kind takes the new ids. Nothing else changes.
- **AW9. Docs and screens.**
  - `content/docs/guides/accountants.mdx`: what the console lists, the new kinds, and what is left out (bills brought in
    from an accounting tool, which wait under Waiting for review on Bills & receivables).
  - ARCHITECTURE: the console's paragraph.
  - CHANGELOG [Unreleased].
  - The docs-shots accountant fixture (`src/app/docs-shots/accountant-fixture.ts`) gains one item of each new kind, so
    `/docs-shots/accountant/console` shows them.
  - README only if it lists the console's kinds.
- **AW10. Tests.**
  - `tests/accountant-portfolio.test.ts` (or a new `tests/accountant-all-waiting.test.ts`) covers:
    - each new kind is read in its workspace with that workspace's token;
    - a verdict bill is never also a decision item;
    - a disagreed bill stays a decision;
    - email, Drive and captured documents become `to_review`, with no email address or subject in any item;
    - ready and held Asana and Linear links;
    - before 0115 or 0147, nothing is added and nothing is named unread;
    - month close appears with payments and no export, and disappears after a `close_pack_exported` entry for that
      month (an entry for another month does not count);
    - a part that fails is named in `unread`;
    - routing for each role, and the accountant's view;
    - order.
  - The fakes model the real constraints, as the tests already do.

## What it does not do

- It adds no table, no column and no migration.
- It changes no action. Everything is still done on the workspace's own page.
- It reads no external service.
- It does not list bills brought in from Xero, QuickBooks or Zoho Books yet (AW3).
- It sums no money across items, currencies or workspaces.

## As built

- **AW2.** Only `held` bills are asked about: `verdictGate` and the Approvals card hold a bill for a verdict only while it
  is held. Every bill `verdictHolds` answers `waiting` is one the agent decided to pay (`awaitsVerdict`): never a hold,
  flag or question of the agent's own. So a verdict item's detail says so, and that agreeing pays it, in place of the
  held words: "The agent decided to pay it, and shadow mode pays nothing until a person agrees. Agree and pay it, or
  disagree." It keeps the decide-by sentence, as a decision item's does. For a co-signing accountant, the co-sign's own
  verdict words are dropped, so the verdict is said once.
- **AW3.** The subject and the sender are never read, so neither is a title. A title is the supplier the read named, else
  a Drive file's name, else "An emailed invoice", "A file from Google Drive", "A captured invoice" or "An invoice from a
  payee". An email address in a title, a reason or a folder name is masked. The amount shows only when both the amount
  and the currency were read. Each list is read in the Bills page's own window, its newest 50 (`TO_DECIDE_LIMIT`, with
  the documents still being read counted as that list counts them; `REVIEW_LIMIT` for captured drafts), so an item never
  opens a review list that leaves it out.
- **AW4.** Contractors has no anchor per milestone, so the link is the page. A link held after its payment, and a
  milestone no longer `pending`, are left out: there is no work to accept there. Each tool is read only where it is set
  up (`asanaSettingsFromEnv`, `linearSettingsFromEnv`), as Contractors shows its card. A held link may not be
  accepted as it stands (`acceptable`), so whoever may accept reads "You can review it" in place of "You can check it and
  accept it".
- **AW7.** The plural of `accept_work` is "Milestones to accept", so a card counts "2 milestones to accept".
- **AW5.** A pack taken while the month was still running ("so far", `ended` false) does not close it. The count is the
  close pack's own month filter, settled and unsettled payments alike.
- **AW8.** The hand-off's kind column already holds each kind's title ("Waiting for a verdict"), not its id, and is left
  as it is. Its format does not change, and `content/docs/changelog.mdx` documents only `handoff_exported`'s counts, so
  it needs no entry.
