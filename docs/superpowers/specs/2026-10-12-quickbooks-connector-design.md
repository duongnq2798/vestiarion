# Bring bills in from QuickBooks Online

Date: 2026-10-12. Status: decided (autonomy grant 2026-10-05). Roadmap: F07. Builds on the connector core of
`docs/superpowers/specs/2026-10-12-xero-connector-design.md` (X1–X19); where QuickBooks differs, the decision says why
and what the core gained. Stage: sandbox, against a US sandbox company of the app's Development keys.

## Why

Most small businesses in the US keep their bills in QuickBooks Online. Connecting it once brings the open bills in,
through the same review list and the same check as Xero's, so a person confirms them and the agent decides them. A
workspace may connect Xero, QuickBooks, or both: one card per tool.

## What Intuit offers, as of October 2026

- **OAuth 2.0, authorization code.** Authorize at `https://appcenter.intuit.com/connect/oauth2` (`client_id`, `scope`,
  `redirect_uri`, `response_type=code`, `state`); the person picks one company, and the redirect carries `code`,
  `state` and `realmId`, the company's id. Tokens at `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`,
  HTTP Basic client authentication, form-encoded. Revoke at `https://developer.api.intuit.com/v2/oauth2/tokens/revoke`
  (Basic, a JSON body `{"token": …}`); revoking disconnects the app from the company. Discovery documents:
  `https://developer.api.intuit.com/.well-known/openid_sandbox_configuration` and `…/openid_configuration`.
- **Tokens.** An access token lasts an hour (`expires_in: 3600`). A refresh token has a rolling life of 100 days
  (`x_refresh_token_expires_in`), at most five years. Intuit changes the refresh token at most once a day, on the first
  refresh after 24 hours, and the earlier value stops working at once: no grace period. Sending a spent one answers
  `400 invalid_grant`. The token answer carries no `scope`.
- **Scopes.** `com.intuit.quickbooks.accounting` reads and writes the books; there is no read-only scope. OpenID
  scopes (`openid`, `profile`, `email`) are not asked for.
- **API.** `https://sandbox-quickbooks.api.intuit.com/v3/company/<realmId>/…` for sandbox companies,
  `https://quickbooks.api.intuit.com/v3/company/<realmId>/…` for real ones. Minor versions 1 to 74 were retired on
  1 August 2025; 75 is the base and the default, sent as `minorversion=75`.
- **Queries.** `GET /query?query=<statement>`: `SELECT * | count(*) FROM <Entity> [WHERE …] [ORDERBY …]
  [STARTPOSITION n] [MAXRESULTS m]`, one entity at a time, `AND` only (no `OR`), `MAXRESULTS` at most 1,000 (default
  100), `STARTPOSITION` from 1. `count(*)` answers `QueryResponse.totalCount`. A page answers
  `QueryResponse.<Entity>[]` with `startPosition` and `maxResults`, and `QueryResponse: {}` when nothing matches. Name
  lists (Vendor) return only active records unless the query says `Active IN (true, false)`. A deleted transaction is
  never returned.
- **Bill.** `Id`, `SyncToken`, `MetaData.LastUpdatedTime` (an ISO time with an offset), `VendorRef {value, name}`,
  `CurrencyRef {value, name}`, `TotalAmt`, `Balance` (what is left to pay), `TxnDate`, `DueDate`, `DocNumber`,
  `PrivateNote` (the memo). `Balance` and `MetaData.LastUpdatedTime` can be filtered on; the time can be sorted on.
  QuickBooks has no draft or approval state for a bill in the API: a bill is in the books or it is not. Voiding one in
  QuickBooks' screens sets its amounts to zero and its memo to "Voided".
- **Change data capture.** `GET /cdc?entities=Bill&changedSince=<time>`: changes within the last 30 days, at most
  1,000 objects in an answer, no paging. A deleted object comes back as `{"domain": "QBO", "status": "Deleted",
  "Id": …, "MetaData": {"LastUpdatedTime": …}}` and nothing else.
