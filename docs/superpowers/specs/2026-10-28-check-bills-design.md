# Bill list check: duplicates and deadlines

Date: 2026-10-28. Status: accepted.

## Why

A bill paid twice is the most ordinary loss in accounts payable. It is rarely fraud: a vendor sends an unpaid invoice
again, someone forwards the same PDF twice, or a bill is keyed once from the email and once from the post, its number
written another way. The same bill list also hides money that is easy to keep: an early-payment discount that ends this
week, or a late fee that starts the day after a bill is due.

Vestiarion already checks every new bill for these inside a workspace. A free public page that runs the same checks on
a bill list, with nothing to sign up for and nothing sent anywhere, helps people who do not use Vestiarion yet. The list
they check is the list its bill import reads, so the step after the check is short.

## What

**CB1. The page** (`/check-bills`, `src/app/check-bills/page.tsx`).
- Public and static, at the top level: not under `/tools`, which serves downloads. `requiresSession` lets it through.
- Its title is "Duplicate invoice check for your bill list, free" (the root layout adds the name), with a description,
  a canonical address and social cards. Its heading says what it does in plain words.
- Under the checker: how it works, and what it does not do.
- It is in the sitemap. The import guide links to it.

**CB2. The list** (`BillListChecker`, `src/components/bill-check/BillListChecker.tsx`).
- A CSV, TSV or text file chosen or dropped (at most 5 MB), or rows pasted from Excel or Google Sheets: an export from
  QuickBooks, Xero or Zoho Books, or a sheet.
- It is read with the bill import's own readers: `decodeList` and `readTable` (`src/lib/bill-import/table.ts`).
- At most 5,000 bills are checked (`MAX_CHECK_BILLS`), so the check stays fast in a browser. A longer list is checked
  up to its 5,000th bill, and the page says how many were left out.
- **Try the sample list** loads a made-up list (CB10). **Download the sample** saves it as a CSV.
- Each step replaces the one before it, and the button pressed goes with it, so the focus moves to the new step's place
  in the trail of steps (`StepTrail`): a keyboard carries on from the new step, and a screen reader says which it is.
- While the check runs, **Check N bills** shows it is busy and takes no second press: the check waits for that to be
  drawn, then runs. 5,000 bills of one vendor for one amount take a second or two.

**CB3. Which column is which** (`startingAnswers`, `questionsOf`, `unansweredOf`, `src/lib/bill-check/read.ts`).
- The first row is read as column names when it looks like them (`looksLikeHeader`). Each field is matched by
  `detectMapping`, as in the bill import, and shown with the values it reads (`sampleValues`). The person changes any
  match.
- The fields are the import's (`IMPORT_FIELDS`, named by `FIELD_LABELS`) without "Bill or invoice" and "Goods
  received", which the check does not use. Counterparty, Amount and Due date are needed, as in the import.
- A field's column, and the questions about dates and amounts, are the import's own controls
  (`ColumnField`, `DatesQuestion`, `AmountsQuestion`, `src/components/intake/list-steps.tsx`), so a change to how a list
  is asked about reaches both.
- When the list's dates can be read more than one way, it asks day first or month first (`dateOrderOf`, `readDate`),
  from the due dates, discount deadlines and late fee starts together. When its amounts can, it asks how they are
  written (`decimalMarkOf`).
- The list's currency, for rows that name none, by a currency column or a symbol that means one currency: among USD,
  EUR, GBP, CAD, AUD, NZD, CHF, SGD, JPY, MXN, USDC and EURC, it starts at the first that those rows' symbols fit (USD
  for plain numbers or `$`), and is asked when none fits them all. It labels amounts; it converts nothing.

**CB4. Each bill as read** (`readBills`). A read-only reader: it takes nothing from a workspace and adds nothing.
- The counterparty as written, and its key for grouping (`vendorKeyOf`): `nameKey` (`src/lib/invoice-document/match.ts`),
  so "Bluebell Print Co." and "Bluebell Print Co" are one vendor. `nameKey` keeps a to z and 0 to 9 only, so a name with
  other letters keeps every word, case and marks aside and a Latin legal suffix left out: "東京 Design" and "大阪 Design"
  are two vendors, "東京 Design Ltd." and "東京 Design" one.
- The amount, read in the list's format to an exact decimal (`splitCurrency`, `readAmount`), and its currency: the
  currency column's code or symbol, the amount's own symbol, or the list's currency.
- The due date, the invoice number, the purchase order and the memo.
- An early-payment discount: its percent and its deadline, both needed.
- A late fee: a percent a month (at most 10) or a fixed amount, and its first day. A fee with no first day starts the
  day after the due date, as Vestiarion reads one (late fees LF1).
