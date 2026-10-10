# Import a bill list

Date: 2026-10-10. Status: decided (autonomy grant 2026-10-05). Roadmap: F02, with I04 (preview), I07 (currency
decimals) and I08 (failed rows out and back in).

## Why

A small business keeps its bills in a spreadsheet: its own column names ("Supplier", "Total", "Payment due"), its own
date format (15/10/2026 in Singapore, 10/15/2026 in the US, 2026/10/15 in Japan), its own number format (1,234.50 or
1.234,50) and its own currency (JPY, KRW, PHP, MYR, SGD). The CSV import before this needed Vestiarion's exact headers,
ISO dates and USDC or EURC amounts, and stopped at the first row it could not read. A business gave up before the
agent ever saw one of its bills.

The import now reads the list the business already has, asks only what it cannot know, shows every row's fate before
anything is written, and adds the rows through the same command as an invoice typed into the form.

## Decisions

**B1. Where it lives.**
- AP / AR, **New invoice**, tab **Import a list**, in place of **Import CSV**. The tab is shown to whoever may add
  invoices (`records.write`), as before.
- Four steps on one panel: **Your list** (a file or pasted rows), **Columns** (the mapping and the questions),
  **Check** (the preview) and **Done** (the result).
- The old component (`InvoiceCsvImport`) and its action (`importInvoicesAction`) are removed; the old fixed template
  is one more list the wizard reads, unchanged (its headers are among the synonyms, its dates are ISO, its amounts plain).
- Cost if wrong: one tab's label and one component; the form, the document reader and recurring bills are untouched.

**B2. Reading the table.** (`src/lib/bill-import/table.ts`, pure, shared by the browser and the server)
- A file (`.csv`, `.tsv`, `.txt`, at most 1 MB) or rows pasted from Excel or Google Sheets, which arrive tab-separated.
- The delimiter is the one of tab, semicolon and comma that splits the first line, outside quotes, into the most
  columns, preferring tab, then semicolon, then comma on a tie: a semicolon file from a European Excel has commas
  inside its amounts.
- Quoted fields with doubled quotes, delimiters and line breaks inside them; a byte-order mark is dropped; a field
  left open is refused for the whole list ("A quoted field is never closed").
- Blank rows are skipped but counted, so each row keeps the number the spreadsheet shows it under: with a header,
  the first bill is row 2.
- At most 200 bills per import, as before. More is refused for the whole list: "Import at most 200 bills at a time.
  Split the list."
- Cost if wrong: a list with a different delimiter reads as one column; the person sees it in **Columns** at once.

**B3. Columns.** (`src/lib/bill-import/columns.ts`)
- The first row is read as column names when any of them is a known name; otherwise the columns are called
  "Column A", "Column B" and the first row is a bill. A checkbox, **The first row holds column names**, turns it.
- Each of Vestiarion's fields is matched from a list of names, compared without case, spaces, dots, dashes,
  underscores and `#`:
  - counterparty: Counterparty, Vendor, Supplier, Payee, Customer, Client, Company, Name, Vendor name, Supplier name,
    Customer name, Bill from, Billed to;
  - amount: Amount, Total, Amount due, Balance, Balance due, Total amount, Grand total, Invoice amount, Bill amount,
    Amount payable, Open amount, Outstanding;
  - due date: Due date, Due, Payment due, Due on, Date due, Pay by, Payment date, Due_date;
  - invoice number: Invoice no, Invoice number, Number, Bill no, Bill number, Reference, Ref, Invoice, Document no;
  - purchase order: PO, PO number, PO no, PO reference, Purchase order, po_reference;
  - currency: Currency, Ccy, Cur;
  - memo: Memo, Description, Details, Notes, Note, Item, Items;
  - goods received: Goods received, Received, Delivered, goods_received;
  - direction: Direction, Type, Kind, AP/AR;
  - early-payment discount: early_pay_discount_pct, Discount %, Discount, Early payment discount;
  - discount deadline: discount_deadline, Discount deadline, Discount until, Discount by.
- A column is given to at most one field, first come in the order above.
- The person sees every field with the column chosen for it and three sample values, and may change each one or set
  it to **Not in the list**. Nothing is checked or written before they press **Check the rows**.
- Counterparty, amount and due date are needed; the button says which is missing.
- Any other column is ignored, so the error column the import adds (B13) never stops a list coming back.
- Cost if wrong: a column matched to the wrong field shows its sample values beside the field's name, and the person
  changes it.

**B4. Bills to pay or invoices to collect.**
- With a direction column, each row says it: payable, AP, bill, pay, to pay, purchase, expense; or receivable, AR,
  collect, to collect, sale, sales, income. Anything else is an error row.
- Without one, the person chooses for the whole list: **Bills to pay** or **Invoices to collect**. Nothing is chosen
  for them, even when the column is called Supplier or Customer.
- Cost if wrong: none chosen means one more click.