- **Limits.** 500 requests a minute and 10 a second per company and app; 40 batch requests a minute. Past a limit, a
  `429`, with no `Retry-After` promised; Intuit asks for a minute's wait.
- **Webhooks.** With the CloudEvents payload format on (required since 15 May 2026), a notification is a POST whose
  body is a JSON array of events, each `{specversion, id, source, type, datacontenttype, time, intuitentityid,
  intuitaccountid, data}`: `type` is `qbo.<entity>.<operation>.v1` (`qbo.bill.created.v1`), `intuitaccountid` the
  realm id, `intuitentityid` the record's id. One notification may carry several companies. It names records and
  never their fields. Each carries `intuit-signature`: the base64 HMAC-SHA256 of the raw body under the app's verifier
  token. Intuit asks for a 200 within three seconds, and recommends polling (change data capture) as a backstop.
- **App URLs.** Launch (a person opens the app from QuickBooks), Connect/Reconnect (they connect or reconnect from
  QuickBooks), Disconnect (QuickBooks sends them there after they disconnect the app on its side).

## What the partner fixed in Intuit's portal

Development keys with a US sandbox company; scope `com.intuit.quickbooks.accounting` only; redirect URIs
`https://www.vestiarion.xyz/api/integrations/quickbooks/callback` and
`http://localhost:3000/api/integrations/quickbooks/callback`; Launch `https://www.vestiarion.xyz/integrations/quickbooks`;
Connect/Reconnect `https://www.vestiarion.xyz/integrations/quickbooks/connect`; Disconnect
`https://www.vestiarion.xyz/integrations/quickbooks/disconnected`; webhooks at
`https://www.vestiarion.xyz/api/integrations/quickbooks/webhook`, CloudEvents format on, for Account, Bill,
BillPayment, Customer, Invoice, Payment and Vendor. Env: `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`,
`QUICKBOOKS_ENVIRONMENT` (`sandbox` or `production`), `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`.

## Decisions

**Q1. One more provider on the core, which grows only where QuickBooks differs.** (`src/lib/quickbooks/`)
- The folder mirrors Xero's: `settings.ts`, `http.ts`, `oauth.ts`, `map.ts` (pure), `api.ts`, `provider.ts`,
  `connect-deps.ts`, and `webhook.ts`. `src/lib/accounting-providers.ts` gains the `quickbooks` branch, so the sweeper,
  **Sync now** and the review list serve it unchanged.
- What the core gained, each optional so Xero's calls are unchanged:
  - `callbackOrganisationParam` (`realmId`): the callback names the company, and `organisations(tokens, authEvent,
    named)` checks the token reads it (Q4).
  - `exclusive`: one workspace per company at a time (Q5).
  - `ExternalBill.factsKnown: false`: a bill the provider says only was deleted keeps the facts its row has (Q8).
  - `PageRequest.windowFrom`: the connection's first day, so a provider can bound its backfill (Q7).
  - `PROVIDER_WORDS`: "company" or "organisation", "vendors" or "suppliers", and how long a connection may sit unused,
    for the status words, the consent and the cards (Q15).
  - `disconnectConnection({ atProvider: true })`: a connection the provider says was disconnected there (Q12).
  - The review list's partly paid bills (Q9), the same for Xero.
- The Xero-only cards and actions become provider-generic ones (`AccountingPanel`, `AccountingBillsReview`,
  `AccountingAccountPicker`, `src/app/actions/accounting.ts`, and the launch and connect pages'
  `AccountingLaunch`/`AccountingConnect`), each taking the provider; Xero's words are unchanged.
- Cost if wrong: one optional field to widen again; Xero's tests hold its behaviour.

**Q2. Settings and stage.** (`src/lib/quickbooks/settings.ts`)
- On with `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET`; otherwise its card, its pages and every route answer
  404, as Xero's. `QUICKBOOKS_ENVIRONMENT` is `sandbox` (the default when unset) or `production`; anything else turns
  QuickBooks off with a warning that names the variable, never its value. It picks the API's base URL only: the OAuth
  endpoints are the same for both. Production keys need Intuit's app assessment, so production is out of this version
  beyond that switch.
