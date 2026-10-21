# The payee lock's evidence pack: the data

Date: 2026-10-21. Status: accepted. Part 1 of 2: the data and its signed JSON file. Part 2 adds the page, CSV and PDF,
and the answers to each insurer question.

## Why

Insurers' social-engineering questionnaires (Marsh, The Hartford, SPG; see `2026-10-20-payee-lock-design.md`) ask a
business to show three controls over a changed payout address:
- a call-back to a contact held before the request;
- confirmation by someone other than the requester;
- a record of the check.

Vestiarion signs every one of those facts into its ledger, but they are spread across entries:
- the change;
- the confirmation and its record;
- the holds;
- the payment.

The evidence pack gathers them per address change into one file that a broker or an auditor can read and check
offline.

## What

**EP1. The file.** `GET /api/evidence/payee-lock?org=<slug>`, with optional `from` and `to` (UTC days, `YYYY-MM-DD`).
- It answers any member, as the audit export and the payment evidence do: every member already sees Counterparties and
  the ledger.
- A cross-site request is refused before anything is read.
- Someone signed out gets 401.
- A non-member gets the same 404 as a workspace that does not exist.
- A malformed day gets 400.
- It writes no ledger entry.

The file is `vestiarion-payee-lock-evidence-<slug>-<from>-<to>.json`, format `vestiarion-payee-lock-evidence/1`.

**EP2. One row per address change.** Each `counterparty_address_changed` entry in the period that sets an address (not
a clear) becomes a row:
- **The counterparty:** its id and name.
- **The change:** when, the address from and to, the chain, and who entered it:
  - a member, by email, or "a former member" with the id's first 8 characters when no longer in the workspace;
  - the payee through a payee link (with the link id);
  - GitHub (with the login);
  - the API.
- **The confirmation:** the first `counterparty_address_confirmed` for that counterparty after the change and before
  its next change. Its fields:
  - when, and who;
  - the record: method, contact used, contact on file before the change, note;
  - whether a second person confirmed it: not `soloConfirmation`, not `byGiver`, not `giverUnknown`;
  - the lock's wait, and the time from which the address could be paid;
  - the lookalike warnings.

  The confirmation is `null` while the change is unconfirmed.
- **The holds:** each agent or person decision entry for that counterparty between the change and its first payment
  (or its next change) that held a payment for the address: `guardrailRule`, or an `ap_reconcile`'s
  `notResubmittedBecause`, set to one of:
  - `counterparty.address_unconfirmed`;
  - `counterparty.cooling_off`;
  - `counterparty.new_payee`.
- **The first payment:** the first entry for that counterparty after the change, and before its next change, whose
  execution carries a transaction and a status of `paid` or `matched`. Its fields:
  - when, the amount and currency, and the transaction with its explorer link;
  - whether the agent decided it, or a person approved it (`approval_paid`, `decision_verdict`).
- **The checks**, each true, false or null when it does not apply:
  - `recordKept`;
  - `contactOnFileBefore`;
  - `secondPerson`;
  - `paidAfterConfirmation`;
  - `paidAfterWait`, null when there was no wait.

**EP3. The lock.** The lock as it is now, and each `payee_lock_changed` in the period: when, who, from and to.

**EP4. A summary.** Counts:
- changes, confirmed, confirmed with a record, confirmed by a second person;
- held while unconfirmed, held for the wait;
- paid, and paid only after confirmation.

**EP5. Checkable offline.**
- Every row names the ledger entries it rests on by `seq`.
- The file carries each of those entries in full, as the payment evidence does (`vestiarion-evidence/1`):
  - `body_hash`, `signature`, `prev_hash`, `hash`, `signing_key_id`;
  - the server's own check of the entry.
- It also carries the workspace's public keys and how to check an entry alone (`CHECK_AN_ENTRY`).
- A reader can check every claim against the signatures without trusting Vestiarion.

**EP6. Pure and read-only.**
- `payeeLockEvidence` (`src/lib/payee-lock-evidence.ts`) builds the document from entries, members, the lock and the
  network.
- `readPayeeLockEvidence` reads them in the workspace's scope: the entries by action within the period, plus the
  payments and holds of the counterparties those changes name.

## Not in this part

- The page that shows the pack, its CSV and PDF, and the questionnaire mapping (part 2).
- An `/api/v1` endpoint: the entries are already in `GET /api/v1/ledger`.
- Bank payouts, which the lock does not cover.

## Tests

`tests/payee-lock-evidence.test.ts` covers:
- a change confirmed by a second person with a record, held for the wait, then paid;
- a solo confirmation, then the new-payee hold and an approver's payment;
- an unconfirmed change;
- a change replaced by another before it was confirmed;
- a payee-link and a GitHub change;
- a former member;
- the period;
- the lock's history;
- the summary;
- the entries carried in full, each once.

`tests/payee-lock-evidence-route.test.ts` covers the gates, 400, the file's name and headers, and that nothing is
written.
