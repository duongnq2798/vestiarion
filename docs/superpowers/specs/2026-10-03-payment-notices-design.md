# Payment notices: tell the payee when they are paid

Date: 2026-10-03. Status: implemented on `feat/remittance-advice`. Decided under the standing autonomy grant.

## 1. The problem

When Vestiarion pays a vendor or a freelancer, the payee hears nothing. A business sending a payment usually sends
remittance advice: who paid, how much, for what, and the reference to find it. A freelancer paid through **Pay a
freelancer** got an email with the link to add their address and then silence, although the payment reached their
wallet within a minute (the freelancer journey's open item). The email given for the link was used once and dropped.

## 2. Rulings

- **R1 — an address for payment notices, optional.** A counterparty can carry an email address for payment notices
  (`counterparties.notice_email`): entered with the counterparty, saved from **Pay a freelancer**'s email, and set,
  changed or cleared on the counterparty's row by an owner or admin (`counterparty_notice_email_changed`, the
  addresses masked). It is not part of `/api/v1`.
- **R2 — sent when the money arrived.** A notice is sent for a payment whose transfer is confirmed: a confirmed
  payment intent, for a payable or a milestone, whoever approved it, the agent or a person. It names the workspace,
  the amount that left and its token, what it pays for (the invoice's memo and purchase order, or the milestone's
  title), the address, the time, and the transaction on Arc testnet.
- **R3 — only real payments, and only on Arc.** Notices are sent from live workspaces only: a sandbox simulates its
  payments and never emails anyone. This version sends them for payments made on Arc testnet; a payout to another
  chain gets none yet.
- **R4 — once.** Each payment intent is claimed for its notice (`payment_intents.notice_sent_at`, a compare-and-set)
  before the email is sent. A send that fails releases the claim, and the next cycle tries again, for three days
  after the payment.
- **R5 — when.** Every cycle ends with a `notices` stage, which needs no other stage. A person's approval sends its
  notice as soon as it is paid, after the response.
- **R6 — recorded.** Each notice sent is a `payment_notice_sent` entry (actor `system`) naming the payment, the
  counterparty, the address masked (`li***@example.com`), the amount and the transaction.
- **R7 — never about older payments.** The database keeps when the address was set
  (`counterparties.notice_email_set_at`, by trigger), and a notice is sent only for a payment confirmed after it:
  setting an address on a counterparty paid yesterday sends nothing about yesterday.

## 3. Rollout

1. The partner applies migration 0063; merge.
2. In testnet-2, set a payment notice address on a counterparty (an address the partner reads), add a payable within
   its limit: within a minute of the payment, the email arrives with the transaction, and the ledger holds
   `payment_notice_sent`.