- The webhook needs `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` too; without it the webhook route answers 404 and the sweeper
  alone brings changes in.
- Cost if wrong: one variable to set again.

**Q3. Tokens: the core's serialized refresh, and no grace period.**
- Intuit may return a new refresh token on any refresh (about once a day) and the old one dies at once. The core's
  lease and compare-and-set (X5) already send each refresh token once and store the newest pair only over the version
  read, so nothing changes in the core. The token answer has no `scope`: the scope asked for is kept.
- What differs from Xero: a crash between Intuit's answer and the store, on the refresh that rotates, loses the only
  working refresh token, and the card then asks to reconnect. The store is one row update right after the answer, so
  the window is a few milliseconds a day.
- `invalid_grant` marks the connection needs reconnect; 5xx, timeouts and 429 back off (X8).
- Cost if wrong: a reconnect.

**Q4. Connecting: the company is the callback's, and it is checked.** (`src/lib/connectors/connect.ts`)
- The same routes and checks as Xero (X4): `/integrations/quickbooks` (Launch), `/integrations/quickbooks/connect`
  (Connect/Reconnect: pick the workspace, read the consent, tick **I agree**, **Continue to QuickBooks**),
  `POST /api/integrations/quickbooks/connect`, `GET /api/integrations/quickbooks/callback`; the state, the cookie
  (`vx_quickbooks_oauth`, path `/api/integrations/quickbooks`), the person, their role and the consent are checked before
  the code is exchanged.
- One company per grant: no picker. The callback's `realmId` is read only after every check, must be digits, and is
  confirmed by reading `companyinfo/<realmId>` with the new access token: a `realmId` edited in the URL reads nothing,
  and the connection fails. The company's name is `CompanyName` there.
- A callback without `realmId` fails ("QuickBooks did not finish connecting").
- No PKCE, as Xero (X4).
- Cost if wrong: one flow, tested by its failures.

**Q5. One workspace per QuickBooks company.**
- Revoking a QuickBooks token, and disconnecting the app in QuickBooks, ends the app's access to the company for every
  grant, so two workspaces on one company would cut each other off. A company connected (not revoked) to another
  workspace is refused: back to Settings with `?quickbooks=other_workspace` ("This QuickBooks company is connected to
  another Vestiarion workspace. Disconnect it there first."). The other workspace is not named. The new tokens are
  neither stored nor revoked: revoking them would disconnect the other workspace.
- The check asks migration 0102's `accounting_connections_by_external` (the service role's: the DAL keeps tenant
  tables away from the platform client, so a cross-workspace read is a function, as `accounting_connections_due` is),
  by provider and company id only. Two workspaces connecting the same company in the same second are held apart by
  0102's partial unique index on `(provider, external_org_id)` for QuickBooks connections not revoked: the second
  insert fails, and reads as `other_workspace` too.
- Xero keeps its own rule: several workspaces may share an organisation (X4).
- The company is known only on the way back, after Intuit granted the new tokens. This assumes, as Intuit's
  documentation reads, that a new grant leaves earlier grants for the company working; if it did not, the other
  workspace would be asked to reconnect, and nothing else would change.
- Cost if wrong: the same business's Arc testnet and Arc mainnet workspaces cannot both read one company; one
  disconnects, the other connects.

**Q6. Reading QuickBooks.** (`src/lib/quickbooks/api.ts`)
- Every call sends `Authorization: Bearer`, `Accept: application/json` and `minorversion=75`, to the base URL of
  `QUICKBOOKS_ENVIRONMENT`, with a 20-second timeout. A `429` is `rate_limited` with Intuit's `Retry-After` when there
  is one, else the core's minute; `401` `unauthorized` (refresh once); `403` `forbidden` (needs reconnect); `5xx`
  `unavailable`; an answer that does not read, or a `Fault`, `bad_response`. Messages carry the call and the status,
  never a token, a body, a query or an id.
