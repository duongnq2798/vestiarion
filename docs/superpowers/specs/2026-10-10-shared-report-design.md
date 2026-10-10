# A report the business can share

Date: 2026-10-10. Status: decided (autonomy grant 2026-10-05). Roadmap: F30 (value, measured and estimated), SM4 (a
public copy of the report), I28 (what a shared copy hides).

## Why

A business that tried the agent in shadow mode wants to show its partner, its accountant or an outside reviewer what the
agent did with its real bills, without giving them a login. Today the report (`/o/<slug>/report`) is for members only.

The founder deciding whether to pay for Vestiarion also needs value figures that say what was measured and what was
estimated. The report counts bills, decisions and payments, but has no figure for the time the business spent on a bill
before, so nothing on it can say what the agent was worth, and nothing should guess it.

## Decisions

Each decision names what it costs if it turns out wrong.

**S1. The shared page is live: recomputed on every view.**
- It reads the workspace's rows on each view, with the readers the private report uses, and says "Live: recomputed each
  time this page opens" with the time it was computed.
- A snapshot would freeze a copy of the business's data outside the workspace, need a column or an entry to hold it,
  and keep showing it after the business corrected a record. Live keeps one source, and stopping a share stops it at
  once.
- Cost if wrong: a reviewer sees figures move between two views; a snapshot can be added later as a stored entry.

**S2. A link per share; several may be live, each with its own options.**
- A share is a row with its options and the SHA-256 of its secret, as a receipt link is (0046). The link
  (`/report/vxs_<43 base64url characters>`) is shown once, when it is made, with Copy. Only the hash is stored.
- A business may give its accountant names and its outside reviewer labels, so a workspace may hold up to 10 live links
  at once. Each lists who made it, when, and what it shows, with **Stop sharing**.
- Stopping sets `revoked_at` (and who): from that moment the link reads "This report is no longer shared." A stopped
  share is kept, never deleted, so the history stays.
- Cost if wrong: a lost link cannot be shown again; the owner stops it and makes a new one.

**S3. Who may share, stop, and answer.**
- Sharing and stopping take a new permission, `report.share`: owners and admins, as API keys and webhooks are. Putting
  the workspace's figures outside the workspace is a control over all its members' data, not a record.
- The value question is the business's own figure about itself: an owner's (`org.administer`).
- Every member reads the report, the live links and the answer. Three commands, `report.share`, `report.unshare` and
  `report.baseline`, run from the console only; each gates first (`tests/commands-gates.test.ts`).
- Cost if wrong: one line in the permission map to widen or narrow it.

**S4. What a shared report shows, and hides (I28).**
- Supplier names: replaced by stable labels, **Supplier A**, **Supplier B** … (default), or shown. A label follows the
  order in which each supplier's first bill arrived (then its id), so it does not move when a new bill arrives. After Z
  come AA, AB …
- Amounts: shown (default), or hidden everywhere: each bill's amount, the payments, the sums, the discounts (their count
  stays).
- Title: the workspace's name (default, since the owner opts in to sharing), or a neutral "A business on Vestiarion".
  The name is returned by the database only when the share says to show it.
- Never: memos, notes, references, reasons typed by a person, people's names or emails, invoice ids, addresses.
- The agent's reasoning is its own first sentence, at most 200 characters. When names are hidden, every supplier name
  the workspace knows is replaced in it by its label (longest first, ignoring case), and any `0x` address or email
  becomes "[hidden]". When amounts are hidden, every number in it becomes "#".
- Cost if wrong: a reasoning sentence that names something no rule catches; it is still the agent's one sentence, and
  the owner chose to share it.

**S5. How the public page reads (as a receipt does, scoped to one workspace).**
- No session: the link is the credential. A malformed token is never looked up. A well-formed one is hashed and looked
  up through the service role's `report_share_by_token(p_token_hash)` (migration 0095), which returns the live share's
  id, its workspace id, options, the day it was made, the workspace's mode and network, and the name only when shown.
  It answers null for a stopped or unknown link, and for a workspace since deleted (the share goes with it).
- The page then enters that workspace's own scope (`withOrg`, as the API does after a key lookup), so every read runs as
  the tenant role with that workspace's id: `readReportFacts`, `readActualsFacts`, the value answer, the chain fields of
  the decisions shown, and the public halves of the workspace's signing keys. No read names another workspace.
