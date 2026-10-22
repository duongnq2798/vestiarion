# Checking a vendor's statement against the books

Date: 2026-10-22. Status: accepted.

## Why

At month end a vendor sends a statement of account: every invoice they billed, every payment they received, and what
they say is still owed. Someone then ticks it line by line against their own books. The differences are where money
leaks or relationships sour:
- a bill the vendor sent that never reached the books, which will be paid late;
- a bill entered twice;
- an amount typed wrong;
- a payment made that the vendor has not credited, which they will chase.

Vestiarion already holds the bills, their numbers (`create_invoice`'s `invoiceNumber`), and each payment's transaction
on chain. Reading the statement and matching it is work the agent can do in seconds, and leave a person only the
differences.

## What

**VS1. Where.**
- On **Counterparties**, a vendor's row has **Check their statement**, for whoever may reconcile payables: a new
  permission, `payables.reconcile`, held by owners, admins and accountants. It is the payables twin of
  `receivables.reconcile`.
- A contractor or a client has none: a contractor's work is paid by milestone, and a client's statement is the
  receivables side.

**VS2. Reading it.**
- The person uploads a CSV or pastes the statement's table, as exported from the vendor's portal, accounting tool or a
  spreadsheet.
- It is read as a bank statement is read (docs/superpowers/specs/2026-10-10-bank-statement-design.md B1-B5): delimiter,
  header row, columns, date order and decimal mark decided from the whole file, and asked when two readings remain.
- The columns are the date, the invoice or document number, the description, and the amounts: **charges** and
  **payments** in two columns, or one signed amount. On a vendor's statement a charge (their invoice) is the positive
  one by default, and the person can say otherwise. Then the balance, and the currency when a column gives it, else the
  one the person types (default USD).
- A number column is suggested from headers such as *Invoice no*, *Document*, *Doc no*, *Number*, *Ref*.
- At most 2,000 lines and 2 MB. Nothing of the file is stored: the server reads the same text with the same choices
  again, matches it, and forgets it.

**VS3. Matching** (pure, `src/lib/vendor-statement/match.ts`), against the vendor's bills and the payments made to them:
- **A charge** matches the bill with the same number: spaces, dashes and case are ignored. Failing that, it matches the
  unmatched bill with the same amount whose date (when it was added) is closest, within 45 days. A number match with a
  different amount is **an amount that differs**: theirs and ours.
- **A payment they list** matches a confirmed payment of ours of the same amount, the closest within 10 days.
- Amounts compare in the statement's currency against a bill in that currency: USD and USDC as one, EUR and EURC as
  one, or the bill's own figure in the business's currency (shadow mode's original amount). A bill in another currency
  matches by number only.

**VS4. What it says.**
- **Missing here**: their charges with no bill. Each can be added from the line, the number, amount and memo filled in,
  for whoever may add bills. It goes through every check, as one typed in.
- **Listed twice**: two charge lines with the same number, or two bills here with the same number.
- **Amount differs**: theirs, ours, and the difference.
- **Paid, not on their statement**: our confirmed payments to them between the statement's first and last day, with
  each transaction's link, to send them.
- **A payment we have no record of**: a payment they list that matches none of ours.
- **Not on their statement**: our bills added between the statement's first and last day that it does not list.
- **Their balance and ours**: the last balance on their statement, when a column gives it, beside what our open bills
  to them add up to, in the same currency.
- Everything that matched is counted, not listed one by one.

**VS5. Recorded.** Each check signs `vendor_statement_checked`, in domain `ap`, actor `human`. It carries `by`,
`counterpartyId`, the period, the number of lines, charges and payments, and how many fell in each group of VS4, with
their balance and the currency. It never carries the file or its lines. A check that cannot be signed still answers.

**VS6. Nothing is paid.** A check moves no money and changes no bill. Adding a missing bill is the ordinary add.

## Not in this change

- Reading a PDF statement: paste its table, or export a CSV from the vendor's portal.
- Statements from a client.
- Remembering a vendor's column layout between checks.
- Sending the vendor the list of payments they have not credited (the person copies the links).

## Tests

- `tests/vendor-statement-columns.test.ts`: the number and amount columns suggested from a vendor's headers, charges
  positive by default.
- `tests/vendor-statement-match.test.ts`:
  - by number;
  - by amount and closest date within 45 days;
  - an amount that differs;
  - listed twice;
  - missing here;
  - not on their statement;
  - payments matched within 10 days;
  - paid not on their statement;
  - a payment we have no record of;
  - currencies;
  - the balances.
- `tests/vendor-statement-check.test.ts`: the server reads the vendor's bills, numbers and payments in scope, signs
  `vendor_statement_checked` with counts only, refuses a counterparty that is not a vendor, and answers when signing
  fails.
- `tests/vendor-statement-ui.test.tsx`: the button for the roles that may reconcile, the groups, and Add this bill only
  for those who may add bills.
- Roles: `payables.reconcile` for owner, admin and accountant, in the access tests and the members guide.