- Vendors (the contacts): `SELECT * FROM Vendor WHERE Active IN (true, false) [AND MetaData.LastUpdatedTime >= '<since>']
  ORDERBY MetaData.LastUpdatedTime STARTPOSITION <n> MAXRESULTS 100`. An inactive vendor is archived. Every vendor is
  a supplier.
- Bills: the backfill reads `Balance > '0' AND DueDate >= '<window_from>'` (Q7); an incremental run reads
  `MetaData.LastUpdatedTime >= '<since>'`, whatever the balance, so a bill paid later is seen. Both ordered by update
  time, 100 a page. Each page also asks `SELECT count(*)` of the same filter, kept as the page's `total`, so a bill
  that leaves the read between two pages (paid during a backfill, deleted) restarts the run (X8).
- Deleted bills: the last page of an incremental run also asks change data capture for the bills deleted since five
  minutes before `since` (at most 30 days back), and adds them to the page (Q8). The last page, so the answer covers
  every deletion up to the end of the read, however long the run took or wherever it resumed; five minutes before, so
  a deletion between the last run's read and its own question is not lost. A deletion read twice is kept once (X10).
- Times in a filter are UTC to the second (`2026-10-12T08:00:00Z`), floored: a re-read is the risk, not a gap.
- The chart of accounts: `SELECT * FROM Account WHERE AccountType = 'Bank' AND Active = true`, read when an owner or
  admin opens the picker (I14): bank accounts only.
- A bill with no `CurrencyRef` takes the company's home currency, read once from `Preferences`
  (`CurrencyPrefs.HomeCurrency`) only when such a bill is read; never guessed.
- Cost if wrong: one query to change, tested against recorded QuickBooks-shaped answers.

**Q7. A bounded backfill.** The backfill asks QuickBooks only for open bills due on or after `window_from` (90 days
before the first connection, X9), so a company that never marks bills paid in QuickBooks does not send years of
them. A bill's due day is never before its date in QuickBooks (it defaults to the date plus the terms), so this is
X9's window, applied by QuickBooks rather than by `planBill` (which still applies it). Cost if wrong: an old open bill
is added with the form.

**Q8. Mapping, and what each balance means.** (`src/lib/quickbooks/map.ts`, pure)
- `Balance > 0` is `open`; `Balance` 0 is `paid`, or `voided` when `TotalAmt` is 0 too and the memo starts with
  "Voided"; a change data capture `Deleted` is `deleted`. QuickBooks has no draft bill.
- Version: `MetaData.LastUpdatedTime` in UTC to the millisecond, then `#` and `SyncToken` padded to 8 digits
  (`2026-10-12T15:04:05.000Z#00000003`), so two changes in the same second still order. A deleted bill's version ends
  `#deleted`, after any number. Versions compare as text within one connection (X10).