- What is wrong with each cell, as a sentence. A bill without a readable counterparty, amount or due date is left out
  of the check and listed with why. A discount or late fee that cannot be read is left out, and the bill is checked
  without it.

**CB5. Likely duplicates** (`likelyDuplicates`, `src/lib/bill-check/findings.ts`).
- Within each vendor, each bill is compared with the bills due before it (then by row) that share its amount, its
  purchase order or its invoice number: at most 50 of each (`COMPARED_PER_BUCKET`), the ones due closest to it, so
  5,000 bills of one vendor for one amount take a second or two.
- Each comparison is the agent's own `scoreDuplicate` (`src/lib/agent/duplicates.ts`), with its explanation as written.
  The bill's memo is the one the import would add it with: its invoice number in front (`memoWithInvoiceNumber`, B9), so
  two bills compare as they would once imported. A list does not say which bills are paid, so each bill is given no
  status: the explanation then names none, and confidence stays at most 0.85, the most `scoreDuplicate` gives a bill
  whose money has not left.
- Its recurring-charge rule stands: two bills due 24 to 32 days apart without the same purchase order are not a likely
  duplicate. They are listed in CB6 instead.
- A monthly charge is not its own duplicate either. A bill that follows one of the same amount and description 24 to 32
  days before it, with no purchase order or invoice number in common (`monthApartPair`), is the next month of that
  charge: it is compared by amount only with the bills since that one, not with the months before it, which the
  agent's rule, scoring same amount and same description 59 days apart at 0.75, would take for repeats. Its purchase
  order and invoice number are still compared with every bill. A month sent twice is still found, against its copy.
- The invoice numbers are compared too, as `sameNumber` (`src/lib/vendor-statement/match.ts`) reads them: case, spaces
  and punctuation ignored, so "BP-1042" and "bp 1042" are one number. The same number for the same amount is 0.85; for
  a different amount, 0.55, as a purchase order billed twice is. The sentence names the earlier row, and both numbers
  when they are written differently. A number counts only with a digit other than 0 in it, so a placeholder a sheet
  fills an empty cell with ("N/A", "none", "TBD", "0") is no number. This comparison is the page's own: the agent's
  rule sees an invoice number only as part of the memo, so the page says so.
- Each bill is shown with its strongest match only, so a bill sent three times is two findings, not three.
- Grouped by vendor, strongest first. Each finding shows both rows, the confidence, the explanation, and the amount at
  stake: the later bill's amount, which paying both would pay twice. Each vendor's and the list's amounts at stake are
  summed by currency.

**CB6. Same amount, about a month apart** (`monthApart`).
- Bills of one vendor in one currency for the same amount, each due 24 to 32 days after the one before it in the run
  (`RECURRING_MIN_DAYS`, `RECURRING_MAX_DAYS`), are listed as a run.
- Each bill follows the closest bill of its amount 24 to 32 days before it that no other bill follows yet, one already
  in a run first (at most 50 looked at). So a bill of the same amount due between two months breaks no run, a month
  sent twice leaves the run going on from the month it had reached, and two charges of one price billed on different
  days of the month are two runs.
- Most are a monthly charge; the page says to check each is a new month's bill, not the same bill sent again.
- Two bills with the same purchase order or invoice number are a likely duplicate, not a link in a run.

**CB7. Deadlines in the next 7 days** (`deadlinesOf`). From the person's own today:
- an early-payment discount whose deadline is today or in the 6 days after it, and what it is worth: its percent of
  the amount;
- a late fee whose first day is in the 7 days after today, so its last day without the fee is today or in the 6 days
  after it, and what it costs: its percent of the amount a month, or its fixed amount.
- Nearest first. Only when the list has those columns; otherwise the page says the list has none.
- A deadline of a bill that may repeat another (CB5) says so under it: "This bill may repeat row 2: check it before you
  pay." The page lists the deadline, as the bill's terms give it, but does not urge paying it without a look.

**CB8. The list back, with a flag column** (`checkedCsv`).
- Every row as the list wrote it, its column names first when it has them, and a last column, "Bill check", with what
  the check found on that row: a likely duplicate (both rows), a run of the same amount, a deadline, or why it was not
  checked. Rows past the 5,000th say so.