**B5. Dates: read, never guessed.** (`src/lib/bill-import/dates.ts`)
- Accepted: ISO (2026-10-15, also with a time), year first (2026/10/15, 2026.10.15, 2026. 10. 15., 2026年10月15日),
  day or month first with a four- or two-digit year (15/10/2026, 10/15/2026, 15-10-26, 15.10.2026), a month in
  words (10 Oct 2026, 10-Oct-2026, Oct 10, 2026, October 10 2026), and Excel serial numbers (46310 is 2026-10-15).
- Day or month first is decided for the whole list from its dates: a first part above 12 anywhere means day first, a
  second part above 12 anywhere means month first. When no date settles it, and at least one could be read both ways
  (03/04/2026, not 03/03/2026), the person is asked: **Day first (15/10/2026)** or **Month first (10/15/2026)**.
  When the list holds both kinds, they are asked too, and the rows that do not fit their answer are error rows.
- A date that is not a real day (31/02/2026) is an error row. The discount deadline is read the same way.
- Cost if wrong: one question for a list whose dates fall on the first twelve days of the month.

**B6. Amounts: exact, in the list's own number format.** (`src/lib/bill-import/amounts.ts`)
- A currency symbol or code before or after the number is taken off (B7). A minus sign or brackets is an error row:
  a credit note is not a bill.
- The decimal mark is decided for the whole list. A cell with both marks says which is the decimal one (1,234.50,
  1.234,50); a mark followed by other than three digits is a decimal mark (12,5); a mark repeated is a thousands mark
  (1.234.567). Spaces, non-breaking spaces and apostrophes always group thousands.
- In a currency without decimals, such as JPY or KRW, a mark followed by three digits groups thousands, so ¥12,000
  says the comma groups.
- When no cell settles it, and one could be read both ways (1,234 or 1.234), the person is asked: **1,234.50** or
  **1.234,50**. When cells disagree, they are asked, and the rows that do not fit are error rows.
- Decimals per currency (I07): USDC and EURC take at most 6; JPY, KRW and the other currencies without minor units
  take none ("JPY amounts are whole numbers: 1,500.5 has decimals."), though trailing zeros (12000.00) read as the
  whole number; every other currency takes at most 2.
- The amount is kept as a decimal string from the cell to the insert. No float is in between for USDC and EURC; a bill
  in another currency becomes USDC through the existing shadow path (B15), whose rounding is to the cent.
- Cost if wrong: a row the person meant differently shows its amount in the preview before anything is written.

**B7. Currency.**
- A currency column, when there is one, says each row's currency: a code (USDC, EURC, USD, JPY, any ISO 4217 code) or
  a symbol. A blank cell takes the list's currency.
- Otherwise the person chooses the list's currency from what the workspace takes: USDC, EURC, and in shadow mode the
  business's own currency. It starts at the business's own currency in shadow mode, else at the one currency the
  amounts' symbols name when they name exactly one, else at USDC.
- A symbol is inferred only when it names one currency: ₩ is KRW, ₱ PHP, RM MYR, S$ SGD, US$ USD, € EUR, £ GBP,
  ₹ INR, ฿ THB, Rp IDR, A$ AUD, C$ CAD. $ and ¥ name several and infer nothing. A symbol that fits the row's currency
  ($ with USDC, € with EURC, ¥ with JPY) is simply taken off; one that contradicts it is an error row.
- What the workspace takes:
  - USDC and EURC everywhere;
  - in shadow mode, also the business's own currency, converted as the form converts it (B15);
  - anything else is an error row. Outside shadow mode on Arc testnet: "Bills in JPY are taken in shadow mode only.
    Turn it on for JPY in Settings, or convert the amount to USDC." On Arc mainnet, or for a currency Settings does
    not offer: "Vestiarion takes bills in USDC or EURC. Convert the amount to USDC." In shadow mode for another
    currency: "This workspace's shadow mode takes bills in SGD. Convert the amount to SGD or USDC."
  - A code that is no currency at all: "XYZ is not a currency code."
- VND is never offered, as Settings never offers it.
- Cost if wrong: a business with bills in two foreign currencies converts one of them first.

