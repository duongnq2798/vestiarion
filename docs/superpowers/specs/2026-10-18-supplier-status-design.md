# Supplier payment status: a supplier's own page of when it is paid

Date: 2026-10-18. Status: built. Branch `feat/supplier-status`. Migration 0131.

## Why

Suppliers ask when they will be paid, and someone at the business looks it up and answers by email. The agent already
knows: a bill is received, held for a person, set for a day, on its way, or paid with a transaction on Arc. Customers
have a statement link (2026-10-13-customer-portal-design.md); suppliers had nothing but one-time links about a single
offer or request.

A supplier's page also shows the business's suppliers what pays them. It is the one place Vestiarion is seen by people
who did not sign up.

## The rules (decided here)

- **V1. The link.** It is `vxv_` and 43 base64url characters, kept only as a SHA-256 and shown once.
  - It expires after 7, 30 or 90 days, and the database refuses more than 91.
  - One link per supplier is live: a new one stops the old one. Stopping sets `revoked_at` once; nothing deletes a link.
  - It is made for a vendor only. A client has a statement link; a contractor, paid by milestones, follows its payments
    through its payee link. Owners and admins make and stop it (`records.write`).
  - Each step is signed `supplier_status_shared` or `supplier_status_unshared` (domain `ap`). A link whose entry fails is
    stopped at once.
- **V2. What the page shows.** The business's name, the supplier's own name, and its own bills (payables), never a
  rejected one. Each bill shows its reference (memo and purchase order), amount, due day, and where it stands in the
  supplier's words:
  - *Received*: pending, not decided yet.
  - *Being reviewed*: held, flagged, waiting for details, or `processing` (a person deciding it in Approvals, before any
    payment exists). The page never says why: not the cash, not a guardrail, not a fraud flag.
  - *To be paid on {day}*: scheduled, with its day.
  - *Payment on its way*: `matched` (for a payable, a payment submitted and not yet confirmed), or a payment started and
    not yet confirmed or failed.
  - *Paid on {day}*, with the transaction on the network's explorer when a confirmed payment has an Arc transaction hash
    (`0x` and 64 hex characters; a simulated payment's reference is never linked). Paid bills stay for 90 days after
    payment, at most 10.
  - In a sandbox the page says its payments are simulated.

  Open bills are totalled per currency ("Still to be paid"), never summed across currencies. Nothing else of the
  workspace: no reasoning, no balance, no other counterparty, no member, no ledger.
- **V3. Read only.** The supplier sends nothing. Opening the page changes nothing and signs nothing.
- **V4. The gate is the link, checked in the database.** The service role's `supplier_status_by_token` answers null for
  a stopped or unknown link, and only the day for an expired one. A live link's bills are read inside the workspace's
  own scope, filtered to the link's counterparty and `direction = 'payable'`.
- **V5. Who pays.** Under the bills, one line says the business pays through Vestiarion, with a link to what Vestiarion
  is. It names no agent decision and no limit.
- **V6. Commands.** `supplier_status.share` and `supplier_status.unshare`, `records.write`, from the console only.
- **V7. Privacy of the link.** The page is `noindex`, with a fixed title ("Your payments"). Analytics sees
  `/supplier/:token`. Its preview card names nothing of the link. A paid bill's link opens the public explorer, where
  anyone can see the paying wallet, so the copy never says the page hides it. A bill's memo is shown, so the Bills tab
  asks for internal notes to stay out of memos.
- **V8. Not in shadow mode.** A workspace in shadow mode pays its bills its own way, and Arc testnet only mirrors
  them. A link is refused there, and an existing link shows no bills while shadow mode is on.

## Data (0131)

- `supplier_status_links (id, org_id, counterparty_id, token_hash unique, created_by, created_at, expires_at,
  revoked_at, revoked_by)`.
  - A composite FK to the counterparty, and a trigger: a vendor only.
  - One live link per supplier (a partial unique index).
  - The tenant role selects; inserts only `org_id`, `counterparty_id`, `token_hash`, `created_by` and `expires_at` (so
    `created_at`, which bounds the expiry, is always now); and updates only `revoked_at` and `revoked_by`. A link is
    revoked once.
- `supplier_status_by_token`: security definer, `search_path = ''`, the service role's alone. The trigger functions are
  no browser role's either.

## Where members make it

Bills & receivables, Bills tab, **Supplier payment status**: pick a vendor and how long the link works,
get the link once to copy, see which suppliers have a live link and until when, and stop one.

## Not in this change

- Emailing the link to the supplier, or adding it to the emails the agent already sends suppliers.
- Showing an open early-payment offer or request for more time on the page; those keep their own one-time links.
- The supplier writing back.
