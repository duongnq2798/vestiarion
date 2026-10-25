# Monthly close pack (2026-10-25)

Status: accepted. D11, part 1 of the close pack. Later D11 items (a Google Sheets export, `GET /api/v1/close-packs/{month}`
in SDK 0.4) build on the shared contract below, in their own PRs, after this one merges.

## Why

At the end of a month the business's accountant closes the books. For every payment that left the wallet they need the
bill it paid, who let it go, what was checked first, the transaction, and proof that the record was not changed after.
Vestiarion signs every one of those facts into its ledger, but they are spread across pages: one evidence page per
payment, the hand-off's flat lists (`src/lib/accountant/handoff.ts`), the audit export's raw chain.

The close pack is the month in one table: one row per payment, with the invoice, the approval chain, the verification
record, the transaction and the signed entry, each cell resting on entries the file carries in full. It serves:
- the outside accountant, from the accountant console, closing several clients' months;
- the owner, from the **Audit log**, handing the month to an auditor or keeping it on file;
- later, integrations: a Google Sheet kept up to date, and an API read through the SDK.

It reads; it decides nothing, pays nothing, and calls no model. Downloading it records one ledger entry.

## Rules

Each rule ends with what it costs if it is wrong. Code comments and test names cite the ids, for example "(close pack CP3)".

**CP1. The month.** A calendar month in UTC: from the 1st at 00:00 UTC up to the next month's 1st, not including it.
- Asked as `month=YYYY-MM`. With none, the last full month, as the hand-off opens. This month is allowed and reads
  "so far"; a month still to come, one before 2020, or anything that is not `YYYY-MM` is refused.
- No workspace has a time zone: there is no column for one, and the hand-off and **Usage this month** count UTC months
  too. The page says "Months are calendar months in UTC."
- `closePackMonth` (`src/lib/close-pack/month.ts`) is the one parser. `handoffPeriod` delegates to it, so the hand-off
  and the close pack never disagree on a month.
- If wrong: for a business far from UTC, a payment made within a few hours of midnight on the last day lands in the
  neighbouring month. Fixing it later means a time zone column (a migration) and a `timeZone` option on
  `closePackMonth`; the shape of `ClosePackMonth` does not change.

**CP2. Which payments are rows.** A row is a `payment_intents` row of the workspace whose `status` is `confirmed` and
whose `confirmed_at` falls in the month, and whose source is a payable invoice or a milestone the workspace holds.
- One row per intent. `payment_intents` is unique on its source, so a bill retried after a failure is one row; its
  attempts Circle ended first are counted on it (`earlierAttempts`).
- When it settled is `confirmed_at`, the time Circle confirmed it. Rows are ordered by it, oldest first, then by id.
- A sandbox's simulated payments are rows, marked `simulated`, and totalled apart (CP6).
- A shadow-mode payment is a row, marked `shadow`: it is a real transfer at the real amount that mirrors a bill the
  business paid its own way.
- An intent whose bill no longer exists is not a row; it is counted (`totals.withoutBill`), and the page says so.
- Every intent is a row of at most one month: the one its `confirmed_at` falls in. A test holds this.
- If wrong: the month's total disagrees with Treasury and the books. The not-settled list (CP3) and the books check on
  each row (CP10) are where a reader sees why.

**CP3. Not settled in the month, listed apart.** Each intent created or sent in the month (`created_at` or
`submitted_at` in it) that is not a row of this month is listed under "Not settled in <month>", never in the totals, with
its state:

| State | When |
|---|---|
| `settled_later` | Confirmed, with `confirmed_at` after the month: it is a row of that later month. |
| `waiting` | Created, nothing sent yet. |
| `in_flight` | Sent, not confirmed: `submitting`, `pending`, or failed on a read of ours while Circle holds it. |
| `unknown` | Circle never answered the send, so it may hold the transfer. |
| `gateway_failed` | Gateway reported a failure, but it may still be minted. |
| `failed` | Circle failed or denied it. |
| `cancelled` | Circle cancelled it. |
| `not_sent` | It stopped before Circle took it. |
| `refunded` | A bank payout BlindPay refunded: `provider_tx_id` starts `blindpay:` and `provider_state` is `FAILED`. |

The states come from `settlementOf` (`src/lib/settlement-facts.ts`), the one lifecycle every page reads, with
`settled_later` and `refunded` told apart first. Each carries Circle's state and reason, or Vestiarion's error, as the
intent keeps them.
- If wrong: a payment in transit at month end is missed at cut-off, or read as paid. Listing it with its state and the
  month it settled in keeps both visible.

**CP4. Escrow moves, listed apart.** The `escrow_funded` and `escrow_refunded` entries in the month, under **Escrow**:
money locked for a milestone, or taken back to the workspace. A lock pays no one, so neither is in the totals. A release
that paid the contractor is a payment, and a row (`payout_route` `escrow`).
- If wrong: money that left the operating wallet into escrow is missing from the month, or counted as paid to a
  contractor who was not paid.

**CP5. Not in the pack.** It lists payments Vestiarion made, so these are left out, each said once in the guide:
- a bill marked paid with no payment (sample data, history imported as paid): its evidence page says "Marked paid, with
  no payment recorded";
- money received, and receivables;
- treasury moves (USYC);
- what a shadow-mode business paid outside Vestiarion (`payment_actuals`);
- bookings in the accounting tool without a payment.
- If wrong: an accountant expects a paid bill the pack does not list. The guide says where each of these is.

**CP6. Amounts and totals.**
- Every amount is a decimal string with exactly six places, `"1250.500000"`, never a float. Sums are made in millionths
  as `BigInt`, so `0.1 + 0.2` totals `"0.300000"`.
- A row's `amount` is what the transfer carried: the invoice's `paid_amount` when set (an early-payment discount, 0038),
  else the intent's `amount`. `discount` is the bill's amount less it, when that is more than zero.
- Totals are per token (`USDC`, `EURC`): never added across tokens, as the hand-off adds nothing across currencies.
- `onChain` totals the rows that moved on chain; `simulated` totals a sandbox's rows apart; `shadow` counts the shadow
  rows inside `onChain`.
- Route fees (a CCTP or Gateway payout's `bridge_fee`, in USDC) are summed. Network fees (`fee_usd`) are listed per row
  with where the figure came from (`fee_source`) and never summed: a batch's fee is the batch's, not one payment's.
- If wrong: a total that is off by a rounding, or adds EURC to USDC, is the first thing an accountant distrusts.

**CP7. The approval chain.** For each row, from its signed entries:
- **The paying entry**: the entry that sent the transfer (`ap_pay`, `approval_paid`, `milestone_release`,
  `milestone_approval_paid`): what let the current attempt go, as the settlement track reads it (`settlementOf`'s
  `stages.authorized.seq`), so the pack and the evidence page name the same entry. Without that stage, the recording
  entry when it is one of those, or, when the transaction was recorded by a reconcile, the newest of those before it.
  A person's approval that only recorded a transfer an earlier entry had sent is never the paying entry: approving a
  transfer that exists reconciles it and sends nothing (`transferExists` in `src/lib/agent/approvals.ts`), yet still
  writes `approval_paid` naming the hash with `status: "paid"`. So, by the ledger alone as well (an intent with no
  `submitted_at`), an `approval_paid` or `milestone_approval_paid` with no `retriedAfter`, after an earlier paying
  entry that names the same transaction and went out (or was held with no `heldBecause`), gives way to that earlier
  entry. One a person sent again after Circle failed the transfer names `retriedAfter`, and is theirs. Who approved,
  `authorizedBy`, the flags and the guardrails, payee lock and pay-to checks all read the paying entry.
- **The agent's decision**: the newest agent decision about the record at or before the paying entry (`ap_pay`,
  `ap_schedule`, `ap_hold`, `ap_flag_fraud`, `ap_request_info`, `milestone_release`, `milestone_hold`), with who decided
  (`deciderName`: "Claude", "DeepSeek", "The written policy", "The model"), the rule that held it (`guardrailRule`), and
  whether it was made in shadow mode.
- **Authorized by**: `code` when the agent paid it; `person` for one person's approval; `two_people` when the paying
  entry's `approvals` holds two; null when no entry records it (sample data).
- **The approvals**, the earlier first: from `approval_paid.detail.approvals` (`[{ by, at }]`), or its own `by` for one.
  Each with its person, when, its entry (the `approval_given` or `milestone_approval_given` that recorded the first, the
  paying entry for the last), where it came from (`via`: Telegram, Slack, the API) and whether it paid.
- **An accountant's co-sign**: an approval whose `approval_given` entry for this bill and person carries `cosign: true`.
  `approval_paid.approvals` does not say which approval was a co-sign, so the join is by bill and person, the newest
  `approval_given` before the paying entry.
- **Flags the paying entry recorded**: `soleApprover`, `addressGiverApproved`, `firstPayment`, `fewApprovers`.
- **A shadow-mode verdict**: the `decision_verdict` on the agent's decision (`subjectId` the bill, `entrySeq` the
  decision), agree or disagree, by whom.
- **The address and its second person**: the newest `create_counterparty` or `counterparty_address_changed` for the
  payee at or before the paying entry. When it set the address paid (compared without regard to case), it names who
  gave it; when it set another, no giver is named and the payee lock check says so (CP8). Then the first
  `counterparty_address_confirmed` after it, before the paying entry, for that address. Whether a second person stood
  behind it is `secondPersonOf` (`src/lib/payee-lock-evidence.ts`, exported for this), true only when known (payee lock
  evidence EP2). None for a bank payout or a simulated address; a mirror address Vestiarion made in shadow mode
  (`via: "mirror"`) is named as one, with no giver.
- A person is named by email with their role now; the role a person held when they approved is not signed, and the
  guide says so. Someone no longer a member is "a former member" with the first 8 characters of their id.
- If wrong: the chain names the wrong person, or misses a co-sign, and an auditor's sample fails. Every line cites its
  entry, so it can be checked against the ledger.

**CP8. The verification record.** Six checks per row, each labelled by how it is known, in the evidence chain's words
(`EVIDENCE_WORDS`: "Checked by code", "Verified outside", "Stated by a person", "Inferred", "Missing", "Could not open",
"Does not match"), plus "Does not apply". Each has one sentence, short notes, a time, its entries, and `warn` for bad news.

