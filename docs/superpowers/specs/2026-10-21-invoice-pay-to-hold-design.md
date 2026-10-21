# Hold a payment when the invoice asks for a different address

Date: 2026-10-21. Status: accepted.

## Why

A changed bank or wallet detail printed on an invoice is how payment-redirection fraud usually arrives: the vendor's
real invoice, or a forged one, now says "please pay to this new address". Vestiarion already reads the address an
invoice asks to be paid to (`payToAddress`, invoice from a document D1-D9). When it differs from the address on file,
the draft shows a warning: "The agent pays the address on file; confirm a change with the vendor before making it".

That warning lives only on the draft. Once the invoice is added, nothing remembers what the document asked for. The
agent then pays the address on file, which is right, but nobody is made to look at the mismatch. If the vendor really
did change wallets, the payment goes to the old one. If the invoice was forged, the attempt leaves no trace in the
decision.

Insurers ask exactly this: does a changed payment detail on an invoice stop the payment until someone checks it with
the vendor? So the mismatch should hold the payment, with the reason, until a person decides.

## What

**IP1. The invoice remembers what its document asked.**
- When an invoice is added from a document, the address the document asks payment to is kept on the invoice:
  `invoices.document_pay_to` (migration 0136). The chain the document names is not kept: an EVM address is the same on
  every chain, and the counterparty's chain on file decides where it is paid.
- Only an address that is in the document's text is kept, as the reader already checks. A person never types it: it is
  the document's, not anyone's instruction.
- Every path that adds an invoice from a document keeps it:
  - **From a document**, on the invoice form;
  - an invoice that arrived by email;
  - Telegram and Slack;
  - a draft the Chrome extension captured, or a payee sent through its link.
- The invoice's `create_invoice` ledger entry records it in its `document` detail.
- Before 0136 is applied, an invoice is added without it, as today, and nothing is held for it.

**IP2. The agent holds a payment whose invoice asked for another address.**
- A new guardrail, `invoice.pay_to_differs`, holds the payment, never refuses it, when:
  - the invoice's document asked to be paid to an address;
  - and that address is not the counterparty's address on file, case ignored.
- It comes after the address checks the agent already makes (no address, an unconfirmed change, the payee lock's wait)
  and before the three-way match. A missing or unconfirmed address is the stronger reason.
- The reason says both addresses: "The invoice asks to be paid to 0x…, not the address on file for Northwind (0x…).
  Held for a person: confirm with the vendor, by a contact you had before, which one is theirs."
- The agent pays only the address on file, as before. The invoice's address is never paid unless a person changes the
  counterparty's address to it, which goes through the address checks and, where it is on, the payee lock.

**IP3. What clears it.**
- **Approve and pay** in Approvals pays the address on file. The card shows the address the invoice asked for beside
  the one it pays, so the person approving sees the mismatch.
- A person changes the counterparty's address to the invoice's and confirms it. The next decision finds them equal and
  the hold no longer applies; the follow-up stage decides it again, as it does for any confirmed address.
- Rejecting the payable ends it.

**IP4. Where it shows.**
- The decision card's rule line and **What to do next** name it.
- The evidence chain says the invoice asked for another address and how it was settled.
- The policy replay counts it as a code rule.
- The docs (Your first payment, "Read an invoice from a document") say so.

## Not in this change

- Bank details on an invoice (IBAN, account numbers): bank payouts already wait for a person every time.
- Reading an address from an image of an invoice beyond what the reader already reads.
- An address in an email's body that is not the invoice document: the email reader already reads the body as the
  document when there is no attachment.

## Tests

- The guardrail: held when the addresses differ; nothing when they match, case ignored, or the document named none;
  the address checks first.
- Each path that adds an invoice from a document keeps the address; one typed by hand keeps none.
- Before 0136: an insert without the column, nothing held.
- Approvals' card shows both addresses; the follow-up decides again after the address is changed and confirmed.
- The ledger entry's `document` detail; the evidence chain, the decision card and next step.
