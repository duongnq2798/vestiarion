# Apply money received to invoices: part payments, one payment for several invoices, fees

Date: 2026-10-12. Status: decided (autonomy grant 2026-10-05). Roadmap: F08, with I09 (search Bills & receivables by
more than a name).

## Why

A client pays three invoices with one transfer, or pays half now, or a few cents are lost on the way. Today an incoming
transfer on Arc settles one receivable only when its amount is that receivable's, exactly (receivables on Arc R1,
`matchTransfer`). Everything else stays unmatched, and a person matches it by hand outside the product. The 2026-10-01
receivables design already promised that a transfer matching nothing is "kept as unmatched and shown for a person to
assign"; nothing showed it.

This design lets a person apply an incoming payment to one or more open receivables, settle a receivable from several
payments, keep what is paid beyond the open amounts as the customer's credit, record a small difference as a fee with a
reason, and undo an application by appending a correction. The agent suggests how to apply each payment, with why; a
person confirms. Today's automatic match of an exact single receivable keeps working as it does.

## Decisions

Each decision names what it costs if it turns out wrong.

**L1. One append-only table, `receivable_allocations` (migration 0103).**
- A row applies part or all of one incoming payment to one receivable (`kind = 'payment'`), records a difference a
  person marked as a fee on one receivable (`kind = 'fee'`), or reverses one earlier row (`kind = 'reversal'`).
- Columns: `id, org_id, kind, invoice_id, transfer_id, amount numeric(20,6) > 0, currency ('USDC' | 'EURC'),
  reverses, reason (1 to 280 characters), basis ('sender' | 'amount' | 'person'), payment_seq, created_by,
  created_at`.
- Shape: a payment row names its transfer, a basis and a `payment_seq`, and reverses nothing; a fee row names no
  transfer and has a reason; a reversal names the row it reverses and has a reason, and carries that row's transfer,
  invoice, amount and currency.
- Composite foreign keys keep every link inside the workspace: `(org_id, invoice_id)` to `invoices`, `(org_id,
  transfer_id)` to `incoming_transfers` (which gains `unique (org_id, id)`), `(org_id, reverses)` to the table itself.
- The tenant role reads and inserts, never updates or deletes (as `payment_actuals`, 0090). Row-level security as 0090
  and 0094: the permissive and restrictive `tenant_isolation` policies.
- Additive and re-runnable: `if not exists` everywhere, constraints dropped and added, functions `create or replace`,
  triggers dropped and created.
- Cost if wrong: a later migration adds a column or a kind; the history stays.

**L2. Only Arc payments are applied. A bank statement's money-in line is not.**
- Receivables are in USDC or EURC (`invoices_currency_check`, 0040). A bank statement's lines are in the bank's
  currency (0094). Applying across currencies is refused (L4), so a bank line could apply to nothing; converting it would
  add across currencies, which this design never does.
- A bank line is therefore never presented as a payment here, and 0094's money-in lines stay unused.
- Cost if wrong: a business paid by bank still matches those receipts by hand; a later source kind (`statement_line_id`
  beside `transfer_id`) adds them, under the same triggers.

**L3. Today's automatic match is untouched; whole matches keep their own form.**
- `matchTransfer` and the claim on `incoming_transfers.invoice_id` stay as they are, with their `ar_received` entry.
  A transfer matched this way is a whole match: all of it applied to that receivable. The read model counts it so, and
  it is not reversed here.
- So the two cannot both apply money: the cycle leaves out of its whole match every transfer with an allocation row and
  every receivable with one, and the database refuses either way (L5).
- The cycle also applies, by itself, a transfer that is exactly what is still owed on a part-paid receivable, by the
  same two rules a whole match trusts (the client's address on file; or the only such receivable, whose client was sent
  its pay link). Open receivables, by their amount, and part-paid ones, by what is still owed, are one pool for both
  rules: an open receivable of the same amount as a part-paid one's rest makes an amount alone ambiguous, and the
  client's own address decides between them. It writes a `payment` row with basis `sender` or `amount` and no person,
  and signs `ar_payment_applied`. This keeps the pay link's promise once the page asks for what is still owed (L11).
- Cost if wrong: a whole match the agent got wrong is still fixed outside the product, as today; an automatic
  application of the rest can be reversed (L8).

**L4. What each receivable and payment holds.**
- A receivable's applied amount is its live payment rows plus its live fee rows (a row is live until a reversal names
  it). Outstanding is its amount less what is applied. It is **paid** when outstanding is 0, **part paid** while some is
  applied and some is owed, **open** while nothing is applied. A receivable `received` or `paid` by any other way owes
  nothing; a `rejected` one is closed.