| Check | How it is known |
|---|---|
| `guardrails` | The agent's decision's checks, as `decisionChecks` words them (purchase order and goods, new payee, screening it saw, limit, duplicates, the spending-limit contract), marked ✓ ✗ ·. `checked`. With a person paying after a hold, the sentence names the rule (`ruleWords`). No decision: `missing`. |
| `screening` | The payee's newest complete `compliance_checks` row at or before the decision (else the paying entry, else when it was sent), as `readEvidence` reads it: a live provider is `verified` ("by OpenSanctions"); OFAC's list of addresses (`ofac-sdn`) is `contradicted`; the bundled list is `checked`. None, with a risk the decision recorded: `inferred`. None: `missing`. A read that failed: `unreachable`. Anything but clear warns. |
| `wallet_list` | Whether the address paid was on OFAC's SDN list. `contradicted` when the screening check came from that list. `checked` when the decision came on or after the workspace's first `compliance_sweep` that records `sanctionedWallets`: since then every screening and every payment checks it (sanctioned wallets SW4-SW6). `missing` before then. A bank payout or a simulated one: does not apply. |
| `payee_lock` | From the address's confirmation (CP7): with `payeeLock` recorded, the lock was on, `checked`, with its wait and how long after the address was given the payment was sent. The guardrail reads the lock in force when it pays, which an owner may have eased since (Settings; a lock eased frees a held payment at once, due-work watch DW8), so the lock in force is the newest `payee_lock_changed` (`detail.to`, `{ on, coolingHours }`) after the confirmation and before the paying entry, else the confirmation's. Sent before the wait in force ended, while that lock was on: `contradicted`. Sent after it, but before the wait the address was confirmed under: `stated` with a warning, naming who eased the lock and when, and citing the change. Without `payeeLock`, the lock was off: `inferred`. No confirmation: `missing`. The newest address the ledger recorded is not the one paid: `contradicted`. A bank, simulated or mirror address: does not apply. |
| `pay_to` | `invoices.document_pay_to` (0136): the same as the address paid, `checked`; another, which only a person can pay past (`invoice.pay_to_differs`), `stated` with a warning. None, a bank payout, or a milestone: does not apply. |
| `milestone` | A milestone's verification, as the evidence chain's "What was delivered" reads it: GitHub merged or Asana completed and accepted, `verified`; by hand, `stated`; sample data, `inferred`; not verified, `missing` with a warning. A bill: does not apply. |

- A pull request a milestone was verified by is named as text ("acme/app#12"), never linked: the pack does not run the
  evidence links' check (evidence access E1).
- The pack does not read the chain: a row's transaction is linked to its explorer, and its evidence page reads Arc's
  record. This keeps a month's read to the database and keeps the later API read cheap.
- If wrong: a check reads stronger than its source (say, "Checked by code" for something a person typed). Reusing the
  evidence chain's labels and helpers keeps the pack and the evidence page saying the same.

**CP9. The transaction.** Per row:
- `route`: `direct`, `cctp`, `gateway`, `escrow`, `bank` or `simulated`.
- The transaction that paid the payee and its chain, as a receipt reads it (`intentFacts`, `src/lib/receipts/facts.ts`):
  the transfer on the workspace's chain, or the mint on the payee's chain for CCTP, with the burn as `sourceTxHash`.
- The explorer link is `chainById(chain).explorerTx` plus the hash, built only for a hash that is `0x` and 64 hex
  digits. No link is ever built from a value an entry or a record holds.
- A bank payout names the bank code and the last 4 digits only, BlindPay's payout id, the rail and what the vendor
  received in pesos, from `approval_paid.detail.payout`.
- A simulated payment names what the simulator called it (`sim_…`) and links nothing.
- If wrong: a link to the wrong explorer, or to an address an attacker chose. Links come from the network profiles only.

**CP10. The signed record and the books.**
- `record`: the newest entry that records the transaction (`recordingEntry`), else the newest that names the bill's
  `tx_ref` (a simulated or bank payment), with its `seq`, `hash`, `signature`, `signing_key_id`, and the server's check
  of it alone (`verifyEntry`, `src/lib/receipts/verify.ts`), with the workspace's keys, retired ones included. Verified,
  not verified with the reason, or not checked here with the reason.
- `books`: whether the bill is marked paid, and how its books disagree with the transfer (`settlementOf`'s
  `mismatch`: confirmed but not marked paid, marked paid with another transaction, no signed entry naming it); and its
  booking in the accounting tool from its entries (`bookingFromEntries`).
- Every row lists every entry it cites. The pack carries each cited entry once, in full, oldest first, and no other.
- If wrong: a tampered entry reads as verified. The check is the receipt's own, already held equal to the SDK's.

**CP11. The page.** `/o/<slug>/evidence/close-pack`, "Monthly close pack", inside **Audit log** (`SUBPAGES` in
`src/components/vx/nav.ts`). It takes `?month=` as CP1 reads it. A value given twice, or one that does not read, shows
last month and says so. It shows the totals, the rows, what was not settled, the escrow moves, and how many cited entries
verify. A member reads it ten times at once, then once every 6 seconds (`takeClosePackPageToken`), since each read
checks the cited entries' signatures. Opening it writes nothing.
- If wrong: a heavy read run in a loop. The bucket is per instance, a soft brake; the page reads no chain and calls no
  model, so a read costs database time only.

**CP12. Downloads.** `GET /api/evidence/close-pack?org=<slug>&month=YYYY-MM&format=csv|json`, and print.
- **Download CSV**: one row per settled payment (CP2), the columns `CLOSE_PACK_COLUMNS` names, a byte-order mark first,
  CRLF lines, each cell guarded by `csvCell` so nothing runs as a formula. It carries each row's entry number,
  signature, key id and whether it verified. Not-settled payments and escrow moves are on the page and in the JSON.
- **Download signed JSON**: `vestiarion-close-pack/1`, in the evidence export's shape: the rows with their checks, the
  cited entries in full (`body_hash`, `signature`, `prev_hash`, `hash`, `signing_key_id`, `check`), the workspace's
  public keys (`exportKeys`), `checkAnEntry` (`CHECK_AN_ENTRY`) and `signedEntryProves`. The file itself is not signed
  with the ledger key: the key signs ledger entries only. What makes the file checkable is its entries, and the
  download's own entry (CP13), which signs the file's SHA-256.
- **Print or save as PDF**: the browser's print dialog, as the payee lock pack does. Printed, the page drops the shell,
  the month controls, the buttons and the evidence links, adds a line only the print shows, and keeps each row on one
  page where it fits.
- Files are `vestiarion-close-pack-<slug>-<YYYY-MM>.csv` or `.json`, and `-so-far` before the extension for a month not
  ended, so an early copy is never mistaken for the closed month.
- If wrong: a spreadsheet runs a vendor's name as a formula, or Excel reads the file as the wrong encoding. Both are
  guarded the way the audit export and the payee lock pack already are, and tested.

**CP13. Each download is recorded.** A download appends `close_pack_exported` (actor `human`, domain `system`)
`{ by, month, ended, format, payments, notSettled, sha256, headSeq }`: who, the month (`YYYY-MM`), whether it had ended,
`csv` or `json`, how many rows and not-settled payments, the SHA-256 of the exact bytes served (hex), and the ledger's
last entry when the pack was read. It names no one by email.
- Why: a close pack is handed over, like the hand-off (`handoff_exported`) and the audit export (`ledger_exported`).
  The entry tells who took which month's books out, ties any copy to the ledger by its hash, and is the brake's count
  (CP15), which holds across instances.
- It is appended best effort (`appendLedgerEntryBestEffort`) after the file is built and before it is sent: a failure
  is logged and the file is still served.
- Viewing the page and printing it record nothing.
- If wrong: every download adds an entry and a webhook delivery. The brake bounds it to ten per person per ten minutes.

**CP14. Who sees it.** Every member, as every evidence page and the hand-off: owners, admins, approvers, accountants and
viewers (`workspace.read`).
- The route refuses a cross-site request before reading anything (403), asks someone signed out to sign in (401),
  refuses a bad month or format before the workspace is looked up (400), and gives a non-member the same 404 as a
  workspace that does not exist. The membership is read afresh on each request.
- The page gates as every workspace page does (`requireMembership`, `inOrg`).
- Everything is read in the workspace's scope, through `db()`.
- If wrong: a viewer sees approvers' emails. They already see them on every evidence page and the audit log.

**CP15. Limits.** Downloads: ten per person per workspace in ten minutes, counted from `close_pack_exported` entries
(`CLOSE_PACK_EXPORT_LIMIT`), as the hand-off counts its own; the eleventh answers 429 with `retry-after: 600`. That
count holds across instances, but a download appends its entry only once its read is done, so downloads sent at once
would all count the same earlier ones and each run the whole read. So the route also takes a token from a per-member
bucket (`takeClosePackDownloadToken`: three at once, then one a minute) right after the session, format and month
checks, before the membership or the month is read; past it, 429 with `retry-after: 60`. The bucket is per instance,
a soft brake on a burst, as CP11's is. A reservation entry appended before the read would not do: the entry carries the
served file's SHA-256 (CP13), known only once it is built. Page reads: CP11. A month holds at most 2,000 payments (`CLOSE_PACK_MAX_PAYMENTS`, rows and not settled together). Past it the
pack is `cut` and says so.
- If wrong: a business with more than 2,000 payments a month sees a cut pack. That is far above any workspace today,
  and the audit export holds everything.

**CP16. Where it opens from.**
- **Audit log**: **Monthly close pack**, beside the audit export.
- The accountant console: each workspace card's **Close pack:** line, with last month and **This month so far**,
  beside **Hand-off:**.
