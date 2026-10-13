# Receipts and collection status back to the CRM

Date: 2026-10-13. Status: decided (autonomy grant 2026-10-05). Roadmap: F05, with I17 (receipts and notices say what
is known, and who verified it). Builds on the HubSpot connector (`2026-10-12-hubspot-connector-design.md`, H1-H21),
deals (`2026-10-12-deal-schedule-design.md`), allocations (`2026-10-12-allocations-design.md`) and the Xero write-back
(`2026-10-12-accounting-writeback-design.md`, W1-W12), whose reality rule and send-then-read-back this follows.
Pictures: `crm-receipts-shots/`, from the flag-gated `/docs-shots/crm-receipts/<state>` (`DOCS_SCREENSHOTS=1`).

## Why

Sales sees the deal stage in HubSpot and still asks finance whether the customer paid. Vestiarion knows, the moment a
payment arrived on Arc and was applied to one of the deal's invoices. It writes that back to the deal it was planned
from, and says on the deal what it wrote and when.

## What HubSpot offers, as of October 2026

- **Deal properties** (`POST /crm/properties/2026-03/deals`, `…/deals/groups`, `…/deals/batch/read`): a property has a
  `name`, `label`, `groupName`, `type` (`number`, `string`, `date`, `enumeration` …), `fieldType` and, for an
  enumeration, `options`. Making a property or a group needs a schema scope (`crm.schemas.deals.write`); reading the
  definitions takes `crm.objects.deals.read`, which every connection has.
- **A deal's values**: `GET /crm/objects/2026-03/deals/{id}?properties=…` (`crm.objects.deals.read`); `PATCH` the same
  path with `{ properties }` (`crm.objects.deals.write`). No conditional write (no `If-Match`, no version): a change
  between a read and a write cannot be refused by HubSpot itself.
- **Notes on the timeline** need `crm.objects.contacts.write` (a wider scope than deals) and hold no field to compare: a
  note cannot tell Vestiarion that a person changed what it wrote. Rejected.
- **The account** (`GET /account-info/2026-03/details`, scope `oauth`): `accountType` is `STANDARD`, `DEVELOPER_TEST`,
  `SANDBOX` or `APP_DEVELOPER`.
- **Optional scopes**: an authorize URL may ask for the app's optional scopes (`optional_scope`); HubSpot drops one the
  account cannot grant and installs with the rest. The token answer lists the scopes granted.

## Decisions

**R1. What a deal collected, and only that.** (`dealCollection`, pure, `src/lib/connectors/crm-receipts.ts`)
- Collected: money that arrived on Arc and was applied to one of the deal's receivables. An incoming payment is recorded
  only once Circle reports it complete (`incoming_transfers`); it counts when matched whole (0050, the receivable's
  amount) or by a live allocation (0103, a reversal undoes its row). Nothing submitted, pending or promised counts.
- Still owed: invoiced (receivables made from the deal's lines, not rejected) less collected and less any fee a person
  marked. A part payment is partial: the rest of that invoice is still owed. A fee settles an invoice and is never
  collected. Lines not invoiced yet are not owed yet; the status says so.
- An invoice marked received with no payment on Arc behind it (sample history) is not counted, and the reconciliation
  says **Needs review**.
- In the deal's currency: a shadow-mode invoice kept in it is converted at its own rate (`original_amount / amount`);
  one in a currency the deal cannot be told in is left out.
- Collection status: Paid in full, Paid to date (nothing owed, lines still to invoice), Partly paid, Overdue, Awaiting
  payment, Nothing invoiced yet. Reconciliation: Reconciled, Needs review, No receipts yet.
- One figure: the deal's page (Paid, Outstanding) and the Deals list read the same collection (`src/lib/deals/collection.ts`,
  `collection-read.ts`), so HubSpot never says other than Vestiarion. Cost if wrong: never higher than what arrived.

