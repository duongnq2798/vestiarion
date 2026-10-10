# Agent vs what really happened

Date: 2026-10-10. Status: decided (autonomy grant 2026-10-05). Roadmap: F03, with I05 (each figure links to its source).

## Why

A business trying the agent in shadow mode keeps paying its bills from its bank, as it does today. A verdict says
whether a person agreed with a decision; it does not say what the business then did. To trust the agent, the business
wants to see, bill by bill, what the agent decided next to what it actually paid, and when, and for how much. Without a
record of what it paid, nothing can be compared, so nothing on the page may guess it.

## Decisions

Each decision names what it costs if it turns out wrong.

**A1. A record of what the business paid, per payable, kept as history.**
- A member records how the business paid a payable outside Vestiarion: the day paid, the amount and currency as paid
  (the bill's own currency by default: `original_currency` when the bill was written in one, else the invoice's), the
  method (bank transfer, card, cash, other), a reference and a note, both optional. Or **Not paid**, with a reason
  (at most 280 characters): the business did not pay it, or will not.
- Any payable in any workspace may carry one. Shadow mode is where it matters, but a live workspace whose business also
  pays some bills from its bank can use it too.
- A change appends a correction that names the record it replaces. Nothing is edited in place: the history stays, and
  the comparison reads the newest record of the chain.
- Cost if wrong: one more table; a business that wanted to edit in place sees its corrections in the audit log.

**A2. One table, `payment_actuals` (migration 0090), append-only for the tenant role.**
- `id, org_id, invoice_id, outcome ('paid' | 'not_paid'), paid_on date, amount numeric(24,6), currency, method,
  reference, note, reason, replaces, source ('form' | 'csv'), recorded_by, recorded_at`.
- A paid record has a day, an amount above zero, a currency (three capitals, or USDC or EURC) and a method, and no
  reason; a not-paid record has a reason and none of the rest. Reference at most 140 characters, note at most 280.
- Composite foreign keys: `(org_id, invoice_id)` to `invoices (org_id, id)`, and `(org_id, invoice_id, replaces)` to
  the table's own `(org_id, invoice_id, id)`, so a correction is in the same workspace and about the same bill.
- One first record per bill (unique `(org_id, invoice_id)` where `replaces` is null) and one correction per record
  (unique `(org_id, replaces)`): the history is one line, and two people correcting the same record at once cannot fork
  it. The second is refused and asked to look again.
- Row-level security and grants as `decision_verdicts` (0084): `select, insert` for `vestiarion_tenant`, the permissive
  and restrictive `tenant_isolation` policies. Re-runnable: `if not exists` everywhere, policies dropped and created.
- Cost if wrong: a later migration adds a column; the history stays.

**A3. Each record is a signed ledger entry.**
- `actual_payment_recorded` for a first record, `actual_payment_corrected` for a correction; actor `human`, domain `ap`.
- Detail: `{ by, actualId, subject: "invoice", subjectId, outcome, paidOn, amount, currency, method, reference, note,
  reason }`, plus `replaces` on a correction and `via: "csv"` for a row from a CSV.
- The payable is its `subjectId`, never `invoiceId`, as a verdict's is: the AP / AR card keeps showing the agent's
  decision, not this record.
- The row is written first, then the entry, best effort, as every recorded change is; the signing key is checked before
  the row is written (`assertLedgerCanSign`), so an unreadable key refuses the record rather than leave it unsigned.
- They reach webhook endpoints as `ledger.appended` and list in `GET /api/v1/ledger`, like every entry: the changelog
  says so. Nothing else in `/api/v1` changes.
- Cost if wrong: an entry whose write failed after its row leaves a record with no entry; the comparison then shows who
  recorded it and when, without the audit link.

**A4. Who records: `records.write` (owners and admins).**
- Recording what was paid is entering a record, as adding an invoice is. Approvers decide payments and do not create
  records (maker and checker, spec section 7), so they cannot type in a payment they then compare against.
- Two commands, `payable.record_actual` and `payable.import_actuals`, both `records.write`, console only. Every
  command's gate runs first (`tests/commands-gates.test.ts`); the server actions call `authorize(slug, "records.write")`
  first and run inside the organization scope, so another workspace's bill is not found.
- Cost if wrong: one line in the permission map to widen it.

**A5. Where it is recorded: the report's comparison.**
- The report's new section lists each bill with the agent's side and the business's side; an owner or admin records or
  corrects from the bill's row, and imports a CSV from the section.
- Not on the AP / AR cards in this version: they already carry the verdict, the receipt and the details controls.
- Cost if wrong: a control added to the AP / AR card later, calling the same command.

