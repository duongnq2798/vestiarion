# Deals: a signed deal as a collection schedule

Date: 2026-10-12. Status: decided (autonomy grant 2026-10-05). Roadmap: F04.

## Why

A services business signs a deal (a 30% deposit and 70% on delivery, a monthly retainer, three milestones) and then
works out by hand when to invoice and chase each part. Nothing ties the invoices back to the deal, and a price change
after signing is fixed by editing invoices that may already be paid.

A deal in Vestiarion is the agreement on the receivables side: who pays, how much, in what currency, and a schedule of
lines that add up to the total exactly. Confirming it plans every line; releasing a line makes it an ordinary
receivable through the path every receivable takes. A change after signing is a new version that never rewrites what
was invoiced or paid.

## Decisions

**D1. A line not yet invoiced is a planned deal line, not an invoice.**
- Confirming a deal writes version 1 and one `deal_lines` row per line, `planned`, dated for its invoice day and its due
  day. Nothing is added to `invoices` until the line is released, so no list, figure, reminder, pay link or API that
  reads receivables sees a planned line.
- Cost if wrong: a planned line is not in `GET /api/v1/invoices`. A later migration can expose deal lines on their own,
  without touching the invoices every other feature reads.

**D2. Amounts are minor units.**
- A deal's total and every line are integers in the currency's minor unit (`bigint`): cents for USDC, EURC and two-
  decimal currencies, whole units for currencies without minor units (JPY, KRW and the others `billDigits` names). The
  total is at most 10^15 minor units. The arithmetic runs on `BigInt`, so no share is ever a float.
- Cost if wrong: a USDC total with more than two decimals is refused. Invoices to clients are written in cents.

**D3. Currencies follow today's rules for receivables.**
- USDC and EURC, which are paid on Arc. Any other three-letter code only while the workspace is in shadow mode, as the
  invoice form takes one: at release the line goes through `shadowBill`, which converts it to USDC at the day's rate and
  keeps the bill's own figure in `original_*`. VND is never offered and is refused by the server and the database.
- Planned lines in another currency are listed apart, in their currency, and never converted until release.
- Cost if wrong: a workspace outside shadow mode cannot keep a deal in its own currency; the USDC of a shadow deal is
  known only at release.

**D4. Templates, then the person edits.**
- Deposit and balance: a percent (up to two decimals) on the start date, the rest on the delivery date.
- Milestones: 2 to 24 equal parts, each with its date and an optional name.
- Monthly retainer: 1 to 60 months on a day of the month; the first month is the first such day on or after the start
  date; a day past a month's end is that month's last day (31 is Feb 28 or 29, Apr 30).
- Custom lines: up to 60 lines, each a name, an invoice day and an amount.
- Every template gives lines the person can edit before confirming. The server builds the template again from its
  inputs and keeps a line's rounding only where the posted line is the built one.
- Cost if wrong: a schedule that fits none of the templates is typed as custom lines.

**D5. Lines sum to the total exactly; the remainder goes on the last line and is shown.**
- Each line takes the floor of its exact share in minor units; the last takes what is left (`rounding_minor` records
  how much of it is rounding, and the schedule says "Includes 0.01 from rounding").
- Custom lines that do not add up are refused, naming the gap. A database constraint trigger checks at commit that the
  lines in force at every version add up to that version's total.
- Cost if wrong: some businesses put the remainder on the first line. An option can be added; the stored lines say
  which line carries it either way.

**D6. Each line's due day is its invoice day plus the deal's payment terms.**
- Terms are 0 to 365 days, 14 by default, set once per deal. The receivable's due date is the line's due day.
- Cost if wrong: one line with different terms is entered as a custom line on the day that gives its due day.

**D7. Versions; released lines are never rewritten.**
- Version 1 is signed when the deal is confirmed. A price change, a moved or renamed line, a cancel or a reopen is a new
  version with its own total, reason and the changes it made. A version ends planned lines (`superseded` when another
  line replaces them, `cancelled` when removed) and adds new lines; it never changes a line.
- The tenant role may update only a line's status and release fields (column grants), and a trigger allows only
  `planned` to `released`, `superseded` or `cancelled`, and `released` back to `planned` only while no receivable names
  the line (D10). So a released line, and its receivable, never change through a deal.
- The new version is written by `revise_deal` under a lock on the deal, against the version the person saw: a change
  made meanwhile is refused (`changed`), and the page shows the deal as it is now.
- Cost if wrong: a released line whose amount was wrong stays wrong; the version adds a correcting line or a credit.

**D8. A price change proposes a correction.**
- Higher: one correcting line for the difference, on the last planned line's invoice day, or today when none is left.
- Lower: planned lines are reduced from the last backwards (a line reduced to nothing is cancelled); what released
  lines already exceed becomes a credit line owed to the customer: never released, never counted as money in or out.
- A credit is only for money already invoiced: the released lines and the credits together never go below zero.
- The person can edit the proposal before saving it; the version shows the difference either way.
- Cost if wrong: a credit is settled outside Vestiarion (a refund or a credit note); the deal records that it is owed.

**D9. Cancel and reopen.**
- Cancel ends every planned charge (`cancelled`); released lines and credits stay; the version's total is what was
  invoiced less credits. Nothing more is released from a cancelled deal.
- Reopen is a new version of a cancelled deal with new lines for what is left, as a change is.

**D10. Release.**
- A person releases a line, before its day or on it; or, where the deal's owner or admin turned on "Release each line
  on its invoice day", the agent's cycle does on its day.
