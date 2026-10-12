# Book payments made on Arc in the accounting tool, after a person reviews them

Date: 2026-10-12. Status: decided (autonomy grant 2026-10-05). Roadmap: F10, with I10 (review before anything is
written). Builds on the Xero connector (`docs/superpowers/specs/2026-10-12-xero-connector-design.md`, PR #319), whose
payment account (X14, I14) this feature was for. Xero now; the provider seam is ready for QuickBooks Online.

## Why

A bill brought in from Xero and paid on Arc, by the agent or by a person, is still open in Xero. The accountant books
the payment by hand against the bill: the amount, the bank account, the day, and the transaction as its reference.
Vestiarion knows every one of those facts the moment the payment is confirmed. So it drafts the booking, an owner or
admin reviews exactly what will be written, and approving it books it in Xero.

## The rule that decides the design

**A payment is only ever booked into a ledger of the same reality.**

- A payment on **Arc mainnet** moved real money: it may be booked into a real organisation (or a demo one).
- A payment on **Arc testnet**, and **every payment in shadow mode**, may be booked **only into an organisation the
  provider reports as a demo or test company**: Xero's Demo Company (its `Organisation` says `IsDemoCompany: true`, or
  `Class: "DEMO"`); for QuickBooks later, a sandbox company. In shadow mode the business also pays the bill from its
  own bank, and books that payment itself: booking the mirror too would book the bill twice.
- For any other organisation, such a payment is shown as **"Not booked: payments in shadow mode and on Arc testnet are
  never booked into your real books."** and nothing is sent. Never a silent fallback: an organisation whose kind cannot
  be read is not taken for a demo one, and the answer is read again from the provider right before sending.
- The database holds the rule too (W2): a booking can reach `sending`, `sent` or `confirmed` only when it is a payment
  on Arc mainnet outside shadow mode, or the organisation it goes to was read as a demo one.

The same words appear in the spec, the review list on Bills & receivables, the Xero guide and the changelog.

## What Xero offers, as of October 2026

- **Payments** (`PUT /api.xro/2.0/Payments`, body `{ "Payments": [ … ] }`): a payment against an approved bill, with
  `Invoice: { InvoiceID }`, `Account: { AccountID }` (or `Code`), `Date` (`YYYY-MM-DD`), `Amount` in the bill's
  currency (at most what is due), optional `CurrencyRate` (Xero uses its own daily rate when omitted) and `Reference`.
  The answer carries the payment's `PaymentID`, `Status` (`AUTHORISED`), `Amount`, `Reference`, `Invoice`, `Account`
  and `UpdatedDateUTC`. A refusal is a 400 `ValidationException` whose `Elements[].ValidationErrors[].Message` says why
  (an amount above what is due, a lock date, an account that takes no payments). Every write takes an
  `Idempotency-Key` header.
- **Reading payments**: `GET /Payments?where=Reference=="…"` (the `where` filter), `GET /Payments/{PaymentID}`. A
  deleted payment stays readable with `Status: "DELETED"`.
- **Reversing**: `POST /Payments/{PaymentID}` with `{ "Status": "DELETED" }` deletes it; the bill is owed again. A
  payment is never edited: it is deleted and made again.
- **One bill**: `GET /Invoices/{InvoiceID}`: its status, `AmountDue`, currency and update time.
- **The organisation**: `GET /Organisation` (`accounting.settings.read`, already granted): `Name`, `IsDemoCompany`,
  `Class` (`DEMO`, `TRIAL`, `STARTER`, `STANDARD`, `PREMIUM`…), `BaseCurrency`. A `TRIAL` organisation is a real
  business trying Xero with its real books: it is not a demo.
- **Scopes**: apps created after 2 March 2026 get granular scopes. Payments (and batch payments, overpayments,
  prepayments) are `accounting.payments`, with `accounting.payments.read` for reading only. Today's connection asks for
  `offline_access accounting.invoices.read accounting.contacts.read accounting.settings.read`.