- Each row links its evidence page (**Open the payment's evidence**), and the guide links the page.
- If wrong: the accountant never finds it. The console card is where they already download the month.

**CP17. Untrusted text, files and links.** Vendor names, invoice numbers, memos and a vendor's typed PO come from
outside (a payee link, an email, a document a model read). The pack only shows them:
- React escapes them on the page, `csvCell` guards them in the CSV, and the JSON carries them as data.
- A memo is cut to 200 characters.
- No file is read or served: an invoice's document and a vendor's document are named by their SHA-256 only, and the pack
  never carries a storage address.
- Nothing in the pack reaches a model.
- If wrong: a cell runs as a formula on an accountant's machine. Tested with `=`, `+`, `-` and `@` cells.

**CP18. The surfaces after this one.** This PR builds neither; it makes both a few lines.
- `GET /api/v1/close-packs/{month}` (SDK 0.4) answers `{ data: closePackDocument(pack, { origin }) }`, with
  `readClosePack({ month, people: "id" })` inside `handleApiRequest`.
  - Members are named by user id, never by email: the ledger API already names people by id.
  - It records no ledger entry, as no v1 read does.
  - It gets its own per-key bucket, since v1 reads are not limited today.
- The Google Sheets export writes `closePackTable(pack, { origin })`, the same columns as the CSV, with
  `valueInputOption: "RAW"`, so no cell runs as a formula.
- `ClosePackDocument` holds only strings, numbers, booleans, null, arrays, objects and literal unions, so its later Zod
  schema stays within what the SDK's type renderer takes (no `format`, no `oneOf`).
- If wrong: the v1 item reshapes the document, and every reader of `vestiarion-close-pack/1` breaks. The format string
  is versioned for that reason; a change is `/2`.

**CP19. No migration.** It reads existing tables and the ledger.
- Every column it reads was there before 0136, except `invoices.document_pay_to` (0136). That one is read through
  `readDocumentPayTo` (`src/lib/invoice-pay-to.ts`), which answers "none" on `42703` and `PGRST204`, so the pay-to check
  reads "Does not apply" before 0136.
- It touches no `document_requests` row (0142): a vendor's document comes from its `document_received` entry.
- If wrong: the read is slower than it should be without an index on `compliance_checks (counterparty_id, created_at)`
  or on `payment_intents (org_id, confirmed_at)`. Both can come later as an additive index, with no code change.

**CP20. Docs and lists.** See "Docs and lists to update" below.

## The shared contract

Pure modules import types only from server modules. Components import `types.ts`, `words.ts` and `month.ts` only.

```ts
// src/lib/close-pack/month.ts: pure, browser-safe (CP1)
export interface ClosePackMonth {
  /** The first day, YYYY-MM-DD (UTC). */
  from: string;
  /** The next month's first day, YYYY-MM-DD: the month runs up to it, not including it. */
  to: string;
  /** "October 2026". */
  label: string;
  /** "2026-10". */
  key: string;
}
/** `YYYY-MM`, or the last full UTC month when null or ""; null for a month that does not read, before 2020, or to come. */
export function closePackMonth(month: string | null, now?: Date): ClosePackMonth | null;
/** Whether the month has ended at `now`; false for this month so far. */
export function monthEnded(month: ClosePackMonth, now: Date): boolean;
/** The months either side; `next` is null when it is still to come, `previous` when it is before 2020. */
export function monthsBeside(month: ClosePackMonth, now: Date): { previous: ClosePackMonth | null; next: ClosePackMonth | null };
/** The page's month: `?month=` read once; given twice, or one that does not read, is last month and `unreadable`. */
export function closePackMonthFrom(query: Record<string, string | string[] | undefined>, now: Date): { month: ClosePackMonth; unreadable: boolean };

// src/lib/accountant/handoff.ts changes to:
export type HandoffPeriod = ClosePackMonth;
export function handoffPeriod(month: string | null, now: Date = new Date()): HandoffPeriod | null; // returns closePackMonth(month, now)
```

```ts
// src/lib/close-pack/types.ts: types and constants only (`import type` from everything else)
import type { OrgRole } from "../auth/roles";
import type { EvidenceKind, EvidenceScreening } from "../evidence-chain";
import type { EvidenceKey } from "../evidence-export";
import type { LedgerRow } from "../ledger";
import type { Network } from "../network";
import type { EntryCheck } from "../receipts/verify";
import type { SettlementMismatch } from "../settlement";
import type { ClosePackMonth } from "./month";

export const CLOSE_PACK_FORMAT = "vestiarion-close-pack/1";
/** The most payments one month's pack reads, rows and not settled together (CP15). */
export const CLOSE_PACK_MAX_PAYMENTS = 2000;

/** An amount as text with exactly six decimal places, "1250.500000": never a float (CP6). */
export type Decimal = string;
export type ClosePackToken = "USDC" | "EURC";
export type ClosePackSource = { kind: "invoice" | "milestone"; id: string };

/** Who did a step (CP7). `email` is null when the pack is read with `people: "id"`, or when members could not be read. */
export type ClosePackWho =
  | { kind: "member"; userId: string; email: string | null; roleNow: OrgRole | null }
  | { kind: "former_member"; userId: string }
  | { kind: "payee_link"; linkId: string | null }
  | { kind: "github"; login: string | null }
  | { kind: "unknown" };

/** How a check is known: the evidence chain's seven words, and one for a check with nothing to look at (CP8). */
export type ClosePackCheckKind = EvidenceKind | "not_applicable";

export interface ClosePackCheck {
  kind: ClosePackCheckKind;
  /** One sentence. */
  text: string;
  /** Short lines under it: each guardrail's line, marked ✓ ✗ ·. */
  notes: string[];
  /** When it was checked or recorded (ISO), or null. */
  at: string | null;
  /** The entries it rests on, by seq. */
  entries: number[];
  /** Bad news, however well it is known: screened high risk, an address on OFAC's list, paid before the wait. */
  warn: boolean;
}

export interface ClosePackChecks {
  guardrails: ClosePackCheck;
  screening: ClosePackCheck;
  walletList: ClosePackCheck;
  payeeLock: ClosePackCheck;
  payTo: ClosePackCheck;
  /** `not_applicable` for a bill. */
  milestone: ClosePackCheck;
}

export interface ClosePackApproval {
  who: ClosePackWho;
  at: string;
  /** An accountant's co-sign: its `approval_given` carries `cosign: true`. It paid nothing itself. */
  cosign: boolean;
  /** This approval sent the payment: the paying entry's own person. */
  paid: boolean;
  /** Where it came from when not the app: "telegram", "slack", "api", …; null for the app. */
  via: string | null;
  /** The `approval_given` / `milestone_approval_given` that recorded it, or the paying entry; null when none is read. */
  entry: number | null;
}

export interface ClosePackAddress {
  /** The address paid, in full. */
  address: string;
  /** Vestiarion made it in shadow mode (`via: "mirror"`): no person typed it. */
  mirror: boolean;
  givenBy: ClosePackWho | null;
  givenAt: string | null;
  confirmedBy: ClosePackWho | null;
  confirmedAt: string | null;
  /** With Confirm address, or by approving a payment to it. */
  confirmedWith: "confirm" | "approval" | null;
  /** Someone other than whoever gave it confirmed it: true only when known (`secondPersonOf`, payee lock evidence EP2). */
  secondPerson: boolean | null;
  entries: number[];
}

export interface ClosePackApprovalChain {
  /** code: the agent paid it within its rules; person: one approval; two_people: two; null: no entry records it. */
  authorizedBy: "code" | "person" | "two_people" | null;
  agent: {
    /** ap_pay, ap_schedule, ap_hold, ap_flag_fraud, ap_request_info, milestone_release or milestone_hold. */
    action: string;
    /** `deciderName(decisionMode)`: "Claude", "DeepSeek", "The written policy", "The model". */
    decider: string;
    /** The rule a guardrail held it by (`guardrailRule`), or null. */
    guardrailRule: string | null;
    shadow: boolean;
    at: string;
    entry: number;
  } | null;
  /** The earlier first; empty when the agent paid it. */
  approvals: ClosePackApproval[];
  verdict: { verdict: "agree" | "disagree"; who: ClosePackWho; at: string; entry: number } | null;
  flags: { soleApprover: boolean; addressGiverApproved: boolean; firstPayment: boolean; fewApprovers: boolean };
  /** Null for a bank payout or a simulated payee address. */
  address: ClosePackAddress | null;
}

export type ClosePackBill =
  | {
      kind: "invoice";
      id: string;
      /** The vendor's own number, from `create_invoice` (`invoiceNumberInDetail`). */
      number: string | null;
      amount: Decimal;
      currency: ClosePackToken;
      /** A shadow-mode bill as written in the business's currency (`create_invoice.detail.bill`). */
      written: { amount: number; currency: string } | null;
      /** YYYY-MM-DD. */
      dueDate: string | null;
      poReference: string | null;
      /** Cut to 200 characters (CP17). */
      memo: string | null;
      /** The document the bill was read from; the document itself is not kept. */
      document: { sha256: string; kind: string | null } | null;
      /** Sent by the vendor through a document request (`document_received`). */
      vendorDocuments: Array<{ sha256: string; type: string | null; at: string; entry: number }>;
      /** Its `create_invoice`, `import_invoice` or `recurring_invoice_created`. */
      entry: number | null;
    }
  | { kind: "milestone"; id: string; title: string; amount: Decimal; currency: "USDC"; entry: number | null };

export interface ClosePackPayee {
  counterpartyId: string;
  name: string | null;
  /** The address paid (`payment_intents.destination`), in full; null for a bank payout. */
  address: string | null;
  bank: {
    provider: "blindpay";
    bankCode: string | null;
    last4: string | null;
    rail: string | null;
    receiverAmount: Decimal | null;
    receiverCurrency: string | null;
    payoutId: string | null;
  } | null;
}

export interface ClosePackTransaction {
  route: "direct" | "cctp" | "gateway" | "escrow" | "bank" | "simulated";
  /** The transaction that paid the payee: the transfer, or the mint on their chain. Null when none is on chain. */
  txHash: string | null;
  /** Circle's chain name, "ARC-TESTNET", "BASE-SEPOLIA", …; its label, "Arc testnet", "Base Sepolia". */
  chain: string | null;
  chainLabel: string | null;
  explorerUrl: string | null;
  /** CCTP: the burn on the workspace's own chain. */
  sourceTxHash: string | null;
  sourceExplorerUrl: string | null;
  /** What the simulator named a sandbox payment (`sim_…`). */
  simulatedRef: string | null;
  /** Why no transaction shows, when one should: "The payee's chain has not minted this payout yet." */
  note: string | null;
  networkFeeUsd: Decimal | null;
  networkFeeSource: "chain_reported" | "provider_estimate" | "simulated_profile" | null;
  /** CCTP or Gateway: the route's fee, in USDC. */
  routeFeeUsdc: Decimal | null;
  /** Attempts Circle ended before the one that paid. */
  earlierAttempts: number;
}

export interface ClosePackRecord {
  seq: number;
  action: string;
  ts: string;
  hash: string;
  signature: string;
  signingKeyId: string | null;
  /** The server's check of this entry alone. Before checks are given: `{ ok: null, reason: "Not checked yet." }`. */
  check: EntryCheck;
}

export interface ClosePackRow {
  paymentId: string;
  source: ClosePackSource;
  /** `confirmed_at` (CP2). */
  paidAt: string;
  /** `submitted_at`, else `created_at`. */
  sentAt: string;
  amount: Decimal;
  token: ClosePackToken;
  discount: Decimal | null;
  simulated: boolean;
  shadow: boolean;
  payee: ClosePackPayee;
  bill: ClosePackBill;
  approval: ClosePackApprovalChain;
  checks: ClosePackChecks;
  transaction: ClosePackTransaction;
  record: ClosePackRecord | null;
  books: {
    markedPaid: boolean;
    mismatch: SettlementMismatch | null;
    booked: { tool: string; state: string; paymentId: string | null; at: string; entry: number } | null;
  };
  /** `/o/<slug>/evidence/<kind>/<id>`. */
  evidencePath: string;
  /** Every entry the row cites, ascending. */
  entries: number[];
}

export type ClosePackOpenState =
  | "settled_later" | "waiting" | "in_flight" | "unknown" | "gateway_failed" | "failed" | "cancelled" | "not_sent" | "refunded";

export interface ClosePackOpenPayment {
  paymentId: string;
  source: ClosePackSource;
  payee: { counterpartyId: string; name: string | null };
  amount: Decimal;
  token: ClosePackToken;
  simulated: boolean;
  state: ClosePackOpenState;
  sentAt: string | null;
  /** `settled_later` only: when it settled. */
  settledAt: string | null;
  /** Circle's state and reason, or Vestiarion's error, as the intent keeps them. */
  reason: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  evidencePath: string;
}

export interface ClosePackEscrowMove {
  kind: "funded" | "refunded";
  at: string;
  milestoneId: string;
  title: string | null;
  amount: Decimal;
  txHash: string | null;
  explorerUrl: string | null;
  entry: number;
}

export interface ClosePackTotal {
  token: ClosePackToken;
  payments: number;
  amount: Decimal;
  routeFeesUsdc: Decimal;
}

export interface ClosePackTotals {
  onChain: ClosePackTotal[];
  simulated: ClosePackTotal[];
  /** Shadow-mode rows, counted inside `onChain`. */
  shadow: number;
  notSettled: Partial<Record<ClosePackOpenState, number>>;
  /** Payments whose bill is gone (CP2). */
  withoutBill: number;
  entries: { cited: number; verified: number; failed: number; unchecked: number };
}

/** A cited entry in full, as the evidence export carries it (snake_case), with the server's check. */
export interface ClosePackEntry {
  seq: number;
  id: string | null;
  ts: string;
  actor: string;
  domain: string;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  body_hash: string;
  signature: string;
  prev_hash: string;
  hash: string;
  signing_key_id: string | null;
  check: EntryCheck | null;
}

export interface ClosePack {
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  month: ClosePackMonth;
  ended: boolean;
  /** When it was read (ISO). */
  readAt: string;
  ledgerHead: { seq: number; hash: string } | null;
  cut: boolean;
  /** Parts that could not be read just now; the rest shows. */
  unread: Array<"members" | "screening">;
  people: "email" | "id";
  totals: ClosePackTotals;
  rows: ClosePackRow[];
  notSettled: ClosePackOpenPayment[];
  escrow: ClosePackEscrowMove[];
  keys: EvidenceKey[];
  entries: ClosePackEntry[];
}

/** The rows the reader hands the builder: the columns `read.ts` selects. */
export interface ClosePackIntentRow {
  id: string;
  source_type: "invoice" | "milestone";
  source_id: string;
  status: string;
  provider: string;
  provider_mode: string | null;
  provider_tx_id: string | null;
  provider_state: string | null;
  failure_reason: string | null;
  last_error: string | null;
  amount: string | number;
  token: string | null;
  destination: string;
  tx_hash: string | null;
  chain: string | null;
  destination_chain: string | null;
  mint_tx_hash: string | null;
  bridge_fee: string | number | null;
  payout_route: string | null;
  network: string | null;
  fee_usd: string | number | null;
  fee_source: string | null;
  transfer_attempt: number | null;
  previous_attempts: unknown;
  batch_key: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  executed_at: string | null;
  confirmed_at: string | null;
}
export interface ClosePackInvoiceRow {
  id: string;
  direction: string;
  counterparty_id: string;
  amount: string | number;
  currency: string | null;
  paid_amount: string | number | null;
  memo: string | null;
  po_reference: string | null;
  due_date: string | null;
  status: string;
  tx_ref: string | null;
  settled_at: string | null;
}
export interface ClosePackMilestoneRow {
  id: string;
  contractor_id: string;
  title: string;
  amount: string | number;
  status: string;
  verified: boolean;
  verification_method: string | null;
  verification_status: string | null;
  verification_source: string | null;
  verification_checked_at: string | null;
  verified_at: string | null;
  verification_detail: Record<string, unknown> | null;
  tx_ref: string | null;
  settled_at: string | null;
  escrow_state: string | null;
  escrow_payee: string | null;
  escrow_amount: string | number | null;
  escrow_release_tx_hash: string | null;
}
export type ClosePackLedgerRow = LedgerRow & { id?: string };
```

```ts
// src/lib/close-pack/build.ts: pure (CP2-CP10)
export interface ClosePackInput {
  workspace: { slug: string; name: string };
  network: Network;
  month: ClosePackMonth;
  now: Date;
  /** The month's candidate intents (CP2, CP3), at most CLOSE_PACK_MAX_PAYMENTS. */
  intents: readonly ClosePackIntentRow[];
  invoices: readonly ClosePackInvoiceRow[];
  milestones: readonly ClosePackMilestoneRow[];
  counterparties: ReadonlyMap<string, { name: string; address: string | null; sample: boolean }>;
  /** Invoice id to the address its document asked to be paid to (0136); empty before 0136. */
  documentPayTo: ReadonlyMap<string, string>;
  /**
   * Every entry about the bills and milestones, the verdicts on them, their payees' address entries
   * (`create_counterparty`, `counterparty_address_changed`, `counterparty_address_confirmed`, `payee_link_created`),
   * and the month's `escrow_funded` / `escrow_refunded`.
   */
  entries: readonly ClosePackLedgerRow[];
  /** By payment id: the payee's newest complete check at or before `screeningAnchors`' time, null for none, or unread. */
  screening: ReadonlyMap<string, EvidenceScreening | null | "unread">;
  /** `ts` of the workspace's first `compliance_sweep` recording `sanctionedWallets`, or null (CP8). */
  walletListSince: string | null;
  /** By user id; null when they could not be read. */
  members: ReadonlyMap<string, { email: string; role: OrgRole }> | null;
  people: "email" | "id";
  keys: EvidenceKey[];
  ledgerHead: { seq: number; hash: string } | null;
  cut: boolean;
  /** Each cited entry's check, by seq. Absent on the first build, which only finds what is cited. */
  checks?: ReadonlyMap<number, EntryCheck>;
}
export function buildClosePack(input: ClosePackInput): ClosePack;
/** For each settled payment, whose screening to read and as of when: the agent's decision, else the paying entry, else sentAt. */
export function screeningAnchors(input: Omit<ClosePackInput, "screening" | "checks">): Map<string, { counterpartyId: string; at: string }>;
export function closePackEvidencePath(slug: string, source: ClosePackSource): string;
/** "0.1" + "0.2" = "0.300000"; amounts in millionths as BigInt (CP6). */
export function addDecimals(values: ReadonlyArray<string | number>): Decimal;
export function toDecimal(value: string | number | null | undefined): Decimal | null;
```

```ts
// src/lib/close-pack/read.ts: server only, inside the workspace's scope (withOrg or inOrg); reads through db()
export async function readClosePack(input: {
  month: ClosePackMonth;
  /** From the session's membership; when absent, read from `orgs` by the scope's org id (an API key, a job). */
  workspace?: { slug: string; name: string };
  /** "email" for a person's page and files; "id" for the API (CP18). Default "email". */
  people?: "email" | "id";
  now?: Date;
}): Promise<ClosePack>;
```

```ts
// src/lib/close-pack/export.ts: pure (CP12)
export type ClosePackDocument = {
  format: typeof CLOSE_PACK_FORMAT;
  exportedAt: string;
  workspace: { slug: string; name: string };
  network: { id: Network; label: string };
  month: ClosePackMonth & { ended: boolean };
  ledgerHead: { seq: number; hash: string } | null;
  cut: boolean;
  unread: Array<"members" | "screening">;
  totals: ClosePackTotals;
  rows: Array<ClosePackRow & { evidenceUrl: string }>;
  notSettled: Array<ClosePackOpenPayment & { evidenceUrl: string }>;
  escrow: ClosePackEscrowMove[];
  /** Each check kind's words and what it means. */
  labels: Record<ClosePackCheckKind, { words: string; meaning: string }>;
  signedEntryProves: string;
  checkAnEntry: readonly string[];
  keys: EvidenceKey[];
  entries: ClosePackEntry[];
};
export function closePackDocument(pack: ClosePack, options: { origin: string }): ClosePackDocument;
/** The exact text the route serves and hashes: JSON.stringify(closePackDocument(...), null, 2). */
export function closePackJson(pack: ClosePack, options: { origin: string }): string;
export const CLOSE_PACK_COLUMNS: readonly ClosePackColumn[]; // the 51 names below, in order
export type ClosePackColumn = (typeof CLOSE_PACK_COLUMNS)[number];
/** One row per settled payment, plain unguarded text: the CSV guards each cell; Sheets writes it RAW (CP18). */
export function closePackTable(pack: ClosePack, options: { origin: string }): { columns: readonly ClosePackColumn[]; rows: string[][] };
/** A byte-order mark, the header, then the table, CRLF, every cell through `csvCell`. */
export function closePackCsv(pack: ClosePack, options: { origin: string }): string;
/** vestiarion-close-pack-pinecrest-studio-2026-10.csv; "-so-far" before the extension for a month not ended. */
export function closePackFileName(slug: string, month: ClosePackMonth, ended: boolean, extension: "json" | "csv"): string;
```

```ts
// src/lib/close-pack/words.ts: pure; the page, the CSV and the table read the same words
export const CHECK_KIND_WORDS: Readonly<Record<ClosePackCheckKind, string>>;    // EVIDENCE_WORDS + "Does not apply"
export const CHECK_KIND_MEANINGS: Readonly<Record<ClosePackCheckKind, string>>; // EVIDENCE_MEANINGS + its own
export function whoWords(who: ClosePackWho): string;
export function amountWords(amount: Decimal, token: string): string;           // "1,250.50 USDC"
export function utcWords(ts: string): string;                                   // "2026-10-20 14:03 UTC"
export function checkCell(check: ClosePackCheck): string;                       // "Checked by code: Code checked it before it was sent."
export function decidedLines(row: ClosePackRow): string[];
export function approvedLines(row: ClosePackRow): string[];
export function addressLines(row: ClosePackRow): string[];
export function billWords(row: ClosePackRow): string;
export function paidToWords(row: ClosePackRow): string;
export function transactionWords(row: ClosePackRow): string;
export function booksWords(row: ClosePackRow): string;
export function recordWords(record: ClosePackRecord | null): string;
export function openStateWords(payment: ClosePackOpenPayment, month: ClosePackMonth): string;
export function escrowWords(move: ClosePackEscrowMove): string;
```

```ts
// src/lib/close-pack/record.ts: server (CP13, CP15)
export const CLOSE_PACK_EXPORT_LIMIT = { count: 10, windowMs: 10 * 60_000 };
/** close_pack_exported entries by this person in the window, capped at the limit's count. */
export async function recentClosePackExportsBy(userId: string, now?: Date): Promise<number>;
/** Appends close_pack_exported, best effort. */
export async function recordClosePackExport(input: {
  orgId: string;
  userId: string;
  pack: ClosePack;
  format: "json" | "csv";
  sha256: string;
}): Promise<void>;

// src/lib/rate-limit.ts adds (CP11)
export function takeClosePackPageToken(userId: string, now?: number): boolean; // 10 at once, then one every 6 s
// and (CP15)
export function takeClosePackDownloadToken(userId: string, now?: number): boolean; // 3 at once, then one a minute

// src/lib/payee-lock-evidence.ts: export the existing secondPersonOf (no change to what it does)
// src/lib/evidence-chain.ts: export the existing pullRequestName (no change to what it does)
```

How each caller reaches it:

```ts
// A session (the page, the route): the membership was checked first.
const pack = await inOrg({ user, membership }, () =>
  readClosePack({ month, workspace: { slug: membership.slug, name: membership.name } }));

// An API key (the later v1 route): handleApiRequest already runs inside withOrg(key.orgId).
return handleApiRequest("GET /api/v1/close-packs/{month}", guard.key, async () => {
  const month = closePackMonth(monthParam, new Date());
  if (!month) return apiError("invalid_request", "month must be YYYY-MM, and not a month still to come");
  return { data: closePackDocument(await readClosePack({ month, people: "id" }), { origin: publicOrigin() }) };
});

// A job with an org id and a person (the later Sheets export).
const pack = await withOrg(orgId, () => readClosePack({ month }), { userId });
const { columns, rows } = closePackTable(pack, { origin: publicOrigin() }); // written with valueInputOption RAW
```

`CLOSE_PACK_COLUMNS`, in order: `paid_at`, `payment_id`, `record`, `record_id`, `payee`, `payee_id`, `paid_to`, `chain`,
`invoice_number`, `milestone`, `bill_amount`, `bill_currency`, `amount_paid`, `token`, `discount`, `due_date`,
`po_reference`, `document_sha256`, `vendor_document_sha256`, `simulated`, `shadow`, `decided`, `approvals`,
`authorized_by`, `address_given_by`, `address_confirmed_by`, `second_person`, `guardrails`, `guardrail_notes`,
`screening`, `wallet_list`, `payee_lock`, `pay_to`, `milestone_verification`, `route`, `tx_hash`, `tx_url`,
`burn_tx_hash`, `network_fee_usd`, `network_fee_source`, `route_fee_usdc`, `earlier_attempts`, `books`, `booked_in`,
`entry_seq`, `entry_hash`, `signature`, `signing_key_id`, `entry_verified`, `evidence_url`, `entries`.
- Yes/no columns read `yes`, `no`, or empty when not known.
- A check column is `checkCell(check)`: its kind's words, a colon, its sentence.
- Lines join with `; `, entries with a space.
- `entry_verified` reads `yes`, `no` or `not checked`.

## Data it reads and writes

All reads run in the workspace's scope through `db()` (the DAL adds `org_id`). Ids go a hundred at a time per `in`
filter; ledger reads go a page of 1000 at a time by `seq`, as `readPayeeLockEvidence` reads them.

| Read | Columns | Filter |
|---|---|---|
| `payment_intents` | `id, source_type, source_id, status, provider, provider_mode, provider_tx_id, provider_state, failure_reason, last_error, amount, token, destination, tx_hash, chain, destination_chain, mint_tx_hash, bridge_fee, payout_route, network, fee_usd, fee_source, transfer_attempt, previous_attempts, batch_key, created_at, updated_at, submitted_at, executed_at, confirmed_at` | `confirmed_at`, `created_at` or `submitted_at` in the month; by `created_at`, `id`; at most 2,001 read, to tell a cut |
| `invoices` | `id, direction, counterparty_id, amount, currency, paid_amount, memo, po_reference, due_date, status, tx_ref, settled_at` | the intents' invoice ids |
| `invoices.document_pay_to` | through `readDocumentPayTo` | the same ids; none before 0136 |
| `milestones` | `id, contractor_id, title, amount, status, verified, verification_method, verification_status, verification_source, verification_checked_at, verified_at, verification_detail, tx_ref, settled_at, escrow_state, escrow_payee, escrow_amount, escrow_release_tx_hash` | the intents' and escrow moves' milestone ids |
| `counterparties` | `id, name, address, chain, sample` | the bills' and milestones' payees |
| `compliance_checks` | `risk_level, source, screening_mode, created_at` | per settled payment: its payee, `status = complete`, `created_at` at or before its anchor, newest one; ten at a time, one read per distinct payee and time |
| `ledger_entries` `*` | | `detail->>invoiceId` in the invoice ids; `detail->>milestoneId` in the milestone ids |
| `ledger_entries` `*` | | `action = decision_verdict`, `detail->>subjectId` in the invoice ids |
| `ledger_entries` `*` | | `detail->>counterpartyId` in the payee ids and `action` in `create_counterparty`, `counterparty_address_changed`, `counterparty_address_confirmed`, `payee_link_created` |
| `ledger_entries` `*` | | `action` in `escrow_funded`, `escrow_refunded`, `ts` in the month |
| `ledger_entries` `*` | | `action = payee_lock_changed`, `ts` before the month's end: an owner's change names no payee, so the workspace's are read |
| `ledger_entries` `ts` | | `action = compliance_sweep`, `detail->sanctionedWallets` not null, oldest one |
| `ledger_entries` `seq, hash` | | the newest one: the head |
| `org_members` (RPC) | through `listMembers(currentOrgId())` | null on failure, and `unread` says `members` |
| `orgs` `slug, name` | through `platformDb()` | only when no workspace was given, by the scope's org id |

Ledger kinds read, and the fields used:
- `create_invoice`, `import_invoice`, `recurring_invoice_created`: `invoiceId`, `invoiceNumber`, and under
  `xero`/`quickbooks`/`zohobooks` (`invoiceNumberInDetail`); `document.{kind, sha256}`; `bill.{currency, amount}`;
  `via`; `by`. `create_milestone`: `milestoneId`.
- `ap_pay`, `ap_schedule`, `ap_hold`, `ap_flag_fraud`, `ap_request_info`, `milestone_release`, `milestone_hold`:
  `decisionMode`, `guardrailBlocked`, `guardrailRule`, `shadow`, `observed.*` (for `decisionChecks`),
  `onChainLimit.verdict`, `execution.{txRef, resultingStatus, mintTxHash}`.
- `ap_reconcile`, `milestone_reconcile`: `execution.txRef`.
- `approval_given`, `milestone_approval_given`: `by`, `invoiceId`/`milestoneId`, `cosign`, `via`.
- `approval_paid`, `milestone_approval_paid`: `by`, `txRef`, `status`, `approvals[{ by, at }]`, `soleApprover`,
  `addressGiverApproved`, `firstPayment`, `fewApprovers`, `via`, and `payout.{route, provider, payoutId,
  receiverAmount, currency, rail, bankAccount.{bankCode, last4}}`.
- `decision_verdict`: `by`, `subjectId`, `entrySeq`, `verdict`.
- `verify_milestone_github`, `github_verification_update`, `verify_milestone_manual`, `milestone_accepted`:
  `milestoneId`, `by`.
- `document_received`: `invoiceId`, `fileSha256`, `fileType`.
- `accounting_payment_*` (`BOOKING_ACTIONS`): through `bookingFromEntries`.
- `create_counterparty` (`address`, `by`, `via`), `counterparty_address_changed` (`to`, `by`, `via`, `linkId`,
  `login`), `counterparty_address_confirmed` (`address`, `by`, `via`, `payeeLock.coolingHours`, `soloConfirmation`,
  `byGiver`, `giverUnknown`), `payee_link_created` (`linkId`, `by`).
- `escrow_funded` (`milestoneId`, `amountUsdc`, `fundTxHash`), `escrow_refunded` (`milestoneId`, `amountUsdc`,
  `refundTxHash`).
- `payee_lock_changed`: `by`, `to.{on, coolingHours}`.
- `approval_paid`, `milestone_approval_paid`, `ap_pay`, `milestone_release`: also `retriedAfter` and
  `execution.heldBecause`, to tell the entry that sent a transfer from one that only recorded it (CP7).
- `compliance_sweep`: `ts` only.

Writes: one ledger entry per download, `close_pack_exported` (CP13). Nothing else: no row, no file, no cache.

The reader builds twice, as `readEvidence` does: once to find the cited entries, then, after `verifyEntry` checks each
of those with `ledgerPublicKeyPems(ledgerVerificationKeyring())`, again with `checks`. A check that throws is
`{ ok: null, reason: "The signature could not be checked here." }`.

## Screens and copy

Every network name comes from the workspace's network profile (`networkProfile(network).label`): "Arc testnet" or "Arc
mainnet". `src/` never writes either name itself (`tests/network-copy-ratchet.test.ts`). Times read like
"2026-10-20 14:03 UTC"; amounts like "1,250.50 USDC" (2 to 6 places).

### The page: `/o/<slug>/evidence/close-pack`

- Tab title and `metadata.title`: "Monthly close pack". The header crumb is Audit log, then Monthly close pack.
- `PageHead` title "Monthly close pack". Sub: "Every payment settled in the month, one row each: the bill, who approved
  it, what was checked, the transaction, and the signed entry that records it."
- Right: `DocsLink` to `/docs/guides/accountants#the-monthly-close-pack`, topic "the monthly close pack" (`print:hidden`).
- Callout when the month did not read: "That month could not be read, so this shows last month. Choose a month with the
  Month field."
- Callout when the page bucket is empty: "The close pack was read many times in a row. Try again in a minute."

Controls (`print:hidden`):
- A `get` form: field **Month** (`Input type="month" name="month"`), button **Show this month**.
- Links: **Last month**, **This month so far**, and the months either side, named by their label ("September 2026"),
  with `aria-label` "Previous month: September 2026" and "Next month: November 2026". No next link for this month.
- Buttons: **Print or save as PDF** (`PrintButton`), **Download CSV**, **Download signed JSON**.
- Under them: "Vestiarion records each download in the workspace's ledger with the file's SHA-256, so a copy can be
  matched to it later."

The print-only line (`hidden print:block`): "Vestiarion monthly close pack · <workspace> (<network label>) · <month
label>[ so far] · read <time>".

**Summary.** Heading: "October 2026", or "October 2026 so far". Then "Months are calendar months in UTC. A payment counts
in the month Circle confirmed it." Then five figures (`Eyebrow` and value):
- **Payments settled**: the count of on-chain rows.
- **Paid**: one line per token, "1,250.50 USDC"; "None" with no rows.
- **Route fees**: "0.42 USDC".
- **Not settled**: the count.
- **Signed entries verified**: "52 of 52".

Lines under them, each only when it applies:
- "<n> simulated payment(s), <amount>, listed apart: a sandbox's payments move nothing on chain."
- "<n> of these were made in shadow mode: each mirrors a bill the business paid its own way." (singular: "1 of these was
  made in shadow mode: it mirrors a bill the business paid its own way.")
- "Network fees are listed with each payment, with where each figure came from. They are not added up: a batch's fee
  belongs to the whole batch."
- "<n> payment(s) whose bill was deleted are not listed. The audit export holds their entries."
- Callout (held) when cut: "This month has more than 2,000 payments, so the pack shows the first 2,000. The audit export
  holds every entry."
- When members were not read: "Members could not be read just now, so people are named by the first 8 characters of
  their id."
- When a screening read failed: "Some screening records could not be read just now. Those payments say so."

**Payments** (`h2`). With none: `EmptyState` "No payment settled in October 2026", body "Payments appear here once
Circle confirms them on <network label>."

Each row is a card (`break-inside-avoid`). Its heading is the payee's name, with the amount on the right. Under it,
"Paid <time>", and badges where they apply: **Simulated**, **Shadow mode**, **Bank payout**. Facts (`dt` / `dd`):
- **Bill**:
  - "Invoice INV-2041, 1,250.00 USDC, due 2026-10-15"; with no number, "A bill of 1,250.00 USDC, due 2026-10-15";
  - a shadow-mode bill adds " (written as 1,250 EUR)";
  - a discount adds ". 25.00 USDC off for paying early";
  - a milestone reads: Milestone "Homepage redesign", 800.00 USDC.
- **Purchase order** (when there is one): the reference.
- **Document**:
  - "SHA-256 <hash>; the document itself is not kept.";
  - a vendor's adds "Sent by the vendor on <time>: SHA-256 <hash>.";
  - none: "No document is recorded."
- **Paid to**:
  - the address in full (mono, `break-all`), then "on <chain label>";
  - a bank payout: "Bank account 012 ending 4471, by SPEI, through BlindPay: 173.40 MXN";
  - simulated: "A simulated payee address: nothing was paid on chain."
- **Decided** (`decidedLines`):
  - "Claude decided to pay it." / "... in shadow mode.";
  - "The agent held it for a person: its purchase order or goods receipt was missing.";
  - "DeepSeek decided to hold it for a person.";
  - "The written policy flagged it for review.";
  - "Claude asked for more information before paying it.";
  - "Claude decided to release it." (a milestone);
  - "No decision of the agent's is recorded.";
  - a verdict: "owner@pinecrest.test agreed with the agent's decision in shadow mode on <time>." (or "disagreed").
- **Approved** (`approvedLines`):
  - the agent paid it: "No person approved it: code checked it and the agent paid it.";
  - "Co-signed by accountant@firm.test (accountant) on <time>";
  - "Approved by approver@pinecrest.test (approver) on <time>, from Telegram";
  - "Approved and paid by owner@pinecrest.test (owner) on <time>";
  - and, as recorded: "Paid by the workspace's only approver.", "The person who gave the address made its first payment,
    as the workspace's only approver.", "Approved by whoever entered it or gave its address, as fewer than two others
    could approve.", "The first payment to this address."
- **Address** (`addressLines`):
  - "Given by <who> on <time>", or "Sent by the payee through their payee link on <time>", or "Given by the payee on
    GitHub (<login>) on <time>", or "A mirror address Vestiarion made in shadow mode: no person typed it.", or "No entry
    names who gave it.";
  - "Confirmed by <who> on <time>, with Confirm address" (or ", by approving a payment to it"), or "Not confirmed before
    it was paid.";
  - "A second person stood behind it: Yes" (or "No", or "Not known").
- **Checks**: one line each, a label in words with its icon (`EvidenceLabel`, and a neutral **Does not apply** badge)
  then the sentence, its notes under it. The six check names: **Guardrails**, **Screening**, **OFAC address list**,
  **Payee lock**, **Invoice's own address**, **Milestone**. The sentences, by case:
  - guardrails: "Code checked it before it was sent." / "The agent held it: <rule words>. A person decided to pay it." /
    "The agent held it for a person. A person decided to pay it." / "No decision of the agent's is recorded."
  - screening: "<Payee> was screened clear by OpenSanctions." / "<Payee> was screened <risk> against the bundled list,
    not a screening service." / "<Payee>'s payout address is on OFAC's SDN list." / "<Payee> was <risk> as the agent's
    decision recorded; no screening check is on file." / "<Payee> was not screened before it was paid." / "The
    screening record could not be read just now."
  - OFAC address list: "Its payout address was not on OFAC's SDN list when it was paid: every screening and payment
    checks it." / "Its payout address is on OFAC's SDN list." / "Paid before Vestiarion checked payout addresses
    against OFAC's SDN list." / "A bank payout pays no address on chain." / "A simulated payment pays no address."
  - payee lock: "The payee lock was on when the address was confirmed, with a 24-hour wait. It was sent 30 hours after
    the address was given." / "The payee lock was on when the address was confirmed, with no wait." / "It was sent
    before the payee lock's 24-hour wait had ended." (the wait in force when it was sent) / "The payee lock was on when
    the address was confirmed, with a 48-hour wait; <who> turned it off on <time>. It was sent 3 hours after the address
    was given." (or "removed its wait", or "cut its wait to <N> hours") / "The payee lock was off when the address was
    confirmed." / "No confirmation of this address is recorded before it was paid." / "The address paid is not the one
    the ledger last recorded for this payee." / "The payee lock covers addresses on chain only."
  - invoice's own address: "The address its document asked to be paid to is the one paid." / "Its document asked to be
    paid to <address>; a person chose to pay the address on file." / "The bill's document named no address of its
    own." / "A milestone has no invoice document."
  - milestone: "GitHub reported pull request acme/app#12 merged." / "Asana reported the task completed, and <who>
    accepted the work against its criteria." / "The work was verified by hand by <who>." / "Sample data: marked
    verified as an example." / "The work was not verified before it was paid." / "A bill has no milestone to verify."
- **Transaction** (`transactionWords`, then the hash written out in full, so a printed copy keeps it):
  - "Transfer on Arc testnet" (the chain's label);
  - "Minted on Base Sepolia, through CCTP from Arc testnet", with "Burn on Arc testnet: <hash>";
  - "From a Circle Gateway balance, minted on <chain>";
  - "Released from escrow on Arc testnet";
  - "Bank payout through BlindPay";
  - "Simulated: nothing moved on chain (sim_…)".
  - Then the link **View on the explorer** (new tab, `rel="noreferrer"`, with "(opens in a new tab)" for screen
    readers), and "Network fee: 0.004 USD, as the chain reported it" (or "as Circle estimated it", "simulated"),
    "Route fee: 0.12 USDC", and "Paid on its 2nd attempt" when earlier attempts ended.
- **Books** (`booksWords`):
  - "Marked paid with this transaction." / "Circle confirmed it, but the bill is not marked paid." / "The bill is marked
    paid with another transaction." / "No signed entry names this transaction.";
  - plus "Booked in Xero (payment 1a2b3c4d…)", "Sent to Xero", or "Not booked in Xero yet".
- **Signed entry** (`recordWords`): "#5619 approval_paid, signed with key 1a2b3c4d5e6f7a8b: Verified" / ": Not
  verified: <reason>" / ": Not checked here: <reason>" / "No entry records this payment's transaction."
- **Every entry it rests on**: "#5601 #5612 #5619" (mono).
- A link, `print:hidden`: **Open the payment's evidence**.

**Not settled in October 2026** (`h2`, only when there is one). Intro: "Payments sent in the month that Circle did not
confirm in it. They are not in the totals." Each line names the payee, the amount and the state (`openStateWords`), then
**Open the payment's evidence**:
- `settled_later`: "Sent on <time>, settled on <time>: it counts in November 2026's pack."
- `waiting`: "Waiting to be sent."
- `in_flight`: "Sent on <time>, not confirmed yet."
- `unknown`: "Outcome unknown: Circle did not answer when it was sent, so it may have taken the transfer."
- `gateway_failed`: "Gateway reported it failed, but it may still be minted on the payee's chain."
- `failed`: "The transfer failed (<state: reason>). The payee was not paid."
- `cancelled`: "Circle cancelled the transfer. The payee was not paid."
- `not_sent`: "Not sent: it stopped before Circle took the transfer (<error>). The payee was not paid."
- `refunded`: "BlindPay refunded the bank payout, so the USDC came back. The vendor was not paid."

**Escrow** (`h2`, only when there is one). Intro: "Money locked for a milestone, or taken back from escrow, in the month.
A lock pays no one, so neither is in the totals; a release that paid the contractor is a payment above." Lines:
- "Locked 500.00 USDC in escrow for "Homepage redesign" on <time>";
- "Refunded 500.00 USDC from escrow to the workspace on <time>";
- each with **View on the explorer** when it has a transaction.

Foot line: "<verified> of <cited> signed ledger entries this pack cites verified against the workspace's keys. The signed
JSON carries each of them with the public keys, so anyone can check them offline."

### The route: `GET /api/evidence/close-pack`

| Case | Status | Body |
|---|---|---|
| `sec-fetch-site: cross-site` | 403 | "Download the close pack from the workspace." |
| Signed out | 401 | "Sign in to download this close pack." |
| `format` not `csv` or `json` | 400 | "format must be csv or json" |
| Bad or future `month` | 400 | "month must be YYYY-MM, and not a month still to come" |
| Not a member, or no such workspace | 404 | "Not found" |
| Downloads sent at once past the burst bucket (`takeClosePackDownloadToken`) | 429, `retry-after: 60` | "Too many close pack downloads in a row. Try again in a minute." |
| Ten downloads in ten minutes | 429, `retry-after: 600` | "Too many close pack downloads in the last 10 minutes. Try again later." |
| A read failed | 500 | "The close pack could not be read." (logged without detail) |

A good answer has `content-type` `text/csv; charset=utf-8` or `application/json; charset=utf-8`, `content-disposition:
attachment; filename="<closePackFileName>"`, `cache-control: no-store` and `x-content-type-options: nosniff`. With no
`format` it answers JSON; with no `month`, last month.

The entry's summary: "Close pack for October 2026 downloaded as CSV: 14 payments settled, 2 not settled".

### Elsewhere

- **Audit log**: a link **Monthly close pack**, beside **Docs** and the audit export menu, to
  `orgHref(slug, "/evidence/close-pack")`.
- The accountant console: under each card's **Hand-off:** line, a second line "Close pack:" with last month's label
  ("Sep 2026") and **This month so far**, linking to the page with `?month=`.

## Roles and access

| What | Who |
|---|---|
| Open the page, print it, download its CSV and signed JSON | Every member: owner, admin, approver, accountant, viewer (`workspace.read`) |
| See it in the accountant console | Anyone with a membership in the workspace; each card links only its own workspace |
| See members' emails in it | The same members, who already see them on the evidence pages and the audit log |
| Reach it signed out, or as a non-member | No one: 401, or the 404 of a workspace that does not exist |

## Failure and edge cases

- **A month with nothing settled**: the empty state. The downloads still work: a CSV with its header alone, a JSON with
  empty `rows`.
- **This month**: "so far", `ended: false`, and the file name says `-so-far`.
- **A payment retried across months**: it failed in September and paid in October. In September's pack it is
  `settled_later`; in October's it is a row with `earlierAttempts: 1`.
- **Confirmed with no recording entry** (Circle's notification confirmed it, and the entry was not written): `record`
  null, and the books say "No signed entry names this transaction."
- **An entry signed by a retired key** verifies with the retired key (`exportKeys` carries both). An unknown key is not
  checked here, and a tampered entry is not verified: both are counted and named on the row.
- **A CCTP payout confirmed before its mint is recorded**: no transaction hash, `note` "The payee's chain has not minted
  this payout yet."
- **A sandbox that went live**: a payment made before going live keeps `provider_mode` `simulate` and is simulated.
- **A workspace on Arc mainnet**: the same, with Arc mainnet's explorer and label from its profile.
- **EURC payments** total apart from USDC.
- **A deleted bill**: counted in `withoutBill`, not listed (CP2).
- **A member who left**: "a former member (1a2b3c4d)".
- **Members or screening not read**: the rest shows, and the page says which (`unread`).
- **Before 0136**: the pay-to check does not apply.
- **More than 2,000 payments**: `cut`, and the callout.
- **Two reads at once**: each is read for its request. Nothing is cached, so no one sees another workspace's pack.

## Security and privacy

- **Tenancy.** Reads go through the workspace's tenant client only (`db()`), so row-level security confines them even
  if a filter were wrong. The route re-reads the membership on every request. The accountant console builds each link
  from the person's own memberships.
- **Prompt injection.** No model reads or writes anything here. Text that came from outside (a vendor's name, an invoice
  number a model read from a PDF, a memo, a PO typed on a document request page) is shown as text only: escaped by
  React, guarded by `csvCell` in the CSV (a leading `=`, `+`, `-`, `@`, tab or carriage return, also after whitespace),
  carried as data in the JSON, and cut to 200 characters for a memo. Nothing in the pack is an instruction to anything.
- **Untrusted files.** No file is opened, read or served. Documents are named by the SHA-256 their entries signed. No
  storage address is put in a page or a file.
- **Links.** Only two kinds are built:
  - explorer links, from the chain profile's `explorerTx` and a hash checked as `0x` plus 64 hex digits;
  - evidence paths, from `orgHref` and a source id.
  A link a person or a payee gave (a pull request, a verification source) is never linked from the pack.
- **Who sees what.** Members' emails and roles, payees' names and full payout addresses (public on chain anyway), bank
  codes and the last 4 digits only (the full account is never stored), amounts and reasoning-free checks. The guide says:
  "The files name members by email and payees by name, as the page does: share them with whoever should see that."
- **Keys.** The file carries public keys only (`exportKeys`). No secret, token or receipt link is read.
- **The ledger entry** names the person by id, never by email, and holds counts, the month and a hash: nothing a
  webhook endpoint should not see.
- **Privacy and security pages**: no new data is collected, no new processor, no new storage, no public route. They do
  not change, and their pinned dates stay.

## No migration

Nothing to apply (CP19). The next free number stays 0144 (Exception resolution part 2), then 0145 (Google Sheets).

## Not in this change

- `GET /api/v1/close-packs/{month}`, its OpenAPI operation, Zod schema, examples, Postman, MCP tool and SDK 0.4 (CP18).
- The Google Sheets export.
- A workspace time zone (CP1).
- A PDF made on the server: the print dialog makes it.
- Reading the chain for each row: the evidence page does it for one payment.
- Bills marked paid without a payment, receivables, treasury moves, payments made outside in shadow mode (CP5).
- The accountant's onboarding step "Download the month's hand-off" stays the hand-off; a close pack download does not
  tick it.
- New indexes (CP19).

## Tests (write these first)

`tests/close-pack-month.test.ts`
- reads `2026-10` as from 2026-10-01 to 2026-11-01, "October 2026", key `2026-10`; December runs to January of the next
  year;
- opens on the last full month with none: 2026-10-25 gives September 2026; 2026-01-03 gives December 2025;
- takes this month so far, which has not ended, while September has;
- refuses a month to come, one before 2020, and `2026-13`, `2026-1`, `202610`, `2026-10-01`, ` 2026-10`;
- names the months either side, with no next month past this one and no previous month before 2020;
- falls back to last month, saying so, for a value given twice or one that does not read (`closePackMonthFrom`);
- keeps the hand-off's month equal to the close pack's for each of those inputs (`handoffPeriod`).

`tests/close-pack-build.test.ts` (pure; entries built like the payee lock pack's tests)
- CP2: one row per payment confirmed in the month, oldest first; a payment confirmed before or after it is no row; each
  intent is a row of exactly one month across three months;
- CP3: confirmed after the month is `settled_later` naming the month it counts in; `waiting`, `in_flight`, `unknown`,
  `gateway_failed`, `failed`, `cancelled` and `not_sent`, each with Circle's reason; a BlindPay refund is `refunded`;
- CP2: a payment whose bill is gone is counted, not listed; a receivable source is skipped;
- CP6: totals per token, never USDC plus EURC; `"0.1"` plus `"0.2"` is `"0.300000"`; simulated rows apart; shadow rows
  counted; route fees summed, network fees not; a discounted bill pays its `paid_amount` and shows the difference;
- CP7:
  - an agent-paid bill: Claude decided, `authorizedBy` code, no approvals;
  - a bill held for two approvals: the accountant's co-sign (its `approval_given` seq, `cosign: true`) and then the
    approver's payment (`paid: true`), each with its role now;
  - one approval from Telegram;
  - the sole approver, address giver and few approvers flags;
  - a shadow-mode verdict on the decision;
  - a milestone released by the agent, and one paid now by a person;
  - a member by email, a former member by id, and with `people: "id"` no email anywhere in the pack;
  - an approval that only recorded a transfer the agent's `ap_pay` sent ("matched", or "held" with no `heldBecause`):
    `authorizedBy` code, no approvals, "Code checked it before it was sent.", "No person approved it: code checked it
    and the agent paid it.", the record still the `approval_paid`; the same for a CCTP payout whose late mint an
    `ap_reconcile` held and an approval recorded, and by the ledger alone for an intent with no `submitted_at`; an
    approval that sent it again with `retriedAfter`, at or after the intent's `submitted_at`, is the person's;
- CP7, the address: given by one member and confirmed by another with Confirm address is a second person; the same
  member is not; a payee link with the lock off is not known; a mirror address; a bank payout has none;
- CP8:
  - guardrails: the decision's lines as `decisionChecks` words them; a held bill names its rule in words; no decision
    is `missing`;
  - screening: a live provider `verified` naming OpenSanctions; the bundled list `checked`; `ofac-sdn` `contradicted`
    with a warning; a risk only the decision recorded `inferred`; none `missing`; unread `unreachable`; the check read
    is the one at or before the decision (`screeningAnchors`);
  - OFAC address list: after `walletListSince` `checked`; before it `missing`; listed `contradicted`; a bank or
    simulated payment does not apply;
  - payee lock: on with a wait and sent after it `checked`, with the hours; sent before it `contradicted`; off
    `inferred`; no confirmation `missing`; another address last recorded `contradicted`; a bank payout does not apply;
    the lock turned off, or its wait removed, between the confirmation and a payment sent 3 hours after the address was
    given, `stated` with a warning, citing the change, which the pack carries; the wait cut from 48 to 24 hours and paid
    3 hours after, still `contradicted`; a change after the paying entry or before the confirmation is not read;
  - pay-to: the same address `checked`; another `stated` with a warning; none, a bank payout or a milestone does not
    apply;
  - milestone: GitHub merged `verified`, naming the pull request as text and never as a link; by hand `stated`; sample
    `inferred`; unverified `missing` with a warning; a bill does not apply;
- CP9:
  - direct, with Arc's explorer from the profile;
  - CCTP: the mint on Base Sepolia with its explorer, the burn as source, the route fee;
  - Gateway, an escrow release, a bank payout (bank code and last 4 only) and a simulated payment (its `sim_` ref, no
    link);
  - no link for a value that is not a 32-byte hash;
- CP10:
  - the newest entry recording the transaction, with its signature, key id and check;
  - a reconcile that recorded it later is the record, and the paying entry is the decision before it;
  - no entry: `record` null and the books say so;
  - confirmed but not marked paid;
  - booked in Xero;
- CP4: escrow locks and refunds in the month are listed apart and not totalled;
- entries:
  - every cited entry once, oldest first, in full, and no other;
  - each row lists what it cites;
  - without `checks` each is "Not checked yet."; with them, `totals.entries` adds up;
- invoice facts: the number, its own and under Xero's name; the document's SHA-256; a vendor's document; a shadow-mode
  bill's written amount; the PO; a memo cut at 200 characters;
- `cut` and `unread` pass through.

`tests/close-pack-export.test.ts`
- the document:
  - format, `exportedAt`, workspace, the network's label from its profile, the month with `ended`;
  - labels for all eight kinds, `signedEntryProves`, `checkAnEntry` equal to `CHECK_AN_ENTRY`, the keys;
  - entries in snake_case with their check;
  - evidence URLs made absolute with the origin;
- `closePackJson` is `JSON.stringify(closePackDocument(...), null, 2)`, and the document survives a JSON round trip
  unchanged (no `undefined`, no `Date`);
- the table:
  - its columns are exactly `CLOSE_PACK_COLUMNS` (an inline snapshot), one row per settled payment in order;
  - check cells read "Verified outside: ...";
  - approvals join with `; `, entries with a space, and the signature column holds the signature;
- the CSV:
  - a byte-order mark, CRLF lines, the header;
  - a payee named `=HYPERLINK("x")`, an invoice number `+1` and a memo `@SUM(A1)` come out prefixed with `'`, with
    commas and quotes kept safe;
  - an empty month is its header alone;
- file names: `vestiarion-close-pack-pinecrest-studio-2026-10.csv`, `-so-far` for a month not ended, unsafe slug
  characters dropped.

`tests/close-pack-read.test.ts` (with `tests/support/fake-supabase`)
- reads the month's payments by when they were confirmed, created or sent, a page of 1000 at a time, in the workspace's
  scope;
- asks for bills, payees and entries a hundred ids at a time (`[100, 50]` for 150 ids);
- reads each settled payment's screening check at or before its decision, at most ten at once;
- reads the month's escrow moves, the first sweep that checked the address list, and the head;
- checks only the cited entries, with the active and the retired key;
- works before 0136: a `42703` on `document_pay_to` makes the pay-to check not apply, and nothing else changes;
- names people by id when `org_members` fails, and says `members` is unread;
- a screening read that fails marks those payments `unreachable`, and the others show;
- reads the workspace's slug and name from `orgs` when none is given, the API key's path, inside `withOrg` only;
- stops at 2,000 payments and marks the pack cut;
- writes nothing: no insert, update, upsert, delete or `append_ledger_entry`.

`tests/close-pack-route.test.ts`
- refuses a cross-site request before reading anything; asks someone signed out to sign in;
- refuses a bad format, and a malformed or future month, before looking the workspace up;
- answers a non-member 404;
- gives a member the JSON with its name and headers, and the CSV with its byte-order mark;
- records one `close_pack_exported` whose `sha256` is the SHA-256 of the bytes it served, with `month`, `ended`,
  `format`, the counts and `headSeq`, and no email;
- the eleventh download in ten minutes answers 429 with `retry-after: 600`, counted from the ledger;
- six downloads sent at once, each counting the same nine earlier ones, answer three files and three 429s with
  `retry-after: 60`, the read run three times; the bucket's token is taken only after the session, format and month
  checks;
- a failed read answers 500, records nothing and names nothing of why;
- a refused append still serves the file.

`tests/close-pack-page.test.tsx` (`renderToStaticMarkup` of `ClosePackView`, and the page's source)
- the figures, the simulated, shadow and fee lines, the cut and unread callouts;
- a row's facts: the bill, paid to, decided, approved with a co-sign, the address, each check with its words, the
  transaction written out with its explorer link opening in a new tab, the signed entry verified and not;
- the not-settled words for every state, and the escrow lines; the empty month;
- the downloads' addresses carry `org` and `month`; the month links, with no next link for this month;
- the print line, the controls and the evidence links `print:hidden`, the cards `break-inside-avoid`;
- the page reads through `takeClosePackPageToken`, says when it is out of reads, says when the month did not read, and
  its title is "Monthly close pack".

Existing tests to extend:
- `tests/navigation.test.ts`: the subpage table gets `["/o/acme/evidence/close-pack", "audit", "Monthly close pack"]`;
  the nested page check finds the page on its own.
- `tests/access-gates.test.ts` finds the page on its own; nothing to add.
- `tests/docs-links.test.tsx`: `SECTIONS` gets the page and `/docs/guides/accountants#the-monthly-close-pack`.
- `tests/mainnet-copy-pages.test.tsx`: `PAGES` gets `evidence/close-pack`.
- `takeClosePackPageToken` is tested in `tests/close-pack-page.test.tsx`: ten page reads at once, then one every 6
  seconds, per member. `takeClosePackDownloadToken` is tested in `tests/close-pack-record.test.ts`: three downloads at
  once, then one a minute, per member, apart from the page's reads.
- `tests/close-pack-read.test.ts`: the workspace's `payee_lock_changed` entries are read up to the month's end, a page
  at a time by `seq`, and one that eased the lock before a payment is cited and checked.
- `tests/audit-export-ui.test.tsx`: the Audit log page links `orgHref(slug, "/evidence/close-pack")`.
- `tests/accountant-console-close-pack.test.tsx` (new): each card's "Close pack:" line links last month and this month
  so far for its own slug.
- `tests/docs-guides.test.ts`: the accountants guide's new quoted rows (below).
- `tests/accountant-handoff-build.test.ts` and `tests/payee-lock-evidence.test.ts` pass unchanged.

## Docs and lists to update

- `CHANGELOG.md`, `[Unreleased]` > `### Added`: "**Monthly close pack.** One page per workspace and calendar month (UTC)
  lists every payment Circle confirmed in it, one row each: the bill with its invoice number and document, who decided
  and approved it (an accountant's co-sign and the address's second person included), what was checked (guardrails,
  screening, OFAC's list of addresses, the payee lock, the invoice's own address, a milestone's verification), the
  transaction with its explorer link, and the signed ledger entry that records it, verified against the workspace's
  keys. Payments not settled in the month and escrow moves are listed apart, and totals keep each token apart.
  **Print or save as PDF**, **Download CSV** and **Download signed JSON**; each download is recorded in the ledger as
  `close_pack_exported` with the file's SHA-256. Open it from the **Audit log** or the accountant console. No
  migration."
- `content/docs/changelog.mdx`, newest first: "## 2026-10-25: The monthly close pack", one bullet: "A new entry, actor
  `human`, domain `system`, listed by `GET /api/v1/ledger` and sent to webhook endpoints as `ledger.appended`:
  **`close_pack_exported`** `{ by, month, ended, format, payments, notSettled, sha256, headSeq }`, when a member
  downloads a workspace's close pack for a month. `month` is YYYY-MM; `ended` is false for a month still running;
  `format` is `csv` or `json`; `payments` and `notSettled` count its rows; `sha256` is the SHA-256 of the file served,
  in hex; `headSeq` is the ledger's last entry when it was read. It names no one by email. Nothing else in `/api/v1` or
  the webhooks changes."
- `ARCHITECTURE.md`: a new section "## The monthly close pack" after "## The accountant console": the modules, the
  reader's queries and two builds, the rules CP1-CP19 in a paragraph each at most, `close_pack_exported` and its brake,
  and that `handoffPeriod` delegates to `closePackMonth`.
- `content/docs/guides/accountants.mdx`: "### The monthly close pack" under "## 5. Hand a month over". It covers:
  - who may open it; where it opens from; the month and UTC;
  - what each row shows, and that the role beside a name is the one the person holds now;
  - the checks' words, the totals, and what is not settled; what the pack leaves out (CP5);
  - the three downloads; the ledger entry and its brake;
  - checking the JSON offline: the evidence pack's steps, with `verifyLedgerEntry` and the snake_case to camelCase
    names;
  - "The files name members by email and payees by name, as the page does: share them with whoever should see that."
  - It contains "Arc testnet" and no disclaimer.
- `tests/docs-guides.test.ts`, the guide's quoted rows. Each points at the file that writes the string, with a fragment
  where the source builds it:
  - "Monthly close pack" (the page);
  - "Show this month", "Last month", "Download CSV", "Download signed JSON", "Not settled in" (`ClosePackView`);
  - "Print or save as PDF" (`PrintButton`);
  - "Close pack:" (`AccountantConsole`);
  - "Does not apply", "Co-signed by", "A second person stood behind it", "No person approved it: code checked it and
    the agent paid it." (`words.ts`);
  - "The close pack was read many times in a row. Try again in a minute." and "That month could not be read, so this
    shows last month. Choose a month with the Month field." (the page);
  - "Too many close pack downloads in the last 10 minutes. Try again later." and "Sign in to download this close pack."
    (the route);
  - `close_pack_exported` (`src/lib/close-pack/record.ts`) and `vestiarion-close-pack/1` (`types.ts`).
- `content/docs/guides/audit-export.mdx`: one sentence: "For one month's payments in a spreadsheet, each with its signed
  entry, see [The monthly close pack](/docs/guides/accountants#the-monthly-close-pack)."
- `README.md`, the **Audit** feature line: "..., and a monthly close pack: one row per payment with its bill,
  approvals, checks, transaction and signed entry, as a page, a CSV or signed JSON."
- The screenshot:
  - `accountants-close-pack` in `DOCS_SHOTS` (`src/app/docs-shots/shots.tsx`, page `audit`, `ClosePackView` with a
    made-up pack of three rows: agent-paid, co-signed and CCTP, plus one `settled_later`) and in `SHOTS`
    (`scripts/docs-screenshots.mjs`);
  - `public/docs/guides/accountants-close-pack.png`: 1520 px wide, under 250 KB, shown once in the accountants guide
    through `<Screenshot>`, with alt text and a caption.
- Lists: `SUBPAGES` in `src/components/vx/nav.ts`, `{ pattern: /^\/o\/[^/]+\/evidence\/close-pack(?:\/|$)/, section:
  "audit", label: "Monthly close pack" }`.
- No change to the OpenAPI document, the SDK or its version, Postman, the MCP tools, the privacy, security or terms
  pages and their dates, `SUBPROCESSORS`, the CSP, or `.env.example`.

## Implementation order (one PR, TDD)

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` and `route.md` first (AGENTS.md):
`params` and `searchParams` are Promises; a route handler is `GET(request: Request)`; keep
`export const dynamic = "force-dynamic"`; do not turn on `cacheComponents`.

1. Commit this spec: "Add the design for the monthly close pack".
2. `tests/close-pack-month.test.ts`, then `month.ts`, then `handoffPeriod` delegating. Run the hand-off tests.
3. `types.ts`. Export `secondPersonOf` (payee-lock-evidence.ts) and `pullRequestName` (evidence-chain.ts).
4. `tests/close-pack-build.test.ts`, then `build.ts`, reusing:
   - `settlementOf`, `booksOf`;
   - `intentFacts`, `recordingEntry`, `invoiceNumberInDetail`;
   - `decisionChecks`, `deciderName`, `ruleWords`;
   - `bookingFromEntries`, `providerOfSource`, `PROVIDER_NAMES`, `chainById`, `homeChain`, `networkProfile`.
5. `words.ts`, driven by the build and page tests.
6. `tests/close-pack-export.test.ts`, then `export.ts`.
7. `tests/close-pack-read.test.ts`, then `read.ts`.
8. `takeClosePackPageToken`; `tests/close-pack-route.test.ts`, then `record.ts` and
   `src/app/api/evidence/close-pack/route.ts`.
9. `tests/close-pack-page.test.tsx`, then `src/components/ClosePackView.tsx` and
   `src/app/o/[slug]/evidence/close-pack/page.tsx`; the `SUBPAGES` row and the navigation, docs-links and mainnet-copy
   rows.
10. The Audit log link and the accountant console line, with their tests.
11. The docs-shots entry and `npm run docs:screenshots` for the one image (Edge, Windows).
12. The docs: guide and its quoted rows, CHANGELOG, changelog.mdx, ARCHITECTURE, README, audit-export. Grep for stale
    text, and for local paths before the PR.
13. `npm run verify`, then `npm run build`. Rerun `tests/ui-consistency.test.ts` and `tests/security-page.test.tsx`
    alone if they time out in the full run.
14. Commits: "Build the monthly close pack from the month's payments and their signed entries", "Show the monthly close
    pack, its downloads and its links", "Document the monthly close pack". Then the PR.

## How to prove it on prod

On pinecrest-studio, live on Arc testnet, after the merge deploys:

1. Reload any open app tab (skew protection pins old tabs to the old deployment).
2. Open `https://www.vestiarion.xyz/o/pinecrest-studio/evidence/close-pack?month=2026-10` as a member. It reads "October
   2026 so far" until November 1.
3. Compare **Payments settled** and **Paid** with a read-only count:
   `select count(*), sum(coalesce(i.paid_amount, p.amount)) from payment_intents p left join invoices i on
   i.id = p.source_id and p.source_type = 'invoice' where p.org_id = (select id from orgs where slug =
   'pinecrest-studio') and p.status = 'confirmed' and p.confirmed_at >= '2026-10-01' and p.confirmed_at < '2026-11-01'`.
   The count and total must match, simulated rows apart.
4. Find the payment co-signed live on Oct 23. It reads "Co-signed by ... (accountant)", then "Approved and paid by
   ...", and its two entries match the **Audit log**.
5. Find a bill paid early under an early-payment offer, if the month has one. Its bill line names the discount.
6. On any row:
   - **View on the explorer** opens explorer.testnet.arc.io at the same hash and amount;
   - the **Signed entry** number and hash match the **Audit log**'s entry;
   - it reads Verified.
7. **Download CSV**:
   - it opens in Excel on Windows as UTF-8, with no formula warning, one row per settled payment;
   - the **Audit log** shows a new `close_pack_exported`;
   - `Get-FileHash -Algorithm SHA256` of the file, in lowercase, equals its `sha256`.
8. **Download signed JSON**: `format` is `vestiarion-close-pack/1`. Take one entry, rename `body_hash`, `prev_hash` and
   `signing_key_id` to camelCase, and run `verifyLedgerEntry` from `@vestiarion/sdk` with the file's keys: true.
9. **Print or save as PDF**: the sidebar, controls and buttons are gone, the print line is there, and rows do not split.
10. The accountant console: pinecrest-studio's card shows "Close pack:" with Sep 2026 and **This month so far**.
11. A viewer member opens it; an account that is no member gets "not found". An eleventh download within ten minutes
    answers "Too many close pack downloads in the last 10 minutes. Try again later."
12. Downloads started in several tabs at once: three are served, and the rest answer "Too many close pack downloads in a
    row. Try again in a minute."
13. A payment the agent sent that a person's approval only recorded later, if the month has one (its **Audit log**
    shows `ap_pay` naming the hash, then `approval_paid` naming the same hash): it reads "No person approved it: code
    checked it and the agent paid it.", as its evidence page's settlement track names the agent.