- Release claims the line (`planned` to `released`, compare-and-set), then adds the receivable through `createInvoice`,
  the one way an invoice is added, with `deal_id` and `deal_line_id`; a unique index allows one receivable per line.
  The receivable is then like any other: its pay link, its reminders, its payment matched by the receipts stage.
- If adding the receivable fails, the claim is undone (allowed only while no receivable names the line). A line left
  released with no receivable (a request that died) is released again by the next press or cycle, which finds the
  receivable by its line when one was made.
- Cost if wrong: the cycle runs every six hours, so an automatic release can come up to six hours into its day; a
  sandbox releases automatically only when a member runs a cycle.

**D11. Signed entries.**
- `deal_signed` (version 1), `deal_revised` (a change or a reopen) and `deal_cancelled`, actor `human`, domain `ar`,
  with the deal, the version, the totals in minor units and as decimals, and every line added or ended.
- A release is the receivable's own `create_invoice` entry, with `via: "deal"` and
  `deal: { dealId, lineId, version, releasedBy }`; actor `agent` when the cycle released it.
- `deal_auto_release_changed` when the switch changes.
- Rows are written only after `assertLedgerCanSign`; the entry follows best effort, and a confirm repeated more than a
  minute later writes an entry the first one lost.
- Cost if wrong: two entries per release would say the same thing twice; one entry names both the receivable and the
  line.

**D12. Idempotency.**
- The deal form carries a key made when the page is drawn. `deals` is unique on it per workspace, and `create_deal`
  answers the same deal for the same key: a double click, a retry or a slow network make one deal.
- A change carries its own key (unique per workspace on `deal_versions`) and the version it was made from.
- A key sent again with other details (a form kept from before, as the browser's Back restores it, filled in for
  another deal or another change) is refused (`key_reused`, "This form was sent already, with other details."), and
  the page is drawn again with a new key. It is never answered with the deal or the version the key made, as if this
  one were confirmed. A deal compares its customer, title, currency, start, terms, reference, template, version 1's
  total and lines; a change its kind, the version it was made from, its total and the lines it added.
- A new customer typed into the form is looked up by name among the workspace's clients first, so a repeated confirm
  does not add the customer twice.

**D13. Permissions.**
- `deal.create`, `deal.change` and `deal.auto_release` need `records.write`, as adding a receivable does.
- `deal.release` needs what adding a receivable needs today: `records.write` (`invoice.add`).
- All four run from the console only. Owners and admins hold `records.write`; others see deals without the controls.
- Cost if wrong: the automatic release is a choice any owner or admin makes for a deal, not the owner alone. The switch
  is signed with who set it.

**D14. Money expected, never cash.**
- A released line not paid is a receivable, so Treasury's Next 30 days, the cash scenarios and every other reader count
  it as expected money on its due day, as any receivable, and never as cash.
- Planned lines are "planned": Next 30 days names their total apart, the cash scenarios list them in what the figure is
  built from and count them in no balance, and the payment plan lists them apart.
- The payment plan, which counted no receivable, now lists the money expected in during its 14 days (open receivables,
  released deal lines included) and the planned deal lines, each with its day, apart from its balance. Neither enters a
  balance, a flag or a fingerprint.
- Cost if wrong: a business that wants a planned deal counted as income does not get it. That is the point.

**D15. Before migration 0104 runs.**
- Reading deals answers `available: false` (`PGRST205`, `42P01`, and `PGRST204`/`42703` for the invoice columns): the
  Deals section says "Deals are not set up on this deployment yet." and nothing else on Bills & receivables changes;
  the commands refuse with `not_ready`; the cycle releases nothing and logs nothing.

**D16. External reference.**
- Optional, up to 200 characters, unique per workspace when set, so a CRM connector can find its deal again.

## The data (migration 0104)

- `deals`: customer (`counterparty_id`, composite foreign key), title, currency, `minor_digits`, `total_minor` (the
  current version's), `starts_on`, `terms_days`, `external_ref`, `template`, `status` (`active`, `cancelled`),
  `current_version`, `auto_release` with who and when, `idempotency_key`, `created_by`, timestamps.
- `deal_versions`: one per version (`signed`, `revised`, `cancelled`, `reopened`), its total, reason, the changes as
  shown, its key, who and when. Append-only for the tenant role.
- `deal_lines`: the deal, `added_in` (a version), position, kind (`charge` positive, `credit` negative), label, invoice
  and due days, `amount_minor`, `rounding_minor`, `replaces`, status, `ended_in`, and the release (`released_at`,
  `released_by`, `released_via`). Insert, and update of status and release fields only.
- `invoices.deal_id`, `invoices.deal_line_id`: both or neither, a receivable only, one invoice per line, a composite
  foreign key to the line of that deal.
- `create_deal` and `revise_deal`, security invoker, for the tenant role.
- Row level security as 0090 and 0094; every foreign key composite with `org_id`; additive and safe to re-run.

## Where it shows

- Bills & receivables: a **Deals** section under Receivables, each deal with its released, paid, outstanding and planned
  amounts and its next line; **New deal** for owners and admins.
- A deal's page, `/o/<slug>/invoices/deals/<id>`: the schedule with each line's state, Release now, the automatic
  release switch, Change deal, Cancel deal and Reopen deal, and every version with what it changed.
- Each receivable made from a deal names the deal and its line, and opens the deal.
- Treasury (Next 30 days, What if clients pay late?) and the payment plan as in D14.