- **Limits**: 60 calls a minute and 5,000 a day per organisation (X8).

## Decisions

**W1. The reality rule is one pure function, applied three times.** (`src/lib/connectors/posting.ts`, `bookingReality`)
- Input: the payment's network (`arc-mainnet` or `arc-testnet`; a row with none is Arc testnet, as `networkOf` reads
  it), whether it was made in shadow mode, and what the provider said of the organisation (`demo: true | false`, or
  not read). Output: allowed, or refused with the reason `shadow` or `testnet`.
- Applied when the booking is drafted (a refused one is recorded at once), when the review list shows it, and right
  before sending, with the organisation read from the provider again at that moment.
- Shadow mode: the workspace has a `shadow_modes` row when the booking is drafted, or the bill keeps an original
  currency (`original_*`, only ever set in shadow mode). Shadow mode never runs on Arc mainnet, so in practice the rule
  reads "Arc mainnet books anywhere, Arc testnet only into a demo company"; both facts are kept for the words.
- A simulated payment (a sandbox's, `provider_mode = 'simulate'`) has no transaction: it is never drafted.
- Cost if wrong: a booking refused that could have gone. Never the other way: the database refuses it too.

**W2. The schema: migration 0106 (additive, re-runnable).** `accounting_postings`, a tenant table, as 0101's and 0103's:
row-level security with `tenant_isolation` and the restrictive guard, composite foreign keys to the connection and to
the invoice (`(org_id, connection_id)`, `(org_id, invoice_id)`), cascading with the workspace. The tenant role reads,
inserts and updates it and deletes nothing.
- One row per payable and provider: `unique (org_id, invoice_id, provider)`, so one payment is never booked twice,
  whatever the connection; and one row per provider payment: `unique (org_id, connection_id, external_payment_id)`.
- What will be written, fixed when drafted: the bill (`bill_external_id`), `amount` and `currency` in the bill's
  currency, `paid_on`, `reference` (the Arc transaction hash). Beside it, the payment on Arc it mirrors: `network`,
  `shadow`, `paid_amount`, `paid_token` (USDC or EURC), and `network_fee` (shown apart, never booked: W5).
- State: `draft`, `sending`, `sent`, `confirmed`, `failed`, `refused`; `reason` (a code) and `message` (business
  words) for a refusal or a failure; `organisation_demo` (what the provider last said); and, from the approval, the
  `account` (id, code, name, currency), the `fingerprint` approved, `approved_by`, `approved_at`, `sending_until` (the
  send's lease), `attempts`, `external_payment_id`, `sent_at`, `confirmed_at`.
- A trigger keeps the facts fixed once drafted, lets the state move only along the transitions of W6, and checks the
  reality rule on any row going to `sending`, `sent` or `confirmed`. A check keeps `sent` and `confirmed` with a
  payment id and `confirmed` with its time.
- History is ledger-backed: each transition appends a signed entry (W9); the row holds only where the booking is.
- Added to `TENANT_TABLES`, the PGlite seed, the row-level security and deletion tests.
- Cost if wrong: an additive migration; a later one adds columns or states.

**W3. When a booking is drafted.** A payable is booked when it was added from a Xero bill (an `external_links` row of
type `bill` naming the invoice), is marked `paid`, and its payment intent is `confirmed` with a transaction hash, sent
live (not simulated). Drafting reads only the database, plus one `Organisation` read when there is anything to draft.
- It runs after each sync of a connection: the sweeper every 15 minutes, **Sync now**, and the first sync after
  connecting (`syncInScope`). So a payment confirmed on Arc is drafted within 15 minutes, or at once with **Sync now**.
  The same run reads back bookings sent and not yet confirmed (W7). It never sends: only a person's approval does.
- A drafting run whose organisation read fails drafts only the Arc mainnet payments, and the rest wait for the next
  run, never guessed.
- Drafting is idempotent: the unique key makes a second insert for the same payable a no-op.
- A bill the last sync already saw paid in Xero is drafted as refused (`already_paid`, "Already paid in Xero"); the
  accountant booked it by hand. A bill in another currency than the payment's is refused (`currency`).
- Cost if wrong: a booking waits up to 15 minutes; Sync now brings it at once.

**W4. The amount, the currency, the day, the reference.** (`postingFacts`, pure)
- In the bill's currency. A bill kept in the business's own currency (shadow mode, `original_*` set) is booked at its
  original amount: `original_amount`, or, when an early-payment discount took part off (`paid_amount` below
  `amount`), `original_amount × paid_amount / amount` at the bill's own rate, to the currency's minor units (none for
  the yen). Otherwise the stablecoin is booked as its currency: USDC as USD, EURC as EUR (the preview's rule, X14), at
  `paid_amount` (what left), else `amount`.
- The currency must be the Xero bill's; otherwise the booking is refused (`currency`), never converted again.
- The day is the UTC day the payment was confirmed (`payment_intents.confirmed_at`, else the invoice's `settled_at`).
- The reference is the Arc transaction hash (`payment_intents.tx_hash`, else the invoice's `tx_ref`), in full.
- The account is the one chosen on the Xero card (I14), read when the person approves, never when drafted. With none,
  the booking waits with "Choose where payments are booked", and approving it is refused.
- Cost if wrong: a booking refused on a currency the bill was not in; the person books that one by hand.

**W5. The network fee is not booked in this version.** The fee Circle reported for the transfer (`fee_usd`, and a
cross-chain payout's `bridge_fee`) is shown beside the booking, in USDC, with "Network fee: not booked". It is not
added to the payment (the bill was not owed it) and not booked to the payment account. An accountant who keeps fees
books it as a bank fee. A later version may book it as a spend money transaction to a chosen expense account.
Cost if wrong: a few cents a payment the accountant books by hand.

**W6. Review, then approve (I10).**
- Who: a new permission, `accounting.book` (owner, admin): writing into the business's books is its own act, apart from
  adding records and from deciding payments, so an accountant role, when there is one, gets this alone. The command
  `accounting.book_payments`, from the console only.
- What a person sees, for each draft on Bills & receivables, **To book in Xero**: the change in Xero, field by field,
  as it is now and as it will be: the bill (number and supplier) with its amount due and its status before and after;
  the payment: amount, the account it is booked from, the day and the reference. Beside it, the payment on Arc it
  mirrors, its network, and its network fee, not booked.
- The page sends back, with each ticked booking, a fingerprint of exactly what it showed: the bill, its amount due and
  status as last synced, the amount, the currency, the account, the day and the reference (SHA-256, `postingFingerprint`).
- Approving reads everything again on the server, from the rows: a different fingerprint is **stale**, refused with
  "This booking changed since you saw it. Look at it again, then approve.", and nothing is sent or recorded.
- Approving sends it (W7). Several are approved at once, at most 10 (each takes four calls to Xero, which allows 60 a
  minute): each line keeps its own checks and its own outcome; one refused never stops the next.
- Transitions: `draft` or `failed` → `sending` (the approval's claim, a compare-and-set, so two people approving the
  same booking send it once) → `sent` → `confirmed`; `sending` → `draft` or `failed` (stale at Xero, or no answer) or
  `refused`; `sent` → `failed` or `refused` (W7); `draft` → `refused`. `confirmed` and `refused` are final. A `sending`
  row whose lease (two minutes) ran out may be claimed again: its send's own first step finds what the last one did.
- Cost if wrong: one more press; never a payment booked from a view that was not shown.

**W7. Sending: idempotent, and safe on a timeout.** (`sendPosting`, with the provider and the store injected)
1. Check the ledger can sign (`assertLedgerCanSign`), the connection holds the write scope (W8), an account is
   chosen. Read the organisation again: the reality rule, refused (`reality`) when it fails now.
2. Claim the row (`sending`, with the account, the fingerprint, who and when, the organisation's answer).
3. **Look first**: a payment on this bill with this reference. One there (`AUTHORISED`) is adopted: the booking is
   `sent` with its id, `adopted: true`, and nothing is written. One there but `DELETED` refuses the booking
   (`deleted_in_provider`): someone reversed it in Xero, and Vestiarion never books it again on its own.
4. **The bill now**: gone, voided or deleted refuses (`bill_closed`); paid, or nothing due, refuses (`already_paid`,
   "Already paid in Xero"); another currency refuses (`currency`); an amount due other than the one shown is stale
   (back to the state it was, "Xero now says … is due on this bill. Sync now, then look again.").
5. **Book** it, with `Idempotency-Key` derived from the booking and its fingerprint, so a retry of the same booking is
   the same request to Xero. A refusal (400) fails it (`refused_by_provider`) with Xero's own words; a rate limit fails
   it (`rate_limited`), retryable.
6. **On a timeout or a 5xx after sending**, it reads back before anything else: a payment with this reference on this
   bill is adopted (`sent`); none fails it (`no_answer`, "Xero did not answer, and no payment with this reference is
   there. Approve it again to try once more."): the next approval looks first (step 3), so it is never booked twice.
7. **Read it back once**: `GET /Payments/{PaymentID}`; the same bill, amount, reference and account confirms it
   (`confirmed`); a deleted one refuses it; a different one fails it (`mismatch`); no answer leaves it `sent`, and the
   next sync's run reads it back.
- A 401 or 403 fails it (`reconnect`): "Xero needs you to reconnect."
- Cost if wrong: a booking left `sent` until the next run confirms it.

**W8. The write scope.** `accounting.payments`: asked for, beside the read scopes, by every new connection
(`XERO_SCOPES`). A connection made before has the read scopes only (`accounting_connections.scopes`): the Xero card and
the review list say **Allow Vestiarion to book payments**, which goes through the same connect page again; the same
organisation reconnects its own row (X4), keeping its bills, links, cursors and payment account, and saves the new
scopes. Read scopes stay as they are. The consent statement says what is written now, as a new version
(`xero-2026-10-12.2`); a connection keeps the version it agreed to until it reconnects. Cost if wrong: Xero refuses the
booking (401 or 403), which says "reconnect", and the scope list changes in one place.

**W9. The ledger.** Domain `ap`, each naming the payable as `invoiceId`, so its trail, its settlement and its evidence
read them:
- `accounting_payment_drafted` (`system`): `{ provider, connectionId, externalOrgId, postingId, invoiceId, billId,
  amount, currency, paidOn, reference, network, shadow, paidAmount, paidToken, networkFee }`.
- `accounting_payment_approved` (`human`): `{ by, provider, postingId, invoiceId, account, fingerprint, amount,
  currency, paidOn, reference }`.
- `accounting_payment_sent` (`system`): `{ provider, postingId, invoiceId, paymentId, adopted }`.
- `accounting_payment_confirmed` (`system`): `{ provider, postingId, invoiceId, paymentId, amount, currency, account,
  paidOn, reference }`: what the provider answered when read back.
- `accounting_payment_failed` (`system`): `{ provider, postingId, invoiceId, reason, message, retryable }`.
- `accounting_payment_refused` (`system`): `{ provider, postingId, invoiceId, reason, message, network, shadow,
  organisationDemo }`, `reason` one of `reality`, `already_paid`, `bill_closed`, `currency`, `deleted_in_provider`.
- They reach webhooks as `ledger.appended`, so the changelog lists them. A stale approval writes none: nothing happened.
- `matchingEntry` (the card's own entry) skips `accounting_` entries, as it skips receipts: they are not decisions.

**W10. Where it shows.**
- Bills & receivables, **To book in Xero** (`AccountingBookings`): the drafts with their diff and **Approve and book**;
  below, those booked, those not booked with why, and those that failed with **Approve again**.
- On the paid bill's card: **Booked in Xero** beside its outcome; in **Where the payment is** (#316) a last row,
  "Booked in Xero", with its PaymentID and "stated by Xero when Vestiarion read it back".
- In **Why it was paid** (#310) a step, **The books**: "Booked in Xero as payment …: stated by Xero when Vestiarion read
  it back", labelled **Verified outside** (Xero answered the read-back; the page does not open Xero again), or what
  else it is: approved and waiting for Xero's answer (**Could not open**), drafted and waiting for review
  (**Missing**, with how to fill it), or not booked by the reality rule (**Checked by code**).
- All three read the same signed entries (`bookingFromEntries`, pure), so they never disagree.

**W11. The provider seam.** (`src/lib/connectors/provider.ts`) `AccountingProvider` gains one optional member,
`booking?: BookingProvider`; a provider without it never books, and its connections show nothing about booking.
`BookingProvider` has six members, each mapped to the core's shapes:
- `writeScopes`: the scopes booking needs beyond reading (Xero: `accounting.payments`).
- `organisation({ accessToken, externalOrgId })` → `{ externalOrgId, name, demo, baseCurrency }`: `demo` true only when
  the provider says so (Xero's Demo Company; QuickBooks' sandbox companies, which its sandbox API base serves).
- `bill({ …, billId })` → `ExternalBill | null` as it is now.
- `findPayment({ …, billId, reference })` → `ExternalPayment | null`, deleted ones included.
- `bookPayment({ …, payment, idempotencyKey })` → `{ ok: true, payment } | { ok: false, message }` for a refusal; a
  timeout, a 5xx, a rate limit or a refused token throws `ProviderError` as every other call does.
- `payment({ …, paymentId })` → `ExternalPayment | null`.
QuickBooks implements these with `BillPayment` (`VendorRef`, `PayType: Check`, `CheckPayment.BankAccountRef`,
`Line[].LinkedTxn` to the bill, `PrivateNote` or `DocNumber` for the reference, a `Query` by it, and `requestid` for
idempotency); its `organisation` says `demo: true` for a company reached through the sandbox API base
(`QUICKBOOKS_ENVIRONMENT=sandbox`), never for production. It adds `com.intuit.quickbooks.accounting`'s write use to
its consent words, sets `BOOKS_PAYMENTS.quickbooks` (`booking.ts`, the preview's words), and adds `booking` to
`quickBooksProvider`; the drafting, the review list (one per tool on Bills & receivables), the command, the runs and
the database are the core's, unchanged.

**W12. What leaves.** To Xero, for a booking a person approved: the bill's id, the account's id, the day, the amount and
the Arc transaction hash. Nothing about the supplier, the agent's reasoning or the workspace. The privacy page and the
terms say Vestiarion writes to Xero only the payments a person approves.

## Not in this version

- Booking the network fee (W5), reversing a booking from Vestiarion (a person deletes it in Xero; Vestiarion does not
  book it again), bookings for bills not brought in from Xero, batch payments, QuickBooks' implementation of the seam,
  and booking without a person's approval.

## Testing

- Pure, against recorded Xero-shaped fixtures (`tests/fixtures/xero/`): the reality rule (demo organisation and real
  one; Arc testnet and Arc mainnet; shadow), the amount and currency mapping (USDC as USD, EURC as EUR, shadow's
  original amount, a discount, the yen), the fingerprint and staleness, the organisation, payment and validation
  mappings.
- The send with a fake provider and a fake store: no account chosen, the write scope missing, already paid in Xero, a
  bill closed, adopting a payment already there, a deleted one, a timeout then a read-back that finds it, one that
  finds nothing, a refusal, a duplicate approval, a read-back that confirms, a stale amount due.
- The command: the permission (`accounting.book`), the console only, at most 10 lines, each line's own outcome.
- The migration on PGlite: tenant isolation, one booking per payable and provider, the facts fixed, the transitions,
  the reality check, cascades, a second run.
- The review list, the card's badge, the settlement row and the evidence step render (`/docs-shots`, headless Edge).