**B8. Counterparties.**
- A row's counterparty is the workspace's counterparty of that name, compared without case and surrounding spaces;
  failing that, without punctuation and legal suffixes (Ltd, Pte, Inc, GmbH...), as the document reader compares
  them. Two matches is an error row ("matches more than one counterparty"); none is an error row ("No counterparty
  named “Kanto Paper” in this workspace. Add it in Counterparties, then import this row again.").
- The import never creates a counterparty: a counterparty is screened and its address confirmed by a person.
- A blank name is an error row ("No counterparty name.").
- Cost if wrong: a business with many new suppliers adds them in Counterparties first.

**B9. Invoice numbers.**
- There is no invoice-number column on invoices, and no migration for one. A row's invoice number starts its memo:
  "Invoice INV-1001", or "Invoice INV-1001: Website hosting" with the row's own memo; the whole memo stays within
  280 characters or the row is an error row. The payee's payment notice and the client's reminder already show the
  memo, so the number reaches them.
- It is never put in the purchase-order field: the agent's three-way match reads that field as the purchase order.
- The `create_invoice` entry carries it as `invoiceNumber`.
- Cost if wrong: an invoice number moves from the memo to its own column in a later migration, read back from the
  memo and the ledger.

**B10. Duplicates.**
- A row is a duplicate of an invoice already in the workspace, whatever its status, with the same counterparty, the
  same due day, the same amount, and the same reference:
  - the amount is the bill's own: its `original_amount` and `original_currency` for a bill converted in shadow mode
    (its USDC figure changes with the day's rate), else `amount` and `currency`, compared as exact decimals;
  - the reference is the row's invoice number, found as a whole word in the invoice's memo or equal to its purchase
    order; else the row's purchase order, equal to the invoice's; else none, matching an invoice with no purchase
    order.
- A row is a duplicate of an earlier row of the same list under the same rule ("Same as row 4 of this list.").
- A duplicate is never added. The preview names the invoice it matches, by its id, so importing the same list again
  adds nothing, and the rows already imported keep their ids.
- Cost if wrong: two genuinely separate bills with the same counterparty, day, amount and no reference count as one;
  the second is added with the form.

**B11. Check before anything is written (I04).**
- **Check the rows** sends the list and the answers to the server, which reads it again (the browser's reading is
  never trusted), finds the counterparties and the invoices that could be duplicates, reads the day's rates the rows
  need, and answers each row's fate: **Add**, **Already in Vestiarion** (with what it matches) or **Can't add** (with
  why). Nothing is written.
- The panel shows the three counts, then every row with its counterparty, amount (and its USDC figure for a converted
  bill), due date, reference and fate.
- **Add N bills** imports. **Change columns** goes back with the answers kept.
- Cost if wrong: one more round trip before an import.

**B12. The import goes through `addInvoice`.**
- A new command, `invoice.import` (`records.write`, the console only), in `src/lib/commands/imports.ts`, is gated first
  like every command. It reads the list again exactly as the check did, then adds each **Add** row through the
  `addInvoice` command, one after the other: the same permission check per row, the same insert, the same signed
  `create_invoice` entry, the same cycle within seconds for a payable.
- `addInvoice` and `createInvoice` take two more things: the bill's original figure (shadow mode, as the form passes
  it) and where it was imported from. The entry then carries `via: "import"`, `importFile` (the SHA-256 of the list as
  sent) and `importRow` (its row number), and `invoiceNumber` when the row has one.
- The old `import_invoice` entry is no longer written: an imported invoice is a `create_invoice` like every other, so
  the agent's activity and the decision trail ("A person added it, imported from a list.") treat it the same. Webhook
  consumers see that change, so the changelog says it.
- A row the command refuses at that moment becomes **Can't add** with the command's words; the rows before it stay
  added and the rows after it are still tried. Running the same import twice adds the rows once (B10).
- Cost if wrong: a list of 200 takes a few seconds longer than the old single insert.

**B13. Rows that could not be added go out and come back (I08).**
- The check and the result offer **Download the rows that can't be added**: a CSV of those rows as they were in the
  list, every original column in its order, with a last column, "Why it can't be added".
- The person fixes them in their spreadsheet and imports that file. The extra column matches no field (B3). Rows
  already added are not in it; if the whole list comes back, they are **Already in Vestiarion** with the ids they had.
- Built in the browser from the list it already holds; nothing is stored.
- Cost if wrong: none on the server.

**B14. Limits and safety.**
- At most 1 MB and 200 bills, as before. The server refuses a longer text before reading it.
- The list's text is sent to the server only in the workspace's own requests, and is not stored: the ledger keeps its
  hash and the row numbers.
- Product copy names Arc for both networks; nothing says the business's bank pays an Arc testnet payment.

**B15. A bill in the business's own currency.**
- In shadow mode, a row in the business's own currency is added as the form adds one: its amount read as written, its
  USDC at the day's rate from ExchangeRate-API, and the bill's figure and rate kept on the invoice
  (`original_currency`, `original_amount`, `fx_rate`, `fx_source`, `fx_at`), through `shadowBill`.
- The check reads each needed rate once (the rate module keeps it an hour) and shows the USDC figure. The import reads
  them again; a rate that cannot be read makes those rows **Can't add** with the rate module's words.
- `shadowBill` takes the shadow mode it is told, so 200 rows read the `shadow_modes` row once, not 200 times.

**B16. No migration.**
- Duplicates are found from columns invoices already have, and the invoice number lives in the memo (B9).

## Not now

- Creating counterparties from a list.
- Excel `.xlsx` files: a spreadsheet saved as CSV, or its rows pasted, are read.
- An import through the API or MCP.
- Recurring bills from a list.
- Credit notes and negative amounts.

## Plan of PRs

One PR, `feat/import-wizard`: the pure reading (table, columns, dates, amounts, rows), the command and the server
actions, the panel, the guide "Import a bill list", and the README, ARCHITECTURE, first-payment, shadow-mode, try-it,
self-hosting and changelog updates.
