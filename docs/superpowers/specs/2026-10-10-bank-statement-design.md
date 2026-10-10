# What the business paid, from its bank statement

Date: 2026-10-10. Status: decided (autonomy grant 2026-10-05). Roadmap: F09. Builds on
`2026-10-10-actual-payments-design.md` (A1–A11), merged as PR #297.

## Why

A business in shadow mode pays its bills from its bank. The report's comparison stays empty until someone records, bill by
bill, what the business paid, and typing each payment into **Record what you paid** is the chore that keeps it empty.
Every bank exports a statement as a CSV. Reading it, and proposing which line paid which bill, turns an hour of typing
into a minute of ticking.

## Decisions

Each decision names what it costs if it turns out wrong.

**B1. Read in two passes: the columns in the browser, the matches on the server.**
- The person names the account, then uploads a CSV or pastes cells from a spreadsheet. The browser reads the table, finds
  the header row and suggests a column for each role; the person confirms or changes them. Every rule is a pure,
  browser-safe function (`src/lib/bank-statement/`), so the browser shows the lines read, the period and the balance
  check at once, and the server reads the same text with the same choices again before it matches or saves anything.
- What crosses to the server is the text and the person's choices, never the browser's lines: what is saved is what the
  server read.
- At most 2,000 lines and 2 MB.
- Cost if wrong: a slow device reads a large file slowly; the server does the same work twice.

**B2. The table: delimiter, quotes, header row.**
- The delimiter is the one of comma, semicolon, tab and pipe that splits the first 30 records into the same number of
  columns most often (more than one column); a first line `sep=;` names it. Pasted spreadsheet cells are tab-separated.
  The person can change it.
- Quoted fields may hold the delimiter, a doubled quote or a line break; a byte order mark is dropped. Each line keeps the
  line of the file it starts on, as a spreadsheet numbers it.
- The header row is the first of the first 30 whose cells name a date column and an amount (or money out / money in)
  column; banks put the account and the period above it. When none does, a first row with a date in it means the file has
  no header. The person can choose the header row, or **No header row**.
- Cost if wrong: one more choice for the person.

**B3. The columns: header words, confirmed by the person.**
- Roles: booking date (required), value date, description (required), payee, amount as one signed column **or** money out
  and money in as two, reference, currency, running balance. Header words are matched after lower-casing and dropping
  punctuation: e.g. *Date, Booking date, Posting date, Transaction date*; *Value date*; *Description, Narrative, Details,
  Particulars, Remarks*; *Payee, Beneficiary, Counterparty, Name*; *Amount*; *Debit, Withdrawal, Money out, Paid out*;
  *Credit, Deposit, Money in, Paid in*; *Reference, Ref*; *Currency, Ccy*; *Balance, Running balance*. Money out and money
  in win over a lone amount when both are there.
- A signed column says money out as negative by default; the person can say it is positive. A value in parentheses or
  ending in a minus is negative; `DR` and `CR` after a value say out and in. In two columns, a value's own sign is
  ignored: the column says the direction.
- A currency column gives each line its currency; without one, the person types the account's currency (three letters,
  or USDC or EURC, as A2 of the actual-payments design). Currency symbols and codes beside an amount are dropped.
- Cost if wrong: a role mapped wrongly shows up at once, in the lines read and in the balance check (B5).

**B4. Ask, never guess: dates and the decimal mark.**
- Dates: every booking and value date is read in each order (year first, day first, month first; month names in English,
  two-digit years as 20xx, a time after the date dropped). The orders that read every value as a real day are kept. One
  left is used; day first and month first both left (every value like 03/04/2026) is asked, with an example; none left
  names the first value that is not a date. A value with no digit is not a date and is not counted.
- The decimal mark: every amount, money out, money in and balance value is looked at together. A value with both marks,
  a mark repeated, or one mark followed by one or two digits decides it. Two values deciding differently are refused with
  both shown. None deciding and some value like 1,500 or 1.500 (one mark, three digits after it) is asked: "1,500 is one
  thousand five hundred, or one and a half". All whole numbers need no answer.
