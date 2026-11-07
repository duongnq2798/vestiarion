# The agent's track record, signed, for an accountant to confirm

Date: 2026-11-07. Status: built. Branch `feat/track-record-export`. No migration: it reads the report's facts and the
ledger, and writes ledger entries only.

## Why

The autonomy ladder (`2026-10-26-autonomy-ladder-design.md`, AL1-AL10) and earned vendors
(`2026-10-28-earned-vendors-design.md`, AL11-AL30) measure, inside the workspace, how often a person agreed with the
agent and which vendors earned an owner's rule. Those figures are the business's own. Someone outside the business, such
as a lender, an auditor or an insurer, should not have to take the owner's word for them.

The track record puts those figures in one file, with every verdict they rest on and every entry behind them carried in
full and signed, so anyone can check them with the workspace's public keys. The workspace's accountant can then
**confirm** it. Confirming is a signed ledger entry, given by the accountant and not by the owner. It names the record's
SHA-256, so a copy of the file can be matched to the confirmation.

## Words used here

- **Track record**: the record built from the facts at one moment.
- **Content**: the parts of the record that a confirmation vouches for (TR3).
- **Confirmation**: a `track_record_confirmed` entry.

Code comments and test names cite the ids, for example "(track record TR3)".

## The rules

- **TR1. What it holds.** From the report's facts (`readReportFacts`), for verdicts on real bills only, sample data left
  out as the ladder leaves it out (AL3):
  - The totals: verdicts given, agreed and disagreed.
  - The ladder by decision and by vendor (AL5), with the same rates, and no rate under five verdicts (AL4).
  - The earned vendors: the rule, the switch that lets the agent pay earned vendors on its own (AL21), and each vendor's
    status, as the report says it (AL18). Left out, and said to be left out, before migration 0146 or when it cannot
    be read.
  - Each verdict, oldest decision first: the decision's entry, its day, its kind, the vendor, the bill's amount, the
    verdict, and the `decision_verdict` entry that records it, where there is one.
  - The confirmations so far (TR6).
  - The ledger's head when it was read, and the workspace's public keys.
- **TR2. The entries it rests on.** Each decision with a verdict, its `decision_verdict` entry, each `vendor_earned` and
  `vendor_earned_lost`, and each confirmation, carried in full as a `SignedEntry` and checked alone against the
  workspace's keys, retired ones included, as the close pack does (CP10). At most 2,000 verdicts. Past that, the record
  holds the newest 2,000 and says it was cut.
- **TR3. Its SHA-256.** `contentSha256` is the SHA-256 of the canonical JSON (`canonicalJson`, keys sorted) of
  `{ format, workspace: slug, network, totals, byKind, byVendor, earned, verdicts }`. It leaves out:
  - the time it was read and the ledger's head, which move with every entry;
  - the entries in full, which carry their own signatures;
  - the confirmations themselves, so confirming does not change what was confirmed.

  The same verdicts and statuses give the same SHA-256, whatever happened in the ledger since.
- **TR4. Who confirms.** Only an accountant of the workspace (`track_record.confirm`, held by `accountant` alone). The
  owner, an admin or an approver gives the verdicts or set the rule, so their word is not an outside check. This is the
  same reason a co-sign is the accountant's alone (CS2).
- **TR5. Confirming.** **Confirm this track record** on the page sends the SHA-256 the page showed. The server reads the
  record again, and then:
  - If the SHA-256 differs, nothing is signed, and the page says "The track record changed since you opened it. Read it
    again before you confirm it."
  - If this person already confirmed this SHA-256, nothing is signed, and the page says when they confirmed it.
  - Otherwise it appends `track_record_confirmed` (actor `human`, domain `system`). The detail is `by` (the user id,
    never an email), `role`, `sha256`, `headSeq`, `headHash`, `verdicts`, `agreed`, `disagreed`, and the ids of the
    vendors shown as earned. The summary is "Track record confirmed by the accountant: N verdicts, M agreed".

  The append is not best effort: if it fails, the page says the record was not confirmed. Nothing else changes. No
  payment, rule, limit or setting reads a confirmation.
- **TR6. Confirmations, as the record lists them.** Newest first: the day, who confirmed (a member's email on the page,
  their user id in the file), the SHA-256, and whether it is the record as it stands (**This record**) or an earlier one
  (**An earlier record**).
- **TR7. The page.** `/o/[slug]/evidence/track-record`, for every member, linked from the report (beside How often you
  agreed) and from the accountant console. It shows the totals, How often you agreed and Earned vendors with the
  report's own components, the verdicts, the record's SHA-256 and head, the confirmations, **Download JSON**, and the
  Confirm button (an accountant) or "An accountant of this workspace confirms it." (everyone else). With no verdict on
  a real bill it says so, and there is nothing to confirm. Each read checks every cited entry's signature, so a person
  reads it ten times at once, then once every 6 seconds, as the close pack page does.
- **TR8. The file.** `GET /api/evidence/track-record?org=<slug>` answers `vestiarion-track-record/1` JSON, with the close
  pack's gate in its order: a cross-site request is refused, then the session, then the membership (a non-member gets
  404). Each download appends `track_record_exported`, best effort, with the SHA-256 of the exact bytes and the
  record's `contentSha256`. Ten downloads per person per workspace in ten minutes are counted from those entries, and six
  a minute are allowed per instance. The file carries how to check an entry alone (`CHECK_AN_ENTRY`) and what a
  confirmation means, in words.
- **TR9. Words.** It is called a track record, never a score or a rating. It says it holds the business's own verdicts
  in shadow mode and that it only measures. It promises nothing about payments to come.

## Data it reads and writes

Reads: the report's facts, the earned vendor rule and record (best effort), and the ledger entries named in TR2. Writes:
`track_record_confirmed` and `track_record_exported` ledger entries only.

## Not in this version

- A confirmation by someone outside the workspace who is not a member.
- An API endpoint (`/api/v1`). The JSON's shape is kept small so one can follow.
- A PDF. The page prints, as the close pack does.
