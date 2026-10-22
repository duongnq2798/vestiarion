# Receipts v2: what the payee got, the fees, the invoice number, a PDF

Date: 2026-10-22. Status: accepted.

## Why

A shared receipt (docs/superpowers/specs/2026-10-01-payment-receipts-design.md) proves a payment happened: the signed
entry, the entry that recorded it, the transfer on chain. A payee's bookkeeper asks other questions first:
- Which invoice does this pay?
- Was anything taken off on the way, and who paid the fees?
- How much arrived?
- Can I file it as a PDF?

Today the receipt shows one amount and, for a payout to another chain, a fee, without saying who paid it.

## What

**RV1. The invoice number.**
- A payable can carry its own invoice number, as the vendor wrote it: typed into **Invoice number** on the invoice form,
  read from a document (on Bills & receivables, from an emailed invoice, or in Telegram or Slack), or brought in as
  before by an import, a captured draft or an accounting connector.
- Up to 100 characters, optional.
- It is recorded on the invoice's signed `create_invoice` entry as `invoiceNumber`, where imports and captured drafts
  already put it. No column, no migration.

**RV2. What a receipt states.** The signed `receipt_shared` entry's `receipt` gains, beside what it already states:
- `invoiceNumber`: the invoice's number, from its `create_invoice` entry (an accounting connector's under its
  provider's name). Absent when there is none.
- `invoiceAmount`: the invoice's amount, only when it was for more than was paid, which an early-payment discount
  does.
- `networkFeeUsdc`: Arc's network fee for the payment's transaction, only when it was read from the chain. An estimate
  is never stated.
- `feesPaidBy: "sender"`: every fee is paid by the business that paid, on top of the amount. The payee's amount is never
  reduced by one. A CCTP fee is burned at most what Iris quoted, and what Circle did not charge reaches the payee too.

Receipts shared before this change keep what they stated.

**RV3. What the payee received.** The on-chain check already finds the transfer to the payee. It now also states the
amount that transfer moved, so the receipt says what arrived, read from the payee's chain, not stated by the business.
A CCTP payout can read slightly more than the amount, by what Circle did not charge of the fee.

**RV4. The page.** Under the headline, an **Amounts** list:
- the invoice and its number;
- the invoice's amount and the discount, when it was for more;
- each fee, and that the sender paid it on top;
- what left the sender: the amount and every fee;
- what the payee received, read on chain, or the amount as stated while the chain does not answer.

It names no one, as before.

**RV5. A PDF.** **Save as PDF** opens the browser's print dialog, where the receipt saves as a PDF. When printed:
- the site's header and footer, the button and the "Check it yourself" disclosure are left out;
- the signed entry's seq and hash are printed, so a filed copy can be checked against the live link.

## Not in this change

- An invoice number column, or showing the number on Bills & receivables.
- The API taking an invoice number.
- A server-made PDF file.

## Tests

- `tests/receipts-facts.test.ts`:
  - the new facts: invoice number from each source, the invoice amount only above what was paid, the network fee only
    when read from the chain, `feesPaidBy`;
  - an older receipt's facts unchanged.
- `tests/receipts-onchain.test.ts`: the amount received, at 6 and 18 decimals, and a CCTP mint above the amount.
- `tests/receipts-page.test.tsx`: the Amounts list, what the payee received or the stated amount, Save as PDF and
  the print-only lines.
- `tests/receipts-share.test.ts`: the columns read.
- Invoice form, schema, document prefill, chat draft and `create_invoice`: the number, from each way a bill arrives.