- Amounts are kept in the currency's minor units, as `billDigits` says: JPY, KRW and the other currencies without minor
  units take whole amounts (a `.00` is accepted, `12.5` is refused); the others take at most two decimals.
- Cost if wrong: one more question on a file of whole thousands.

**B5. The statement, checked against its own balance.**
- The period is the first and last booking day. Lines dated after tomorrow are refused, line by line; footer rows with no
  date are skipped; a row with a date and a balance but no amount is a balance checkpoint, not a line.
- With a running balance, each line is checked in date order (a file listed newest first is read the other way): the
  balance before it plus its amount must equal the balance after it, in minor units, per currency. The check shows the
  opening and closing balance, the movements, and the first line that does not add up, with what the balance should
  have been. When every line adds up only with the signs turned round, it says so: money in and out are mapped the wrong
  way round.
- A mismatch does not block matching: a statement cut from a longer one can start mid-day. It is shown above the matches.
- The account's money is never shown as the agent's: the check is labelled as the statement's balance, and the section
  says the agent never counts or spends it.
- Cost if wrong: a file whose rows within a day run newest first fails the check; the person sees it and can still match.

**B6. Which bills a money-out line may match.**
- Money in is never matched: receivables are not part of this import, and the section says so.
- The bills are the workspace's payables the report counts: the real ones, or the sample data while there is none.
- A bill is a candidate while it has no record, or its newest record differs from what the line would record (a
  different day, amount or currency, or **Not paid**): that match would be a correction (A1).
- Same currency only: the line's currency is the bill's own (`original_currency` when it was written in one, else the
  invoice's). USD never matches USDC.
- Date window: the booking day is no earlier than the day before the bill was added (UTC, a day's grace for a business
  ahead of or behind UTC) and no later than 60 days after its due day (after the day added, when it has none). A monthly
  bill of the same amount would otherwise match last month's payment.
- Amount: equal in minor units is a match. Within 5% is shown as **Amount differs** (a bank fee, an early-payment
  discount) only when the payee's name or an invoice number is in the line, and is never ticked for the person.
- Cost if wrong: a bill paid before it was added, or later than 60 days after it was due, is recorded by hand.

**B7. Why a line matched, and one line for one bill.**
- The line's text is its description, payee and reference. The payee's name is found when all its words are there (legal
  words such as Ltd, Pte, Inc, GmbH left out), or written together; one word of four letters or more is a weaker find.
  An invoice number is a word of the bill's memo with a digit in it, found whole in the line.
- Each suggestion lists why: same amount (or how it differs), the day paid against the due day, the name found, the
  invoice number found, and the record it would correct.
- One to one, in rounds: a line and a bill are paired when each is the other's single best (an exact amount, then the
  most found in the text). Paired bills and lines leave the next round. What is left with more than one best is
  **Choose the bill**: the person picks, nothing is ticked. Two identical lines (same day, amount and text) both stay,
  are marked as looking the same, and compete for the bill like any tie.
- A bill whose newest record already says the line (paid, same day, same amount and currency) marks that line
  **Already recorded**, and is taken by it.
- Cost if wrong: a tie the person settles by hand.

**B8. Nothing is saved until the person ticks it.**
- Unique exact matches start ticked; **Choose the bill** and **Amount differs** start unticked. Saving sends the ticked
  pairs; the server reads the text again, matches again, and saves a pair only when that bill is still one of that line's
  candidates and no line or bill is in two pairs.
- Each pair records the bill's actual through `recordActual`: paid, the booking day, the line's amount (as a positive
  amount) and currency, method `bank_transfer`, the line's reference (at most 140 characters), source `statement`, and a
  correction of the bill's newest record when it has one.
- The ledger entry is the one A3 writes, `actual_payment_recorded` or `actual_payment_corrected`, with `via: "statement"`
  and `statementLine: { id, account, line, bookedOn, valueOn, amount, currency, description, payee, reference, balance }`.
  It reaches webhooks as `ledger.appended`: the changelog says so.
- Who: `payable.import_statement`, `records.write` (owners and admins), console only, as A4.
- Cost if wrong: a line ticked wrongly is corrected from the bill's row like any record.