- The workspace id goes no further than the server. Nothing on the page, in its title or in its preview card names the
  workspace unless the share shows the name.
- Cost if wrong: a busy link reads the workspace's rows on every view; a short memo per share can be added.

**S6. What the shared page says.**
- The title, the period (from the workspace's first entry to the time of the view), the network's label, and whether it
  is live (always) with its time.
- The money box, as the report's: sandbox payments are simulated, sample data is counted while there is no real bill,
  shadow mode since a day with the business's currency, Arc testnet's test USDC or Arc mainnet's real USDC.
- The figures: bills handled and decided, median minutes to a first decision, paid on Arc (and on time), stopped before
  paying, verdicts and the agreement rate.
- The value section (S8).
- Agent vs what really happened, as totals only: bills compared, bills not recorded yet, the same outcome, a different
  outcome, and the median days apart. Totals count only bills with a record; a bill nobody recorded is in "not recorded"
  and in no other figure. Until 0090 runs, or with no record, it says so.
- Decisions: each decided bill's newest decision, newest first, at most 50: the day, the supplier (or its label), the
  bill's amount, what the agent did (paid on Arc, would pay, scheduled, held, waited), its one-line reasoning, the
  person's verdict, its entry number with a signature check, and its payment's transaction on the explorer (or
  **Simulated**, with no link).
- Payments: the newest ten, with their transaction on the explorer, as the report's list.
- Cost if wrong: one section more or less on a page that is computed on view.

**S7. The agreement rate, as the console and /open count it.**
- From verdicts only: agreed out of agreed plus disagreed, rounded to a whole percent, by one function
  (`agreementRate`, `src/lib/verdict-rate.ts`) the console's shadow mode panel, the private report and the shared page
  all call.
- The counts are the report's: verdicts on the agent's decisions about the bills the report counts, so never a sample
  payee's while the workspace has a real bill, as `open_verdicts` (0086) counts them.
- Cost if wrong: a workspace whose sample data has verdicts shows a different count on the console than on the report.

**S8. Value: three kinds of figures, never added together (F30).**
On the private report and the shared page, in three labelled groups, with no total across them:
- **Measured**, from the ledger and confirmed transfers: bills handled, bills the agent decided, the median minutes to a
  first decision, bills paid on or before their due day out of those paid, and discounts taken (the bill less what its
  transfer carried).
- **From your answer**, an estimate: time saved = bills the agent decided × the minutes the owner said one bill took
  before Vestiarion, in hours, with the people who touched a bill as context and who answered and when. Only decided
  bills count: a bill the agent has not decided on yet saved nothing. A person's verdict still takes time, and it is
  not taken off: the page says so.
- **Not counted**: savings projected onto bills not paid yet; a bill flagged or refused as a duplicate (`ap_flag_fraud`,
  or the rule `invoice.duplicate_of_settled`) is not money saved, with how many there were; discounts on offer but not
  taken, estimated from the terms.
- Without an answer, the middle group asks the question (owner) or says none was given (everyone else).
- Cost if wrong: the estimate's base changes from decided bills to all bills; both are on the page.

**S9. The answer: append-only, the newest wins.**
- "Before Vestiarion, how many minutes did one bill take you?" (a whole number, 1 to 6,000) and "How many people
  touched it?" (1 to 100). One row per answer in `report_baselines` (0095), with who and when; the tenant role may only
  read and add. A changed answer is a new row; the newest is read.
- Each answer is a signed `report_baseline_answered` entry `{ by, baselineId, minutesPerBill, peoplePerBill }`.
- Cost if wrong: a later migration adds a column; the history stays.

**S10. Each share is a signed entry, and a link with no entry never stays live.**
- `report_shared` `{ by, shareId, options: { names, amounts, title } }` with `names` `labels` or `shown`, `amounts`
  `shown` or `hidden`, `title` `workspace` or `neutral`; `report_unshared` `{ by, shareId }`. Actor `human`, domain
  `system`.
- Sharing checks the signing key first, writes the row, then signs the entry; if the entry fails, the row is revoked at
  once and the person is asked to try again. Stopping revokes first (it must take effect even when the ledger cannot be
  written), then signs its entry best effort, as every recorded change is.
- The entries reach webhook endpoints as `ledger.appended` and list in `GET /api/v1/ledger`; the changelog says so.
- Cost if wrong: a stopped link whose entry failed has its `revoked_at` and who, without the audit entry.

**S11. Signatures on the shared page reuse the landing's check.**
- Each decision shows its entry number and **Check its signature** (`SignatureCheck`, the receipt verifier's half that
  needs no body): the reader's browser checks, with the workspace's public keys, that the workspace's key signed the
  entry and that it follows the entry before it. The body is never published: it holds names and amounts the share may
  hide. No new verifier.
- Cost if wrong: a reader cannot match a shown sentence to the signed body; the business's audit export can.

**S12. Migration 0095, additive and re-runnable.**
- `report_shares`: id, org_id, token_hash (unique, 64 hex), show_names, show_amounts, show_workspace_name, created_by,
  created_at, revoked_at, revoked_by. The tenant role selects and inserts, and may update `revoked_at` and `revoked_by`
  alone (column grants); a trigger refuses to clear or move a `revoked_at` once set. No delete.
- `report_baselines`: id, org_id, minutes_per_bill (1 to 6,000), people_per_bill (1 to 100), answered_by,
  answered_at. Select and insert only.
- Both under the permissive and restrictive `tenant_isolation` policies (0018, 0046, 0090); every key to `auth.users`
  sets null when the person deletes their account (0023's rule).
- `report_share_by_token(text)`: security definer, the service role's alone.
- `if not exists`, policies dropped and created, `create or replace` for the function and trigger, so
  `scripts/migrate.ts` can re-run it.
- Cost if wrong: a later migration alters a column; nothing here rewrites an earlier migration's object.

**S13. Before 0095 runs.**
- Reading either table answers `available: false` on PostgREST's `PGRST205` or Postgres's `42P01`; the public lookup
  treats a missing function (`PGRST202`, `42883`) as no share.
- The report renders as before. **Share this report** opens to "Sharing the report is not set up on this deployment
  yet." and no form; the value section shows its measured figures and "Your answer is not set up on this deployment
  yet." The commands refuse with `not_ready` and the same words.
- Cost if wrong: none beyond the message.

**S14. A dead link names no one.**
- Malformed, unknown, stopped, or its workspace deleted: "This report is no longer shared." A read that fails: "This
  report could not load. Try again in a moment." Neither names the workspace.
- `/report/<token>` is `noindex`, its preview card is the generic one for its kind (`linkSocialMetadata("report")`), and
  analytics sees `/report/:token`.
- Cost if wrong: none; the same holds for receipts.

## Not now

- A period picker on the shared page, or a shared copy of the business's per-bill records (only totals are shared).
- Sharing from Slack, Telegram or the API.
- A snapshot that freezes the figures.
- An expiry date on a link (stop sharing is the control).

## Testing

- `tests/shared-report.test.ts`: the pure builder: names replaced by stable labels (in reasoning too), amounts hidden
  everywhere, memos never, the neutral title, sandbox and sample labels, the agreement rate equal to the console's,
  no actuals giving no comparison figures, a bill not recorded in no figure but "not recorded", the 50 newest decisions.
- `tests/report-value.test.ts`: measured, estimated and not-counted figures in their groups, never summed; no answer,
  no estimate; duplicates counted as not saved.
- `tests/report-shares.test.ts`, `tests/report-baseline.test.ts`: the domain over the fake client: only the hash
  stored, the entry with its options, a failed entry revoking the row, the cap, stopping, not ready.
- `tests/commands-report.test.ts`: owners and admins share and stop, only owners answer; approvers and viewers are
  refused before anything is read; the console only.
- `tests/platform-shared-report.test.ts`: the public read: a malformed token never looked up, an unknown or stopped one
  null, a missing function null, a live one read inside its own workspace's scope.
- `tests/report-share-migration.test.ts`: 0095 on PGlite: checks, column grants, the revoke-once trigger, the function
  for live, stopped and unknown links and the name only when shown, its grants, tenant isolation, append-only answers,
  re-runnable.
- `tests/shared-report-view.test.tsx`: the page's view renders labels, hidden amounts, signature checks and links, and
  no memo.
