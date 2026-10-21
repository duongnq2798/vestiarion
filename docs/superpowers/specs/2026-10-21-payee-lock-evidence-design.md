# The payee lock's evidence pack

Date: 2026-10-21. Status: accepted. Part 1 (EP1-EP6): the data and its signed JSON file. Part 2 (EP7-EP10): the page,
the answers to each insurer question, the CSV and the PDF.

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
- A member gets six downloads a minute; a seventh gets 429.
- It writes no ledger entry.

The file is `vestiarion-payee-lock-evidence-<slug>-<from>-<to>.json`, format `vestiarion-payee-lock-evidence/1`.

**EP2. One row per address change.** Each `counterparty_address_changed` entry in the period that sets an address (not
a clear) becomes a row. A mirror address Vestiarion made in shadow mode (`via: "mirror"`) needs no confirmation, so
it is left out. Each row has:
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
  - whether a second person confirmed it, true only when that is known:
    - with the lock on, the confirmation checked who gave the address, so its flags answer: `soloConfirmation` or
      `byGiver` means false, `giverUnknown` means unknown;
    - with the lock off, only a different member from the one who entered the address proves it;
    - the same member is always false;
    - a payee link or GitHub giver with the lock off is unknown;
  - the lock's wait as recorded with the confirmation, and the time from which the address could be paid;
  - the lookalike warnings.

  The confirmation is `null` while the change is unconfirmed.
- **The holds:** each agent or person decision entry for that counterparty between the change and its first payment
  (or its next change) that held a payment for the address: `guardrailRule`, or an `ap_reconcile`'s
  `notResubmittedBecause`, set to one of:
  - `counterparty.address_unconfirmed`;
  - `counterparty.cooling_off`;
  - `counterparty.new_payee`.
- **The first payment:** the first entry for that counterparty after the change, and before its next change, that
  carries a transaction with a status of `paid` or `matched`, or `verified` for a milestone in flight. Two kinds are
  left out:
  - a bank payout, which the lock does not cover;
  - a transaction the counterparty's earlier entries already named. That transfer went to the earlier address, even
    when it is reconciled or approved after the change.

  Its fields:
  - when, the amount and currency, and the transaction with its explorer link;
  - whether the agent decided it, or a person approved it (`approval_paid`, `milestone_approval_paid`).
- **The checks**, each true, false or null when it does not apply:
  - `recordKept`;
  - `contactOnFileBefore`;
  - `secondPerson`;
  - `paidAfterConfirmation`;
  - `paidAfterWait`, measured against the wait recorded with the confirmation, and null when there was none.

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
- `readPayeeLockEvidence` reads in the workspace's scope:
  - the entries by action within the period;
  - then every entry of the counterparties those changes name, a hundred ids at a time and a page at a time.

  It checks only the entries the pack cites.

## Part 2: the page, the answers, the CSV and the PDF

A broker or an underwriter does not read JSON. The owner needs the pack as a page to look over, the answers to the
questions the insurer's form asks, and a PDF or a spreadsheet to send.

**EP7. The page.** `/o/<slug>/evidence/payee-lock`, for any member, as the file is.
- It takes `from` and `to` as the file does, with links for the last 30 days, this year and all time, and two date
  fields. A period that cannot be read shows all time and says so.
- It shows:
  - the lock as it is now;
  - the counts: changes, confirmed with a record, by a second person, changes with a payment held, paid only after
    confirming;
  - the answers (EP8);
  - every change: when and by whom, from and to, the confirmation and its record, whether a second person gave it, the
    wait, any lookalike warning, the holds, the first payment with its transaction, and the signed entries it rests on;
  - the lock's changes in the period;
  - how many of the cited entries verify against the workspace's keys.
- It reads the pack with `readPayeeLockEvidence`, the same as the file, and writes nothing.
- Settings' payee lock panel offers **Open the evidence pack** beside the download.

**EP8. What insurers ask** (`payeeLockQuestions`, `src/lib/payee-lock-evidence-report.ts`). Insurers'
questionnaires on payment-change fraud ask about the same controls; each words its own. The page asks seven, in its own
words, and answers each from the period's rows:

| Control | Counts |
|---|---|
| A call or message to a contact held before the change | confirmed changes with `contactOnFileBefore` |
| Confirmation by someone other than whoever entered it | confirmed changes with `secondPerson`, those not known said apart |
| A record of each check | confirmations with `recordKept` |
| A hold until the change is confirmed | first payments with `paidAfterConfirmation`, and the holds |
| A wait before the first payment | the lock's wait now, and payments with `paidAfterWait` |
| Lookalike details | changes whose confirmation warned of a lookalike |
| Records someone outside can check | cited entries that verify |

- **Yes** when every case counted passes, **Partly** when some do, **No** when none, **Nothing to show yet** when the
  period has no case. A period with no change answers nothing as yes.
- The wait is **No** when the lock sets none now. Lookalike warnings are always on, so that answer is **Yes**.
- Each answer also says how Vestiarion makes it so, as the workspace is set up now, lock on or off.
- The page names no insurer and quotes no form, so it implies no one's endorsement.

**EP9. The CSV.** `GET /api/evidence/payee-lock?…&format=csv`, with the same gate, period and limit as the file.
- One row per address change, the columns `PAYEE_LOCK_CSV_FIELDS` names:
  - the counterparty, the change, who entered and who confirmed it, the check, its contact, the checks as yes or no;
  - the wait, the lookalike warnings, the holds by rule and count, the first payment;
  - each fact's entry numbers.
- Each cell is guarded as the audit export's are (`csvCell`), so a value that starts like a formula never runs in a
  spreadsheet. A byte-order mark comes first, so Excel reads UTF-8.
- The signatures stay in the JSON file, which the entry numbers point into.
- Any other `format` is 400.

**EP10. The PDF.** **Print or save as PDF** opens the browser's print dialog, which saves a PDF.
- No PDF library is added: the browser already lays the page out and makes the PDF, links included.
- Printed, a workspace page drops its sidebar, header, banners and footer (`print:` classes in the shell), and this
  page drops its period controls and buttons.
- A line only the print shows names the workspace, its network, the period and when the pack was read. Each change and
  each answer keeps to one page where it fits.

## Not in this change

- An `/api/v1` endpoint: the entries are already in `GET /api/v1/ledger`.
- Bank payouts, which the lock does not cover.
- A PDF made on the server: the print dialog makes it.

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
- the entries carried in full, each once;
- a shadow-mode mirror left out;
- the second person, true only when known;
- a hold on a payment not sent again;
- a milestone paid by a person;
- a transfer to the earlier address, a bank payout, and a payment after the next change left out;
- a payment before the recorded wait.

`tests/payee-lock-evidence-route.test.ts` covers:
- the gates, 400 and 429;
- the file's name and headers;
- the CSV's name, headers and rows, and another format refused;
- the ids asked a hundred at a time;
- that nothing is written.

`tests/payee-lock-evidence-report.test.tsx` covers:
- who did a step, in words;
- the seven answers, counted, with the lock on and off, for an empty period, and partly or no;
- the CSV's columns, rows, checks, entries, and formulas and quotes kept safe;
- the page: the lock, the counts, the answers, each change with its entries, the downloads for the period, the print
  line and what the print leaves out, and an empty period.

`tests/payee-lock-panel.test.tsx` covers **Open the evidence pack**.