- A payment's applied amount is its live payment rows; unapplied is its amount less that. A whole match leaves nothing
  unapplied.
- Amounts are worked in millionths (the 6 places `numeric(20,6)` keeps), as whole numbers, so sums never drift.
- Never across currencies: a row's currency is its payment's token and its receivable's currency, or it is refused.
  Totals are kept per currency.
- Cost if wrong: none beyond L1; this is arithmetic over the rows.

**L5. The invariants hold in the database, not only in code.**
- A trigger before each insert, as the inserting role (so row-level security still applies):
  - locks the payment's `incoming_transfers` row, then the receivable's `invoices` row (`for update`), so two writers
    of the same payment or the same receivable go one after the other, in one order everywhere;
  - refuses a receivable that is not a receivable of the workspace, one not open (`pending`, `matched`) for a payment
    or a fee, one a whole match claimed, a payment a whole match claimed, a currency that is not both the payment's and
    the receivable's, and a payment already applied to another customer's receivables;
  - refuses a payment row that would take more than the payment's amount, and any payment or fee row that would apply
    more than the receivable's amount;
  - refuses a fee on a receivable with no live payment, and a reversal that would leave a fee with no payment beside it;
  - checks a reversal mirrors the row it names, and that the row is not itself a reversal; one reversal per row is a
    unique index.
- `payment_seq` numbers the rows of one payment 1, 2, 3, ... (unique per payment). A person's application carries the
  payment's version as they saw it: the next number must be what they expect, or the insert is refused as stale. Two
  people applying the same payment at the same time cannot both succeed: the second waits on the payment's lock, then
  finds the version moved; were the lock ever missed, the unique index refuses the second number.