**A6. Bulk: a CSV, previewed before anything is saved.**
- Columns: `invoice` (a Vestiarion invoice id, or the bill's invoice number), `paid_date` (YYYY-MM-DD), `amount`,
  `currency` (blank: the bill's own currency), `reference`, and optionally `method` (blank: other).
- Vestiarion keeps no invoice-number field, so a number matches the one payable whose memo carries it as a whole word,
  ignoring case. No match, or more than one, leaves the row unmatched, with why.
- The section offers a CSV of the bills not recorded yet, with their ids, payees, amounts and due days filled in, to
  fill and import back.
- Preview (no write): each row as new, a correction of the bill's current record, the same as recorded (skipped), or
  unmatched with why. Saving parses and matches again on the server and writes only the matched rows that change
  something, each with its own entry. At most 200 rows and 1 MB.
- Cost if wrong: an unmatched number recorded by hand or by id.

**A7. The comparison, a pure function.**
`compareActuals` (`src/lib/actual-payments-compare.ts`) takes the report's facts and the records, and is tested on
hand-made rows.
- Bills: the report's own (real bills, or the sample data while there is none). A bill shows when the agent decided on
  it or a record exists.
- The agent's side, from the newest decision and the bill's confirmed payment: **paid on Arc** (a confirmed payment;
  simulated in a sandbox, never linked), **would pay** (`ap_pay` that passed every check, held for a verdict or not
  sent), **scheduled** (with its day), **held** (the agent's own hold, flag or question, or a check in code), **waited**
  (no cash, a pause, the spending limit), or **no decision yet**.
- The business's side: the bill's current record, or **Not recorded**. A bill with no record is never inferred from
  its status, a verdict or a payment on Arc.
- An Arc payment is never presented as the business paying: the columns are the agent on Arc, and your business.
- Days: the business's paid day less the agent's day. The agent's day is the earliest day it decided to pay the bill
  (an `ap_pay` that passed every check, or a schedule's day); for a bill a person paid on Arc after a hold, the day it
  was paid there. Positive means the agent was earlier. The total is the median over bills with both days.
- Flags worth a look: **held by the agent, paid by your business**; **paid on Arc or decided to pay, not paid by your
  business**; **amount differs** (the business paid another amount than the Arc payment carried, or than the bill, in
  the same currency, by at least the currency's smallest unit). A wait is not a hold: a bill the agent could not pay for
  want of cash, then paid by the business, is not flagged.
- Early-payment discount, measured only from recorded facts: the agent's is the bill less what its transfer carried, as
  the report measures it; the business's is the bill (in the currency it paid) less what it recorded, when it paid on or
  before the deadline and the difference is no more than the discount on offer. On offer is the bill times the percent,
  labelled estimated.
- Agreement: the agent paid or would pay and the business paid, or the agent held it and the business did not pay.
  Waits and bills with no decision count in neither.
- Totals: bills compared (a decision and a record), bills not recorded yet, agreement, median days, the flags, and
  amounts per currency. Different currencies are never compared or summed; USD and USDC are different codes.
- Cost if wrong: a figure changes meaning; the rows it is drawn from are the same.

**A8. Each figure links to its source (I05).**
- The agent's decision links to its ledger entry in the audit log, its payment to the transaction on the explorer of
  the workspace's network, the verdict to its `decision_verdict` entry, and the business's record to its entry, with
  who recorded it and when. An entry links as `/audit?before=<seq + 1>#seq-<seq>`, the page that starts at it.
- Who recorded it reads as the member's email, as Approvals names approvers; a former member reads as one.
- Cost if wrong: a link that lands a page off; the entry number is shown beside it.

**A9. Sandbox and sample data follow the report.**
The comparison counts the bills the report counts, a sandbox's simulated payments marked **Simulated** with no
transaction, and says so in its own words.

**A10. Before migration 0090 runs.**
The report reads the table and, when PostgREST or Postgres says it is not there (`PGRST205`, `42P01`), shows the section
with "Recording what your business paid is not set up on this deployment yet." and no controls; the command refuses with
`not_ready` and the same words. Nothing else on the page changes, so the report never fails for it.

**A11. The traction digest.**
`npm run traction-digest` adds one line when any record exists: the bills compared, how often the agent and the business
agreed, and how many are not recorded yet. It reads nothing when the table is not there.

## Not now

- Recording from the AP / AR card, the API, Slack or Telegram.
- Reading a bank statement file in a bank's own format.
- Matching a CSV row by amount and payee when it names no invoice.
- A public, shareable copy of the comparison.

## Testing

- `tests/actual-payments-compare.test.ts`: earlier and later, not recorded, held but paid, paid on Arc but not paid,
  a partial amount, a correction replacing the earlier record, different currencies never summed, discounts measured
  and estimated, sample and sandbox scope.
- `tests/actual-payments-csv.test.ts`: parsing, matching by id and by invoice number, ambiguous and unmatched rows,
  corrections and unchanged rows.
- `tests/actual-payments.test.ts`: the domain function over the fake client: validation, a correction of a record that is
  not current, the race on the unique index, the entry, the table not there yet.
- `tests/commands-actuals.test.ts`: the permission (owner and admin yes, approver and viewer no) and the surface.
- `tests/actual-payments-migration.test.ts`: 0090 on PGlite: checks, the one-line history, the composite keys, tenant
  isolation, append-only.
- `tests/actuals-comparison-view.test.tsx`: the section renders its rows, flags, links and the not-set-up message.