- Facts: `DocNumber` is the number; `PrivateNote` the reference (it reads as the bill's memo; "Voided" is not kept);
  `VendorRef` the supplier; `TxnDate` and `DueDate` the days; `TotalAmt` and `Balance` the total and the amount due,
  as exact decimals.
- A deleted bill carries only its id and time: `factsKnown: false`. The sync then changes only its row's status and
  version, and an added one is marked closed with the row's own supplier and number in `accounting_bill_closed`. Its
  time does not move the cursor: it comes from the change feed, not from the read, and the next run's `since` stays the
  latest change the read itself saw.
- Cost if wrong: one mapping function, tested against fixtures. A deletion more than 30 days before a sync reads it
  (a connection left needing a reconnect that long) is not seen; the bill stays in the review list until someone
  dismisses it.

**Q9. Partly paid bills.** A bill whose `Balance` is less than its `TotalAmt` is offered at its balance, as Xero's
amount due already is: the review list shows "400.00 USD left of 1,000.00" and a **Partly paid in QuickBooks** badge
(`ReviewRowView.total`). A bill already added whose amount due later falls below the amount it was added at (its
invoice's own figure: the original amount in shadow mode, else the amount; an invoice not yet paid or rejected) is
listed under "Partly paid in QuickBooks after they were added": "PowerDirect · PD-4471: 400.00 USD left of the 1,250.00
added. Look at it in Payables before the agent pays it." (`partlyPaidSince`, read beside the closed ones). Both are the
core's, so Xero's partly paid bills say the same. No entry is signed for it: the invoice is unchanged, and the next change
in QuickBooks may undo it. Cost if wrong: a list to read; the agent's own checks are unchanged.

**Q10. Syncing and the sweeper.** Unchanged (X7, X8): vendors, then bills; 10 pages on connecting, 5 on **Sync now**, 20
from the sweeper, which runs QuickBooks and Xero connections alike from `accounting_connections_due`. A 429 without
`Retry-After` waits a minute (the core's default).

**Q11. The webhook nudges; it never trusts the payload.** (`src/lib/quickbooks/webhook.ts`,
`POST /api/integrations/quickbooks/webhook`)
- The raw body is read first (at most 1 MB, else `413`), and `intuit-signature` checked against the base64
  HMAC-SHA256 of it under `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`, in constant time: a missing or wrong one is `401` and
  nothing else is read.
- The body is a JSON array of CloudEvents (one object is read as an array of one). From each event only `type` and
  `intuitaccountid` are kept: the entity (`bill`, `billpayment` and `vendor` bear on bills; `account`, `customer`,
  `invoice` and `payment` do not) and the realm. The record's id, the time and `data` are not used: the sync reads
  the canonical records itself.
- The realms whose bills or vendors changed are matched to their connections with 0102's
  `accounting_connections_by_external` (by provider and company id). A realm no workspace has connected is answered `200` with nothing done, as is a connection that is not
  connected, or backing off (`next_sync_after` in the future: a rate limit or an outage is not overridden).
- The answer goes at once (`200 {"received": n}`); then, after it (`after()`), each matched connection runs one sync
  in its own workspace's scope with the **Sync now** budget (5 pages), one after another, for at most 60 seconds; the
  rest wait for the sweeper (15 minutes). The sync lease (X7) keeps two notifications from running one connection
  twice: the second is `busy` and does nothing.
- Replayed and duplicated notifications are harmless: a sync re-reads what changed and the version check (X10) keeps
  what it has. Nothing is stored per notification: no receipts table. A log line names the counts and the matched
  connection ids, never a realm's records.
- Cost if wrong: a change waits up to 15 minutes for the sweeper; a receipts table later is additive.

**Q12. The Disconnect URL confirms before it records.** (`/integrations/quickbooks/disconnected`)
- QuickBooks sends a person there after they disconnect the app on its side. The page needs a signed-in person (else
  sign in and come back), and looks only at the QuickBooks connections of the workspaces where they manage
  integrations (and only the company of `?realmId=` when QuickBooks sends one).
- For each, it asks QuickBooks whether the connection still works: a fresh access token through the core's refresh
  (X5), then one read (the bank accounts). Refused (`invalid_grant`, `401` after a refresh, `403`): the connection is
  marked revoked, its tokens deleted, and `accounting_disconnected` signed with `atProvider: true`. Still accepted:
  nothing changes, and the page says QuickBooks still accepts it, with the way to disconnect from Settings. No answer:
  nothing changes; the next sync finds out and asks for a reconnect.
- So the page cannot revoke a working connection, nor anyone else's: it records only what QuickBooks confirms, for a
  person who could disconnect it anyway. It writes during a render because QuickBooks sends a plain link; the write is
  idempotent.
- Cost if wrong: a connection shown as needing a reconnect rather than disconnected, until someone disconnects it.

**Q13. Consent, in plain words, before connecting.** The QuickBooks statement (`quickbooks-2026-10-12`, already in
`CONSENT_VERSIONS`): Vestiarion reads the bills, vendors and bank accounts of the QuickBooks company you connect, and
writes nothing to QuickBooks; the bills you add are shown to the workspace's members and its agent, whose model
provider sees each bill's facts to decide on it and may not train on them; Vestiarion never uses QuickBooks data to
train or improve any AI model, and never passes it to anyone else without the workspace's say; disconnecting stops
the reading at once. Recorded in the state, the connection and `accounting_connected` (X12). `/terms` and `/privacy`
name QuickBooks beside Xero. The scope Intuit grants can write, so the statement says what Vestiarion does, not what
the scope allows. Cost if wrong: new words and a new version.
*Since `quickbooks-2026-10-15`*: the model provider sentence says the provider sees the facts under its own API terms (DeepSeek's, on
the hosted service). The earlier promise that it may not train on them had no basis in those terms.

**Q14. Disconnecting from Vestiarion.** **Disconnect QuickBooks** revokes the refresh token at Intuit (which ends the
app's access to the company), deletes the tokens, marks the connection revoked and signs `accounting_disconnected`
(X13). Bills, links and invoices stay.

**Q15. Words.** QuickBooks has companies and vendors; Xero has organisations and suppliers. The status words (X15) take
the provider's: "Connected to Sandbox Company_US_1", "QuickBooks needs you to reconnect", "QuickBooks no longer
accepts this connection: it was disconnected in QuickBooks, or not used for 100 days.", never connected while the
last sync failed. Cost if wrong: copy.

**Q16. The ledger.** No new action. `accounting_connected`, `accounting_disconnected`,
`accounting_payment_account_chosen`, `accounting_bill_closed` and `accounting_bills_dismissed` carry
`provider: "quickbooks"`, and `externalOrgId` is the realm id. `create_invoice` and `create_counterparty` say
`via: "quickbooks"` and `quickbooks: { tenantId, billId, contactId, invoiceNumber }` (the realm, the bill's `Id`, the
vendor's `Id`, its `DocNumber`), the core's shape. `accounting_disconnected` gains `atProvider: true` when QuickBooks
said it was disconnected there (Q12). The changelog lists them.

**Q17. What never leaves.** As X17: tokens only in `token-store.ts` and to Intuit; logs carry labels, statuses and
ids; the webhook's body is never logged.

**Q18. The migration, and before it runs.** 0101's tables already take `provider = 'quickbooks'`; migration 0102 adds
only the index and the function of Q5 and Q11 (additive, re-runnable, the service role's). Before 0101 or 0102 has
run, as X16: the card says QuickBooks is not set up yet, connecting says so, the review list is hidden, the webhook
answers `200` with nothing done, and the sweeper has nothing to do (`PGRST202` for the missing function reads as not
set up).

**Q19. Where it shows.** Settings, Integrations, **QuickBooks** (`AccountingPanel`, `#quickbooks`), below Xero; Bills &
receivables, **From QuickBooks: N bills to add** (`AccountingBillsReview`, `#from-quickbooks`), below Xero's.

## Not in this version

- Production companies (Intuit's app assessment, and its "Connect to QuickBooks" button), writing payments back,
  vendor credits, attachments, bills older than the window, a webhook receipts table, and holding a payable whose
  QuickBooks bill closed (as X10).

## Testing

- Pure: the mapping against recorded QuickBooks-shaped fixtures (an open bill with `Balance`, `VendorRef`,
  `CurrencyRef`, `DueDate`, `TxnDate` and `MetaData.LastUpdatedTime`; paid, voided, deleted through change data
  capture, partly paid; a JPY bill with no decimals and a USD one), vendors, bank accounts, tokens, the company, the
  queries and their paging and counts.
- HTTP against a fake fetch: the token requests, refresh and `invalid_grant`, revoke, 401, 403, 429, 5xx, the base URL
  of each environment, `minorversion`.
- The OAuth callback as Xero's: state mismatch, expired, another person, a non-member, consent missing, the company
  connected to another workspace, a reconnect, a missing or edited `realmId`.
- The webhook: a bad signature `401`, a good one nudges, an unknown realm, an array of several events, a replay, an
  entity that does not bear on bills.
- The Disconnect URL: refused tokens recorded, working ones untouched, another person's workspace untouched.
- The sweeper with both providers; `planBill` and the sync with a deleted bill; the review list's partly paid bills.
- The card and the review list render (`/docs-shots`, headless Edge).