- A trigger before an update of `incoming_transfers.invoice_id` (a whole match's claim) locks the receivable and
  refuses a transfer with live allocations, or a receivable with live allocations.
- A trigger after each insert settles the receivable when outstanding reaches 0: `received`, `settled_at` the latest
  applied payment's arrival, `tx_ref` its transaction; and reopens a `received` receivable to `pending` when a reversal
  leaves some owed. Same transaction: a receivable never shows paid with money owed, or the reverse.
- Cost if wrong: a refused insert where a looser rule would do; a person reads why and acts.

**L6. Credit: what is paid beyond the open amounts stays on the payment, for that customer.**
- An application never puts more on a receivable than it owes. What is left of a payment is its unapplied amount,
  shown under **Apply payments** as credit for the customer its applications name (or the customer whose address sent
  it), and applicable later to that customer's next receivable. Nothing is dropped.
- One payment applies to one customer's receivables. A group paying for two of its companies is applied by hand, one
  customer per payment.
- Cost if wrong: one line in the trigger to allow several customers; credit is then shown per payment, not per customer.

**L7. A fee is a difference a person marks, with a reason.**
- On a receivable that has a payment applied, a person may record up to its outstanding as a fee, with a reason (1 to
  280 characters). It is a `fee` row: applied to the receivable, not paid by the customer, and named as a fee wherever it
  shows. It settles the receivable when it closes the gap.
- A suggestion may propose it when a payment is short of one receivable by at most 1% and at most 5.00; the person types
  the reason, or applies the payment and leaves the rest owed.
- Cost if wrong: a write-off of a whole unpaid invoice is not a fee here; rejecting the receivable stays the way.

**L8. Nothing is edited: a reversal appends a correction.**
- A person reverses one row, with a reason. The reversal frees the payment's amount and the receivable's outstanding,
  and reopens a receivable it had settled. Reversing a customer's last payment on a receivable also reverses the fees
  recorded beside it, in the same insert, fees first.
- Cost if wrong: a reversal of a reversal is a new application, not an undo; the audit log shows both.

**L9. Suggestions: pure, bounded and deterministic, each with why; a person confirms.**
- For each payment with something unapplied, the rules run in this order, and at most 3 suggestions are kept:
  1. **Reference.** When a payment carries a reference (Arc transfers carry none today), a receivable whose invoice
     number, purchase order or Vestiarion id is that reference.
  2. **The customer it comes from.** Its earlier applications name the customer; else a counterparty whose address on
     file sent it. For that customer: the receivable whose outstanding is exactly the payment; else 2 to 4 of its open
     receivables that add up to it exactly, among its 12 oldest due; else its receivables oldest due first, the last one
     part paid or the rest left as credit; and a receivable the payment is short of by at most 1% and 5.00, as a
     possible fee.
  3. **No customer known.** A receivable whose outstanding is exactly the payment (each one, when several, saying how
     many share the amount); 2 to 4 receivables of one customer that add up to it; one receivable within the fee margin.
- Receivables are taken oldest due first, then oldest added, then by id; customers by name, then id; subsets in that
  order, smallest first. The same rows always give the same suggestions.
- A person confirms one as it is, or applies by hand. Who: L10.
- Cost if wrong: a suggestion a person would not take; nothing is applied without them.

**L10. Who: `records.write` (owners and admins), from the console.**
- Applying a payment and recording a fee are entering records, as adding an invoice is: `receivable.apply_payment`.
  Reversing is `receivable.reverse_allocation`. Both `records.write`, console only; the gate runs first.
- Cost if wrong: one line in the permission map.

**L11. Where it shows.**
- **Bills & receivables, Receivables.** Each receivable's row says what was received and what is still owed; a part-paid
  one's badge says **Part paid**. Its card lists each payment and fee applied, with the transaction, and lets an owner or
  admin reverse one. Its trail (How the agent decided) shows each application.
- **Apply payments.** Above the open receivables: each payment with something unapplied, its credit, the suggestions
  with why and **Apply**, and **Apply by hand**. Money in with no suggestion is folded under it.
- **The pay link** asks for what is still owed, and says what was received.
- **Reminders** stop once a receivable is paid, and ask for what is still owed on a part-paid one, saying what arrived.
- **Treasury**'s cash outlook and its scenarios expect a part-paid receivable for what is still owed: what arrived is in
  the wallet already, and counting the whole would count it twice.
- **Where a payment is (2026-10-11) and receipts** cover payments the workspace makes: payables and milestones. A
  receivable has no settlement track and no receipt, so they are unchanged; a receivable's settlement shows on its card.
- Before migration 0103 runs: Receivables shows today's view, and **Apply payments** says "Applying payments is not set
  up on this deployment yet." Reads answer `available: false` (`PGRST205`, `42P01`); the commands refuse `not_ready`;
  the cycle and the reminders read no allocation and behave as today.
- Cost if wrong: a section a person does not need folds away when empty.

**L12. Each row is a signed ledger entry.**
- `ar_payment_applied` for a payment row, `ar_fee_recorded` for a fee, `ar_allocation_reversed` for a reversal; domain
  `ar`; actor `human` for a person, `agent` for the cycle's automatic application (L3).
- Detail: `{ by, allocationId, invoiceId, counterpartyId, transferId, amount, currency, txHash, from, basis,
  outstandingAfter, unappliedAfter, group }`, `reason` on a fee and a reversal, `reverses` on a reversal, and
  `suggestion: { rule, why }` when a person applied one. `invoiceId` is the receivable, so its trail shows it. `group`
  ties the rows one press wrote.
- The rows are written first, then each entry, best effort, as `payment_actuals` are; the signing key is checked before
  the rows (`assertLedgerCanSign`).
- The entries reach webhooks as `ledger.appended` and `GET /api/v1/ledger`; the changelog says so.
- Cost if wrong: an entry whose write failed leaves a row with no entry; the card still shows it.

**L13. `/api/v1` invoices are unchanged in shape.**
- A part-paid receivable keeps `status: "pending"` (or `"matched"`) and its full `amount`; it becomes `"received"` when
  nothing is owed, with `settledAt` and `txHash` from the payment that completed it. What was applied is in the ledger
  entries. The changelog says so.
- Cost if wrong: an integrator wanting the outstanding amount reads it from the entries; a later field can carry it.

**L14. Search on Bills & receivables (I09).**
- A search box filters payables and receivables by Vestiarion id (or its first characters), invoice number or any word of
  the memo, purchase order, counterparty, amount (as typed, `1250`, `1,250.00`; the invoice's amount or what is still
  owed), and an incoming payment's transaction hash, Circle id or sender, which finds the receivables it was applied to
  and the payment itself under **Apply payments**. It is a `q` in the address, read on the server: it works without
  JavaScript and can be linked.
- Pure (`src/lib/invoice-search.ts`), with tests.
- Cost if wrong: a search that finds too much; the filter shows what it matched.

## Not in this change

- Bank statement money-in lines (L2).
- Reversing a whole match the agent made before this change or by `matchTransfer` (L3).
- An outstanding figure in `/api/v1` (L13).