**B9. Only the lines used are kept, so a re-import skips them.**
- `bank_statement_lines` (migration 0094) keeps a line when it records a payment: the account as named, the booking and
  value days, the signed amount, the currency, the description, payee, reference and balance, the line of the file, who
  imported it and when, and `line_hash`.
- `line_hash` is SHA-256 of the account (lower-cased, spaces collapsed), booking day, amount in minor units, currency,
  description, payee, reference, balance, and the line's place among the lines of the same file that look the same, so two
  identical lines in one file are two lines. Unique per workspace.
- `payment_actuals.statement_line_id` links a record to its line, with a composite key to the line in the same workspace,
  one record per line (a unique index), and a check that a record has a line exactly when its source is `statement` and
  it is a payment. A re-import of the same or an overlapping statement reads the lines by hash: one already used reads
  **Already used**, with the bill. A line kept but not used (its record failed after it was written) is used again by the
  next save.
- The rest of the statement (salaries, transfers, money in) is read and never stored.
- Cost if wrong: a line wrongly matched and then corrected by hand stays used; its bill is recorded by hand. A later list of
  the statements imported would need them imported again.

**B10. Migration 0094, additive and re-runnable.**
- `bank_statement_lines`: a tenant table with row-level security and grants as `payment_actuals` (0090): `select, insert`
  for `vestiarion_tenant` (a line is a fact read from a bank, never changed), the permissive and restrictive
  `tenant_isolation` policies, `imported_by` set to null when the person's account is deleted, and deleted with its
  workspace.
- `payment_actuals`: `source` takes `statement` (its check dropped and added again), `statement_line_id` with its composite
  key and unique index, and the check of B9. `if not exists` and drop-then-add throughout.
- Cost if wrong: a later migration widens a check.

**B11. Before migration 0094 runs.**
The report reads whether the lines table is there. When it is not (`PGRST205`, `42P01`, `42703`), the statement card says
"Importing a bank statement is not set up on this deployment yet." and the rest of the comparison works as before; the
command refuses with `not_ready` and the same words.

**B12. Where: the report's comparison, beside the CSV import.**
A card **Import a bank statement** under **Import what your business paid from a CSV**, for owners and admins. Each record
then reads "Recorded by … from a bank statement".

## Not now

- Matching money in to receivables.
- A bank's own file formats (OFX, CAMT.053, MT940) or a bank connection.
- A direction column (`DR` / `CR` in a column of its own), or several description columns joined.
- A list of the statements imported.
- Matching a line that paid several bills at once, or a bill paid in several lines.

## Testing

- `tests/bank-statement-table.test.ts`: delimiters (comma, semicolon with decimal commas, tab from a paste, `sep=`),
  quotes and line breaks, the header row below a preamble, no header.
- `tests/bank-statement-columns.test.ts`: header words for each role, money out and in over a lone amount.
- `tests/bank-statement-values.test.ts`: date orders decided and asked (03/04), month names, two-digit years; decimal
  marks decided, conflicting and asked (1,500); JPY whole amounts; parentheses, trailing minus, `DR` / `CR`, symbols.
- `tests/bank-statement-lines.test.ts`: signed against money out and in columns; the period; refused and skipped rows;
  the balance check (adds up, the first mismatch, the signs turned round, newest first); identical lines kept with their
  own keys.
- `tests/bank-statement-match.test.ts`: exact against near amounts, never across currencies, the date window, names and
  invoice numbers, one to one in rounds, ties to choose, identical lines, already recorded, already used (an overlapping
  re-import), corrections, money in.
- `tests/bank-statements.test.ts`: the domain over the fake client: preview, keeping a line and reusing an unused one, the
  record with its line and entry detail, the table not there yet.
- `tests/commands-statements.test.ts`: the permission (owner and admin yes, approver and viewer no), the surface, pairs
  checked again on the server.
- `tests/bank-statement-migration.test.ts`: 0094 on PGlite: checks, the unique hash, one record per line, the source check,
  composite keys, tenant isolation, append-only, re-runnable.
- `tests/bank-statement-import-view.test.tsx`: the card reads a pasted statement, asks about dates, and shows the balance
  check.