- A semicolon list keeps its semicolons; any other, pasted or tab-separated, comes back with commas, as
  `<name>-checked.csv` (`savedListName`, as the import's failed rows are named). A byte-order mark goes first so a
  spreadsheet reads its names right, as in the import's failed rows.

**CB9. Nothing leaves the browser.**
- There is no form, so nothing typed can be submitted or land in the address bar. No request carries what is pasted;
  nothing goes in a URL, storage or a cookie. The file is read in the page.
- `tests/check-bills-page.test.tsx` fails if the checker's code, its rules or the page gain a request, a URL read or
  write, storage, a cookie, analytics, a form or a named field.
- The call to action (CB11) is kept in its own file, outside that test, so a later change that records where a
  workspace came from does not touch the checker.

**CB10. The sample list** (`sampleBillList`, `src/lib/bill-check/sample.ts`).
- Made-up vendors and amounts in USD, its dates counted from today so its deadlines always fall in the next 7 days. It
  is named "Sample list (made-up vendors)" wherever it shows.
- It holds a bill sent twice, the same invoice keyed with its number written another way, a monthly charge, a
  discount ending soon, a late fee starting soon and a row whose due date is not a real day.

**CB11. The call to action** (`CheckBillsCta`, `src/components/bill-check/CheckBillsCta.tsx`).
- "Vestiarion runs its duplicate check, purchase-order match, sanctions screening and a payee lock on every new bill,
  and weighs early-payment discounts and late fees, before it pays. Start a shadow workspace and drop this same file
  into its bill import." It names only what the agent does: the invoice-number comparison and the month-apart runs are
  this page's own (CB5, CB6), and the page says so where it describes them.
- **Try it on your bills** (`data-cta="check-bills-start"`) goes where the landing's does (`TRY_HREF`), with the
  shadow-mode line under it, and a note that the import takes up to 200 bills at a time, for vendors already in
  Counterparties.

## Changes to shared code

- `scoreDuplicate` describes a bill with no status (`""`) without one: the sentence leaves out "(status …)". Every
  bill in a workspace has a status, so nothing there changes.
- `RECURRING_MIN_DAYS`, `RECURRING_MAX_DAYS`, `normalisePo` and `normaliseText` are exported, for CB5 and CB6.
- What the bill import and the check share in their steps moves to `src/components/intake/list-steps.tsx`: `StepTrail`
  (its current step now focusable from code), `ColumnField`, `DatesQuestion`, `AmountsQuestion`, `twoWayDate`,
  `twoWayAmount` and `download`. The file name a list is saved back under is `savedListName`
  (`src/lib/bill-import/table.ts`). The import's screens are unchanged.
- `memoWithInvoiceNumber` and the whole-word test it uses move to `src/lib/bill-import/memo.ts`, which the import and the
  check share; the import's rows still export it. The whole-word test now builds its letter classes once: built into a
  pattern on every call they took most of a millisecond each, seconds for 5,000 bills. What it matches is unchanged.

## Not in this change

- Recording that a workspace came from this page: a shared call-to-action component will do it for every free tool.
- Columns the import does not read, such as a bill's own date or its status: two lists of the same bill paid and
  unpaid look alike here.
- Bills of different vendors with the same invoice number: two vendors can number alike.
- Leading zeros and lookalike characters in invoice numbers ("INV-042" and "INV-42").
- A "Free tools" group in the footer.

## Tests

`tests/bill-check-read.test.ts`: the starting answers and mapping, the fields left out, the questions (dates, amounts,
currency), what is still unanswered, each bill as read (currency from a column, a symbol or the list; a discount; a late
fee with and without its first day), the vendor key with letters outside a to z, the reasons a row is not checked, and
the 5,000-bill cap.

`tests/bill-check-findings.test.ts`: a bill sent twice, the same purchase order, an invoice number written another way,
the same number for a different amount, placeholder numbers, the strongest match only, vendors grouped by name and kept
apart by letters outside a to z, different currencies apart, the amount at stake, a monthly charge with one description
and no numbers that is not its own duplicate, and a month of it sent twice that is; a monthly run kept out of the
duplicates, past a bill of the same amount between two months, and two charges of one price as two runs; the deadlines
in and out of the 7 days with what each is worth, and one of a bill that may repeat another; the list with no such
columns; the CSV with its flag column, semicolon and tab-separated; and the sample list.

`tests/duplicates.test.ts`: a bill with no status is described without one; the exported window and purchase order
reading.

`tests/bill-import-rows.test.ts`: an invoice number found in a memo only standing alone, case aside, overlapping places
included.

`tests/check-bills-page.test.tsx`, in a DOM: the sample list read, its columns, the check busy then what it found, with
the summary live; the focus moved to each new step; a deadline that names the row its bill may repeat; the page's
metadata, heading, call to action and that it is public; and nothing in the checker's code, or what it shares with the
import, that could send what is pasted anywhere.

`tests/bill-import-ui.test.tsx` and `tests/docs-guides.test.ts` hold the import's screens, now built from the shared
controls, to what they were.

`tests/docs-content.test.ts` covers the sitemap and the import guide's link.