**R2. Fields Vestiarion owns, in a group of its own.** A property group `vestiarion` ("Vestiarion"), made once per
account, with nine deal properties: `vestiarion_collected`, `vestiarion_still_owed`, `vestiarion_currency`,
`vestiarion_collection_status` (enumeration), `vestiarion_last_receipt_date` (date), `vestiarion_last_receipt_amount`,
`vestiarion_last_receipt_link` (the transaction on Arc's explorer), `vestiarion_reconciliation` (enumeration) and
`vestiarion_evidence_link` (the deal's page in Vestiarion). Each description says it is written by Vestiarion. HubSpot's
own fields (amount, stage …) are never written. A property of one of these names with another type is someone else's:
never changed, and nothing is written. Cost if wrong: a field renamed by a later migration of the group.

**R3. Opt-in, the smallest scopes, and revoking stops it.**
- Scopes: `crm.objects.deals.write` (the values) and `crm.schemas.deals.write` (the group and properties, once). Both are
  optional in `integrations/hubspot/src/app/app-hsmeta.json`, asked for only when the person ticks **Write receipts to
  HubSpot** on the connect page, which an owner or admin reaches from **Allow writing to HubSpot** on the card
  (`?write=1`). The signed state carries the choice; the callback turns writing on once HubSpot granted both
  (`writing`), or says it did not (`write_not_granted`) and the connection keeps reading.
- The switch: `accounting_connections.writes_on`, `writes_by`, `writes_at` (0107), only for a HubSpot connection. **Write
  receipts to HubSpot** and **Stop writing to HubSpot** on the card (`crm.receipt_writes`, `integrations.manage`, owner
  or admin, the console only); on needs both scopes. Signed `crm_receipt_writes_changed`.
- Revoking: disconnecting turns the switch off in the same update (`accounting_connections_writes_off`); a connection
  that needs reconnecting, or lacks a scope, sends nothing (`writeGate`); a token HubSpot refuses fails the write with
  "allow writing to HubSpot again". A reconnect from the card keeps the write scopes asked for while writing is on.
- Consent `hubspot-2026-10-13` says what is written and the reality rule; `hubspot-2026-10-12` said it writes nothing,
  and a connection keeps the version it agreed to until it connects again. Terms and privacy say the same.
- Cost if wrong: one more press to allow writing.

**R4. The reality rule, as the Xero write-back's.** Payments on Arc mainnet outside shadow mode moved real money: any
account. Payments on Arc testnet, and in shadow mode, are written only to an account HubSpot itself calls a test one
(`DEVELOPER_TEST`, `SANDBOX`); any other, a trial included, is refused with "Not written: payments on Arc testnet and in
shadow mode are written only to a HubSpot developer test account or sandbox, never to a real HubSpot account." The
account is read right before each run's sends; an account not read, or one HubSpot names no type for, neither writes
nor refuses (a refusal is final, and says the account is a real one). The database holds it too: a write reaches
`sending`, `sent` or `written` only for Arc mainnet outside shadow mode, or with `account_test` true, which it takes
only beside HubSpot's own `DEVELOPER_TEST` or `SANDBOX` (`crm_receipt_writes_account_test_check`); and as a write is
queued, its network is the workspace's (`crm_receipt_writes_network`, security definer as
0075's) and shadow is set whenever the workspace is in shadow mode or one of the deal's invoices keeps an original
currency. Only ever stricter. Cost if wrong: a write refused that could have gone.

**R5. The outbox, and conflicts.** (`crm-receipts-run.ts`)
- `crm_receipt_writes` (0107): one row per write, its fields fixed once queued, for the CRM deal its deal was planned
  from (checked on insert). One write in hand per deal (`queued`, `sending`, `sent`, `failed`, `conflict`).
- Queueing (`queueReceipts`) runs after each CRM sync (the sweeper every 15 minutes, **Sync now**, the first sync): a
  deal whose fields differ from its latest write gets a new one; a newer write supersedes one still queued, failed or in
  conflict; one in flight finishes first. The same fields are never queued twice.
- Field ownership: what Vestiarion owns on a deal is its last write read back, and what any write since was sent with
  that HubSpot may have taken while its answer was lost (tried, never read back, then superseded: `unacknowledged`).
  Before writing, the deal's fields are read: a field HubSpot holds otherwise was changed by someone, and the write
  becomes a **conflict**, recorded once (`crm_receipt_conflict`), never written over. Before a first write, any value
  already there is someone else's.
- **Write Vestiarion's figures** (`crm.receipt_overwrite`, `integrations.manage`) acts on the conflict the page showed
  (`conflictKey`): the write is queued again carrying what HubSpot held then (`overwrite`), and is written only while
  HubSpot still holds exactly that; newer figures that supersede it before it is sent carry the same choice. Later
  receipts wait behind a conflict until someone chooses.
- Cost if wrong: a person looks at a field they changed on purpose; never a silent overwrite.

**R6. Sending and the acknowledgement.** (`sendReceipts`)
1. The gate (R3) and the account (R4). 2. A claim (`sending`, a two-minute lease; every move of a write compares its
`attempts`, which each claim counts, so a send whose lease ran out never moves a later run's claim). 3. The group and properties made
where missing, once a run. 4. The deal's fields read: gone from HubSpot refuses the write (`deal_gone`); already what
the write says (an earlier write whose answer was lost) is acknowledged as it is; a conflict (R5) stops it. 5. The
write. 6. The read-back: the same fields are HubSpot's acknowledgement, and only then is it **written**
(`crm_receipt_written`, with what HubSpot held). Different fields right after are someone's change (a conflict); no
answer leaves it `sent`, and the next run reads it back.
- A timeout or a 5xx reads back before anything else. A failure waits a minute, doubling to an hour (`failureDelayMs`),
  and is recorded once per write (`crm_receipt_failed`); a refusal in HubSpot's words, or a property it will not make,
  waits an hour; a rate limit waits what HubSpot asked and ends the run. 25 writes a run.
- Cost if wrong: a write left `sent` until the next run.

**R7. Never near a payment.** The outbox reads the database and HubSpot and writes only its own rows and the ledger.
Nothing in the agent, the payments, the allocations or the money commands imports it (pinned in
`tests/crm-receipts.test.ts`). HubSpot being down leaves writes waiting; no payment is sent again for it.

**R8. Where it shows.**
- A deal's page, **Receipts in HubSpot** (`CrmReceiptCard`), for every member: **Written** with what HubSpot read back
  and when; **Waiting** (queued, or sent and being read back) with what will be written; **Not written yet** with why
  and when it is tried again; **Changed in HubSpot**, field by field (Vestiarion last wrote, HubSpot holds now,
  Vestiarion would write) with **Write Vestiarion's figures to HubSpot** for an owner or admin; **Not allowed yet** with
  how to allow it; **Not written** by the reality rule. The last write read back stays shown below whatever comes next.
- Settings, the HubSpot card: **Receipts in HubSpot**, on or off, how the writes stand, what HubSpot says the account
  is, the reality rule for the workspace, and **Allow writing to HubSpot**, **Write receipts to HubSpot** or **Stop
  writing to HubSpot**.

**R9. The ledger.** `crm_receipt_writes_changed` (`human`, `system`): `{ by, provider, connectionId, externalOrgId, on,
scopes }`. Domain `ar`: `crm_receipt_written` (`system`): `{ provider, connectionId, externalOrgId, writeId, dealId,
crmDealId, fields, writtenAt, adopted, network, shadow, accountType }`; `crm_receipt_conflict`: `{ …, conflicts }`;
`crm_receipt_failed`: `{ …, reason, message, retryAt }`; `crm_receipt_refused`: `{ …, reason, message }`, `reason`
`reality` (with `network`, `shadow`, `accountType`) or `deal_gone`; `crm_receipt_overwrite_chosen` (`human`): `{ by,
writeId, dealId, crmDealId, connectionId, seen }`. They reach webhooks as `ledger.appended`.

## I17: notices say what is known

Audited: receipt pages, payee emails, Slack and Telegram notices, activity toasts, the stuck-payment email, the pay-link
page and the decision trail. Fixed where they claimed more than was known: a payment is "submitted" until Circle
confirms it, and its outcome is "unknown" when Circle never answered the send (an unanswered send is recorded as an
in-flight `matched`, so "Sent … is confirming it" overclaimed); a confirmed one names Circle and the network; a sandbox
one says simulated; the payee email names Circle's confirmation; the customer's pay page says what actually arrived when
a fee covered the rest, and who reported it; a person's approval is noted "paid" only once Circle confirmed it. The
shared receipt page already said confirmed or reconciled, and by which check, and is unchanged.

## Not in this version

Webhooks from HubSpot (a change to a Vestiarion field is found at the next write), writing to a deal not planned from
HubSpot, writing HubSpot's own amount or stage, one write per receipt in a timeline, Pipedrive and Salesforce (the seam,
`CrmReceiptWriter`, is theirs to implement), and a HubSpot "card" in the deal's sidebar.

## Testing

- Pure (`tests/crm-receipts.test.ts`): what counts (whole match, allocations, a reversal, a part payment, a fee, an
  unverified receipt, overdue, shadow's conversion, a currency left out), the fields, comparing what HubSpot holds
  (numbers, days, before a first write, an overwrite of what was seen), the reality rule, and the pin of R7.
- The runs against a fake HubSpot and a store holding the database's rules (`tests/crm-receipts-run.test.ts`).
- HubSpot over HTTP against a recording fetch (`tests/hubspot-receipts.test.ts`), the optional scopes and the app config
  (`tests/hubspot-api.test.ts`), the connect flow's choice (`tests/hubspot-connect.test.ts`,
  `tests/integration-connect-pages.test.tsx`), the commands (`tests/commands-crm-receipts.test.ts`), the rows the store
  reads (`tests/crm-receipts-store.test.ts`), the card and the panel (`tests/crm-receipts-render.test.tsx`).
- The migration on PGlite (`tests/crm-receipts-migration.test.ts`): the switch, one write in hand, the fields fixed, the
  transitions, the reality check, the network and shadow taken from the workspace, isolation, cascades, a second run.
- Not verified here: a live write to a HubSpot developer test account, which needs the app's new optional scope uploaded
  and a reconnect with writing allowed.
