# Customer statements: a customer's own page of what it owes

Date: 2026-10-13. Status: built (F11, with I16). Branch `feat/customer-portal`. Migration 0109.

## Why

Customers ask for an invoice again, email proof of payment, or dispute an amount in threads finance cannot find again.
Pay links (#116) pay one invoice; nothing showed a customer everything it owes, or gave it a place to answer.

## The rules (decided here)

- **P1. A claim is a claim.** "I paid" records the customer's word with a day, an optional reference and amount. It never
  settles an invoice, never says "paid" to finance (it reads "Customer says paid"), and never says "paid" to the customer
  until the money arrives and is applied (allocations, #317).
- **P2. The link.** `vxc_` and 43 base64url characters, kept only as a SHA-256, shown once. It expires after 7, 30 or 90
  days (the database refuses more than 91). One live link per customer: a new one stops the old one. Stopping sets
  `revoked_at` once; nothing deletes a link. Made and stopped by owners and admins (`records.write`), signed
  `customer_statement_shared` / `customer_statement_unshared`; a link whose entry fails is stopped at once.
- **P3. The page shows only what the customer knows.** The business's name, the customer's own name, its own receivables
  (never rejected ones): open ones with what is still owed, days overdue and the pay link; paid ones of the last 90 days
  (at most 10); what it said and the business's replies, under the business's name. Totals per currency, never summed.
  No ledger, no other counterparty, no balance, no member's name, email or id. `noindex`; analytics sees
  `/statement/:token`; its own preview card names nothing of the link.
- **P4. What the customer can send.** `paid` (a day not after tomorrow UTC, at most a year back; reference up to 120
  characters; amount), `promise` (today up to 90 days), `dispute` (words required), `pay_link`. A newer claim or promise
  on the same invoice replaces the open one (`superseded`); a second dispute or pay link request adds to the open one.
  A note up to 2,000 characters.
- **P5. The thread.** Under each open request the customer and the business write to each other. A closed request takes
  no message.
- **P6. The gate is the link, checked in the database.** The service role's `customer_portal_submit` and
  `customer_portal_reply` lock the link, refuse it stopped or expired, cap it at 30 requests and messages a day (holds
  across serverless instances), and check that the invoice is an open receivable of the link's customer. A per-instance
  bucket (5, then one every 12 s) slows a burst first. A forwarded link works for whoever holds it, for that customer's
  invoices only; the page says so.
- **P7. Reminders wait.** An open dispute holds an invoice's reminders until a person closes it; an open promise through
  its day. A claim of payment holds nothing.
- **P8. Finance answers on the Receivables tab.** "From customers" lists open requests oldest first, each with the
  invoice, what is still owed, what was said, the thread and the next step: find the payment and apply it (Payment found
  / Not received), wait for a promise's day then follow up, reply then resolve a dispute, make the pay link asked for.
  Waiting for review counts them; a receivable's row says what its customer said.
- **P9. Commands.** `customer_portal.share`, `customer_portal.unshare`, `customer_request.reply`,
  `customer_request.close`: `records.write`, console only.
- **P10. The ledger.** Every step is signed in the workspace's ledger (`ar`): the customer's with `via:
  "customer_portal"` and no `by`, and a SHA-256 of its words (`textSha256`) rather than the words, which stay with the
  request where members read them and can be deleted with the workspace. The invoice's trail shows each.
- **I16. On a phone.** The statement is one column at every width; each form repeats what is owed with its currency
  above its fields, the amount field shows its currency inside it and takes the decimal keyboard; fields are 16 px (no
  zoom on focus) and buttons at least 44 px. The pay page gives the amount its own Copy beside the address's.

## Data (0109)

- `customer_portal_links (id, org_id, counterparty_id, token_hash unique, created_by, created_at, expires_at, revoked_at,
  revoked_by)`; composite FK to the counterparty; trigger: a client only; one live per customer (partial unique index);
  tenant: select, insert, update of `revoked_at`/`revoked_by` only, revoke once.
- `customer_requests (id, org_id, link_id, counterparty_id, invoice_id, kind, paid_on, reference, amount, promised_on,
  status, outcome, created_at, closed_at, closed_by)`; composite FKs to link, counterparty and invoice; a trigger checks
  they agree; tenant: select, update of `status`/`outcome`/`closed_at`/`closed_by` only, close once.
- `customer_request_messages (id, org_id, request_id, author, body, link_id, by, created_at)`; tenant: select, insert of
  `org_id`/`request_id`/`body`/`by` only, so it writes replies and never the customer's words; append-only; none on a
  closed request.
- `customer_portal_by_token`, `customer_portal_submit`, `customer_portal_reply`, `customer_portal_live_link`: security
  definer, `search_path = ''`, the service role's alone.

## Screens

`/docs-shots/portal/<state>` (statement, paid, promise, dispute, claimed, expired) and the Receivables tab of
`/docs-shots/bills/workspace?tab=receivables`, behind `DOCS_SCREENSHOTS=1`, photographed into `customer-portal-shots/`
at 1440, 390 and 360 px (the workspace at 1440 and 390). No page scrolls sideways at any of these widths.

## Not in this change

- Emailing the statement link, or carrying it in the agent's reminders.
- Telling members by email, Slack or Telegram when a customer writes (webhooks carry every entry).
- A customer's identity: whoever holds the link speaks as the customer.
