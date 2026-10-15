# Bring bills in from Xero

Date: 2026-10-12. Status: decided (autonomy grant 2026-10-05). Roadmap: F13, with I13 (rate limits, backoff and
checkpoints) and I14 (the Xero account payments will be booked to). Starts from Phase 3 of
`docs/superpowers/specs/2026-10-03-integrations-design.md` ("accounting, Xero first, then QuickBooks Online"); where
this differs, the decision says why. Stage: sandbox, against the Xero Demo Company.

## Why

A small business in Singapore, Australia, the UK or the US keeps its bills in Xero. It will not retype them into
Vestiarion, and a CSV export it has to make every week is a chore it stops doing. Connecting Xero once brings its
approved bills in, through the same check a bill list gets, so a person confirms them and the agent decides them.

Writing payments back to Xero is the next feature; this one stores the account they will be booked to (I14).

## What Xero offers, as of October 2026

- **OAuth 2.0, authorization code**, for a "Web app" (client id and secret): authorize at
  `https://login.xero.com/identity/connect/authorize`, tokens at `https://identity.xero.com/connect/token` with HTTP
  Basic client authentication, revocation at `https://identity.xero.com/connect/revocation` (from Xero's OpenID
  discovery document). An access token lasts 30 minutes; a refresh token lasts 60 days, and every refresh returns a
  new one (rotation), the old one staying usable for a short grace period only.
- **Granular scopes.** An app created on or after 2 March 2026 gets none of the broad accounting scopes
  (`accounting.transactions`); it asks for granular ones, each with a read-only form. Reading bills is
  `accounting.invoices.read`; contacts (`accounting.contacts`) and settings, which hold the chart of accounts
  (`accounting.settings`), were not split and keep their `.read` forms. `offline_access` gives a refresh token.
- **`GET https://api.xero.com/connections`** lists the organisations (tenants) a token reaches: `id` (the
  connection), `authEventId`, `tenantId`, `tenantType`, `tenantName`. Each API call names its tenant in the
  `xero-tenant-id` header.
- **Invoices** (`GET /api.xro/2.0/Invoices`): bills are `Type == "ACCPAY"`. Filters `where`, `Statuses`, `page`,
  `pageSize`, `order`, and the `If-Modified-Since` header (records created or changed since then). A page holds up to
  100 by default, with a `pagination` object (`page`, `pageSize`, `pageCount`, `itemCount`). Dates come as
  `/Date(1518685950940+0000)/`, with `DateString` and `DueDateString` beside them. Statuses: `DRAFT`, `SUBMITTED`,
  `AUTHORISED`, `PAID`, `VOIDED`, `DELETED`.
- **Contacts** (`GET /Contacts`, same paging and `If-Modified-Since`): `ContactID`, `Name`, `ContactStatus`,
  `IsSupplier`, `UpdatedDateUTC`.
- **Accounts** (`GET /Accounts`): the chart, with `AccountID`, `Code`, `Name`, `Type` (`BANK` for a bank account),
  `Status`, `CurrencyCode`, `Class`, `EnablePaymentsToAccount`.
- **Limits**: 60 calls a minute and 5,000 a day per organisation, 5 at once, and an app-wide minute limit. Past a
  limit Xero answers `429` with `Retry-After` (seconds) and `X-Rate-Limit-Problem` naming the limit.
- **Pricing**: the free Starter tier holds 5 connected organisations.

## Decisions

**X1. A connector core, then Xero on it.** (`src/lib/connectors/`, `src/lib/xero/`)
- The core knows connections, tokens, links, cursors, backoff, the inbound review list and the connect flow, and talks
  to a provider only through `AccountingProvider` (`src/lib/connectors/provider.ts`): its authorize URL, code exchange,
  organisations, refresh, revoke, and paged reads of bills, contacts and accounts, each mapped to the core's own shapes
  (`ExternalBill`, `ExternalContact`, `ExternalAccount`). Nothing under `src/lib/connectors/` names Xero.
- Xero's folder holds its settings, HTTP, OAuth calls, the pure mapping from its JSON, and the provider object.
- QuickBooks Online is the next provider, on the same core: one more folder and one more value of `provider`.
- Cost if wrong: an interface QuickBooks needs to widen; the tables already take `provider`.

**X2. The schema (migration 0101, additive, re-runnable).**
- `accounting_connections`, a tenant table: one row per workspace, provider and external organisation (`unique
  (org_id, provider, external_org_id)`), at most one not revoked per workspace and provider (a partial unique index).
  It holds the organisation's name, the status (`connected`, `needs_reconnect`, `revoked`), the scopes granted, who
  connected and when, the consent (version and time), who disconnected and when, `window_from` (X9), the last sync
  and the last error in business words, the failures in a row and the time the next sync may start (X8), a sync lease
  (X7), and the payment account chosen (I14). The tenant role may read, insert and update it; nothing is deleted:
  disconnecting marks it revoked and keeps it.
- `accounting_tokens`, a platform table: the access and refresh tokens as envelopes, their expiry, the scopes, a
  version, a refresh lease, and, while a person picks among several organisations, the organisations offered and a
  ten-minute deadline. Row-level security on, no policy, nothing granted to `anon`, `authenticated` or
  `vestiarion_tenant`: only the service role reads it, through `src/lib/connectors/token-store.ts`, the one module
  that does. As Slack's bot token, it never reaches the tenant role, the browser, a log, a prompt or a webhook.
- `external_links`, a tenant table: the core's link from an external object (workspace, provider, external
  organisation, object type `contact` or `bill`, external id; unique) to the local row (`local_id`, a counterparty or
  an invoice, unique per external organisation and type once set), with the external version and update time and a
  label (a contact's name). `local_id` has no foreign key: it points at one of two tables by type.
- `accounting_bills`, a tenant table: the review list (X10). Each bill read from the provider, once, with its facts
  as the provider has them now (supplier, number, reference, currency, total, amount due, dates), what the provider
  says of it now (`source_status`: `open`, `paid`, `voided`, `deleted`, `draft`) and what a person did
  (`review_state`: `review`, `added`, `dismissed`). Unique per connection and external id.
- `accounting_sync_cursors`, a tenant table: per connection and object type, the phase (`backfill`, `incremental`),
  the `since` time for `If-Modified-Since`, and the checkpoint of a run under way (the next page and the latest change
  read so far).
- Tenant tables: row-level security with `tenant_isolation` and the restrictive guard, composite foreign keys to the
  connection (`(org_id, connection_id)`), cascading with the workspace, as `0090` and `0094`. Every table is in
  `TENANT_TABLES` or `PLATFORM_TABLES`, the PGlite seed, and the deletion tests.
- Service-role functions: `accounting_token_lease`, `accounting_token_store`, `accounting_token_release` (X5) and
  `accounting_connections_due` (X7).
- Cost if wrong: an additive migration; a later one can add columns.

**X3. Who does what.**
- Connecting, disconnecting, **Sync now** and choosing the payment account: `integrations.manage` (owner, admin), as
  Slack and GitHub. Every route and action reads the person's role again; the OAuth callback does too.
- Adding bills from the review list and dismissing them: `records.write` (owner, admin), through two commands,
  `accounting.add_bills` and `accounting.dismiss_bills`, open to the console only.
- Every member sees the Xero card's status; only an owner or admin sees its controls.
- Cost if wrong: one entry in the permission map per command.

**X4. Connecting: routes, state and consent.**
- `/integrations/xero`: a signed-in person goes to their workspace's Xero settings (Settings, Integrations, `#xero`);
  with several workspaces, they pick one. Signed out, they sign in and come back.
- `/integrations/xero/connect`: the person picks the workspace (those where they may manage integrations), reads the
  consent statement (X12) and ticks **I agree**, then **Continue to Xero**. The form posts to
  `POST /api/integrations/xero/connect`, which refuses a request from another origin, reads the session, the
  membership and the role, and the tick, and only then sends the person to Xero with a signed state.
- The state is `vx1.<payload>.<HMAC>` keyed by HKDF from the master key for this purpose alone, as Slack's and
  GitHub's are: the workspace, the person, a nonce also kept in an HttpOnly, `SameSite=Lax` cookie (path
  `/api/integrations/xero`, ten minutes), the provider, and the consent's version and time. Ten minutes.
- `GET /api/integrations/xero/callback` checks the state's signature and age and the cookie's nonce (else "This Xero
  connection link has expired"), that the person signed in now is the one who started, still a member who may manage
  integrations (else back to Settings, `?xero=forbidden`), and that the state carries the consent (else back to the
  connect page, `?consent=missing`). A cancel at Xero comes back as `?xero=cancelled`. Only then is the code
  exchanged and `/connections` read.
- Organisations offered are those of this authorization (`authEventId` equal to the access token's
  `authentication_event_id`), or every one listed when the token does not say. One organisation is connected at once.
  Several: the tokens are kept as a pending row in `accounting_tokens` (connection null, ten minutes) and the person
  picks one on `/integrations/xero/connect?choose=<id>`, which posts to `POST /api/integrations/xero/choose`; that
  route checks the session, the role, and that the pending row is theirs, for that workspace, and not expired.
- The organisations not picked stay authorised at Xero until the person removes them there: deleting a connection at
  Xero from here could cut off another workspace that uses the same Xero organisation through the same person (the
  same business's Arc testnet and Arc mainnet workspaces). A pending row nobody finished is revoked at Xero and
  deleted by the sweeper.
- A workspace already connected to another organisation is refused ("Disconnect it first"); the same organisation
  again reconnects the row (a connection that needs reconnecting, or one revoked earlier), keeping its links, cursors
  and review list.
- No PKCE: the client secret, the signed state and the browser's nonce already bind the code to this person, as for
  Slack and GitHub; adding it later changes only the two requests.
- Cost if wrong: one flow, tested by its failures (state, expiry, another person, a non-member, consent, several
  organisations).

**X5. Tokens, and a refresh that cannot race.** (`src/lib/connectors/tokens.ts`, `token-store.ts`)
- Each token is an envelope under the master key (`src/lib/secrets.ts`), bound to the workspace and to its column and
  row (`accounting_tokens.refresh_token_enc/<row id>`): a ciphertext moved to another row or column does not open.
- `freshAccessToken` gives the access token while it has more than a minute left. Otherwise it takes the row's refresh
  lease (`accounting_token_lease`: one holder, 60 seconds, under the row's lock), reads the tokens the lease returned
  (another holder may have refreshed them a moment ago), refreshes with the provider outside any transaction, and
  stores the new pair only if it still holds the lease and the version it read (`accounting_token_store`, a
  compare-and-set that bumps the version). A caller that finds the lease taken waits for the holder and reads what it
  stored. So two refreshes never send the same refresh token, and a slower one never overwrites a newer pair: with
  rotation, either would lock the connection out.
- A refresh the provider refuses as invalid (`invalid_grant`) marks the connection **needs reconnect**; one that
  fails for a while (5xx, a timeout, a 429) leaves it connected and backs off (X8).
- A crash between the provider's answer and the store loses the new pair; the old refresh token stays usable for the
  provider's grace period, so the next run recovers. After that the card asks to reconnect.
- Cost if wrong: a reconnect.

**X6. Reading Xero.** (`src/lib/xero/`)
- Scopes: `offline_access accounting.invoices.read accounting.contacts.read accounting.settings.read`. No `openid`,
  `profile` or `email`: Vestiarion needs nothing about the Xero user. Read-only scopes: writing payments back asks for
  `accounting.payments` later, with a reconnect.
- Bills: `where=Type=="ACCPAY"`, `order=UpdatedDateUTC ASC`, `pageSize=100`. The backfill adds `Statuses=AUTHORISED`
  and no `If-Modified-Since`; an incremental run sends `If-Modified-Since` and every status, so a bill paid, voided or
  deleted later is seen. Ordered by update time, a change during a run lands on a later page, not between two read
  ones. `summaryOnly` is not used: it leaves out fields this needs.
- Contacts: `order=UpdatedDateUTC ASC`, paged the same way; only suppliers (`IsSupplier`) are kept, as links with
  their name. A contact's own bill names it too, so a bill never waits for its contact.
- Accounts: read when an owner or admin opens the picker (I14), never stored whole.
- Mapping (`src/lib/xero/map.ts`, pure): `AUTHORISED` with an amount due is `open`; `PAID`, or `AUTHORISED` with
  nothing due, is `paid`; `VOIDED` `voided`; `DELETED` `deleted`; `DRAFT` and `SUBMITTED` `draft`. Dates from
  `DueDateString`/`DateString`, else from the `/Date(…)/` form. Amounts are JSON numbers, kept as exact decimals of at
  most the currency's places. A bill's number is its `InvoiceNumber` (the supplier's reference in Xero's screens).
- Cost if wrong: one mapping function, tested against recorded Xero-shaped fixtures.

**X7. Syncing: on connect, on Sync now, and every 15 minutes.**
- Connecting starts the first sync after the answer (`after()`); **Sync now** runs one in its action; the sweeper,
  `POST /api/platform/accounting-sync` (the agent's bearer token, Supabase Cron every 15 minutes,
  `.github/workflows/accounting-sync.yml` by hand), runs each connection due (`accounting_connections_due`: connected,
  past its `next_sync_after`, not leased) until 240 seconds have gone, and revokes and deletes pending rows past
  their deadline.
- One run per connection at a time: a run takes the connection's sync lease (five minutes) with a compare-and-set
  update, and lets it go at the end. A run reads contacts, then bills: at most 20 pages of each from the sweeper, 10 on
  the first sync after connecting, 5 on **Sync now**; the next run goes on from there.
- External calls and database writes are separate steps: a page is read, then written, then the next is read; no
  call to Xero happens inside a transaction.
- Cost if wrong: a run that waits for the next one.

**X8. Rate limits, backoff and checkpoints (I13).** (`src/lib/connectors/backoff.ts`, `cursors.ts`)
- After every page written, the cursor keeps the next page and the latest change read. A run that stops for any reason
  resumes there, with the same `since`, and re-reading a page is harmless (X10's version check).
- A 429 with a `Retry-After` of at most 5 seconds is waited for once in the run; a longer one stops the run, keeps the
  checkpoint, and sets `next_sync_after` to the time Xero gave (at most a day). The card says "Xero asked Vestiarion to
  slow down. Syncing again at 14:05 UTC."
- A 5xx, a timeout or a malformed answer counts a failure: the next run waits 1, 2, 4… minutes, at most an hour. Any
  success resets it.
- A 401 refreshes the token once and tries again; a refresh refused, or a 403 (the organisation disconnected the app
  in Xero), marks the connection **needs reconnect**.
- A run that reads the last page moves the cursor on: the backfill becomes incremental from the time it started, less
  five minutes, so nothing changed during it is missed; an incremental run's next `since` is the latest change it read.
- Paging in update order has one gap: a row on a page already read that changes during the run moves to the end, and
  the first row of the next page moves up, unseen. So a run of more than one page that read a change made during it
  (within five minutes of its start, for the two clocks) reads again from page 1 with the same `since`.
- A row can also leave the read on a page already read: a backfill reads approved bills only, and one paid or voided in
  Xero between two of its pages is no longer among them, so the next one moves up unseen just the same, and is never
  read again (its update time is older than the backfill). Each page carries Xero's count of what the read matches
  (`pagination.itemCount`), kept on the cursor as `run_total`; a later page of the same run with a smaller count reads
  again from page 1 too.
- Cost if wrong: a slower catch-up; no bill is added twice (X10).

**X9. A bounded backfill.** On the first connection, `window_from` is set to 90 days before it, and kept on reconnect.
A bill comes into the review list only while it is open, and only when it is due on or after `window_from` or dated on
or after it. So the open bills come in, those overdue by up to 90 days included, and a bill open for years does not
flood the list. Cost if wrong: an old open bill is added with the form or a list instead.

**X10. One bill, one row, never two payables.** (`planBill`, `src/lib/connectors/bills.ts`, pure)
- Every bill read is compared with its row by version (Xero's `UpdatedDateUTC`): an older or equal version is
  ignored, so re-reading a page, two runs, or a resumed run change nothing.
- A new open bill in the window becomes a row in review; a closed one, or one outside the window, is not kept.
- A row in review follows its bill: new facts, and it leaves the list once the bill is paid, voided, deleted or back
  in draft (`source_status`), and comes back if Xero reopens it.
- A row already added stays added: Xero's changes are recorded on it, and a bill paid, voided or deleted in Xero
  after it was added is marked so, with a signed `accounting_bill_closed` entry, and shown beside its invoice. The
  invoice is never deleted and never added again; whatever the agent or a person does with it is unchanged.
- A dismissed row stays dismissed.
- Paying a bill twice: a bill in Xero's own currency becomes a payable only in shadow mode (X11), which pays on Arc
  testnet; so in this version a bill paid in Xero and then by the agent moves no real money. When USD bills can be
  paid in USDC on Arc mainnet, the agent must hold a payable whose source bill closed: a guardrail of its own, before
  that ships.
- Cost if wrong: a bill in the list twice is refused by the duplicate check of X11.

**X11. The same check-then-add path as a bill list.** (`src/lib/connectors/review.ts`, `src/lib/commands/accounting.ts`)
- A bill in review is read as a row of a bill list (`ReadRow`) and given its fate by `fatesOf`
  (`src/lib/bill-import/rows.ts`) with the facts `checkBillList` reads: the counterparties, the invoices it could
  repeat, shadow mode and each day's rate. So the duplicates rule, the currency rules (outside shadow mode only USDC
  and EURC; another currency only in shadow mode, converted to USDC at the day's rate; never VND), the currency's
  decimals and the form's own schema are the import's, word for word.
- The supplier: the counterparty its contact is linked to; else the one counterparty with its name; else a new one,
  added when the bill is: a vendor, no payment address (the agent holds a payment until a person adds and confirms
  one, as for any counterparty without an address), a payment limit of the largest of its bills being added, and
  purchase orders needed, the platform's default, which Counterparties changes. A name more than one counterparty
  has is refused, as in an import. Once added, the contact is linked to it.
- The panel asks, for the bills it adds, whether their goods or services were received, as the email drafts do.
- `accounting.add_bills` checks every chosen bill again on the server, from the rows, never from the browser, adds
  each through `addInvoice` (its gate, its insert, its signed `create_invoice` entry, the cycle it starts), and marks
  the row added and the link. A bill it cannot add says why; the rest are still added.
- The entry says `via: "xero"` and `xero: { tenantId, billId, contactId, invoiceNumber }`; a counterparty made for it
  says `via: "xero"` and `xero: { tenantId, contactId }`.
- The bill's approval in Xero is not Vestiarion's approval, nor its purchase order: the agent and its guardrails decide
  it as any other bill, and a supplier that needs purchase orders needs one on file.
- Cost if wrong: one adapter over the import's own functions.

**X12. Consent, in plain words, before connecting.**
- The connect page says: what is read (bills, suppliers and the chart of accounts of the organisation picked); who
  sees it (the workspace's members; the agent, whose model provider sees each bill's facts to decide it and may not
  train on them); that Vestiarion never uses Xero data to train or improve any model, and passes it to no one else
  without the workspace's say; and that disconnecting stops reading at once. **I agree** is a checkbox the person
  ticks; the route refuses without it.
- The version (`xero-2026-10-12`) and time go into the state, the connection, and a signed `accounting_connected`
  entry. `/terms` and `/privacy` say the same.
- *Since `xero-2026-10-15`*: the model provider sentence says the provider sees each bill's facts under its own API
  terms (DeepSeek's, on the hosted service), and the connect page links its API terms and privacy policy. The earlier
  promise that it may not train on them had no basis in those terms.
- Cost if wrong: new words and a new version; old connections keep the version they agreed to.

**X13. Disconnecting.** An owner or admin presses **Disconnect Xero**: the refresh token is revoked at Xero (best
effort: a failure is logged and the connection is disconnected here all the same), the tokens are deleted, the
connection is marked revoked with who and when, and a signed `accounting_disconnected` entry records it. Links,
cursors, the review list and every invoice added stay. Revoking the token ends this app's access granted by it; the
connection's organisation stays in Xero's own list until removed there.

**X14. The payment account (I14).**
- An owner or admin opens **Choose the account** on the Xero card: Vestiarion reads the chart of accounts and offers
  the active accounts that can take a payment (bank accounts, and accounts Xero marks as taking payments). Never a
  revenue or expense account, and never one picked for them: until someone chooses, there is none. The bank accounts
  come first and alone; the others (clearing, an owner's equity or drawings) only under **Show other accounts that
  take payments**, with a caution, since a supplier payment booked from them is almost always wrong.
- Picking one shows a preview: "A payment of 1,250.00 USDC to Acme Supplies for bill INV-0042 will be booked in Xero as
  a payment of 1,250.00 USD from Arc USDC wallet (090), with the Arc transaction as its reference." The bill is one
  still open in Xero, in US dollars, with an amount due, one added to Vestiarion first; with none, the line says it is
  an example ("For example, a payment of 100.00 USDC for a bill will be booked…"), never a payment of 0.00. A non-USD
  account says USDC is booked as USD (and EURC as EUR), so a USD account fits. Network fees are not booked to it.
- **Use this account** reads the account again from Xero, keeps its id, code, name and currency on the connection,
  and records `accounting_payment_account_chosen`. Nothing is written to Xero in this version.
- Cost if wrong: one choice to make again.

**X15. Status in business words.** The card says, from the connection alone: "Connected to Demo Company (Global)",
"Last synced 5 minutes ago" (or "Not synced yet"), "3 bills waiting for review" with a link to them, "Xero needs you
to reconnect" with **Reconnect Xero**, and the last error ("Xero did not answer. Vestiarion tries again at 14:05
UTC."). It never says connected while the last run failed: a failure turns the line to the error. A run that ended
early on a checkpoint says "Syncing: 2 of Xero's pages read so far".

**X16. Before the migration runs, nothing breaks.** With the variables set and the tables missing, the card says
"Xero is not set up on this deployment yet", the connect page says so, the review list is not shown, and the sweeper
answers that it has nothing to do. A missing table or function is told apart from every other error by its code
(`PGRST205`, `PGRST202`, `42P01`, `42883`). Without `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`, the card and the routes
are not there, as Slack's.

**X17. What never leaves.** Tokens are read only in `token-store.ts` and sent only to Xero. Logs carry a label, a
status code and the workspace id, never a token, a body or a URL with a code. Ledger entries carry ids, names and
amounts. Model prompts carry a bill's facts as any bill's; webhooks carry the entries.

**X18. The ledger.** New entries, domain `system`: `accounting_connected` (actor `human`), `accounting_disconnected`
(`human`), `accounting_payment_account_chosen` (`human`), `accounting_bill_closed` (`system`); and, domain `ap`,
`accounting_bills_dismissed` (`human`), as an emailed invoice's dismissal is recorded. `create_invoice` and
`create_counterparty` gain `via: "xero"` and `xero`. They reach webhooks, so the changelog lists them. Syncs themselves
write no entry: they would flood the ledger every 15 minutes, and the card says how the last one went.

**X19. Where it shows.**
- Settings, Integrations, **Xero** (`XeroPanel`): the status, **Connect Xero**, **Sync now**, **Disconnect Xero**, the
  payment account.
- Bills & receivables, **From Xero: N bills to add** (`XeroBillsReview`): each bill with its supplier, number, amount
  (and the USDC it is added at in shadow mode), due day and fate; ticks; **Add, goods received**, **Add, not received
  yet**, **Dismiss**. Below, any bill added that Xero since closed.

## Not in this version

- Writing payments back to Xero (the account is chosen now), webhooks from Xero (polled instead; no webhook key yet),
  QuickBooks, credit notes, attachments, multi-currency payables outside shadow mode, and holding a payable whose Xero
  bill closed (X10).

## Testing

- Pure: the mapping against recorded Xero-shaped fixtures (statuses, dates, amounts, currencies, paging,
  `If-Modified-Since`, paid and voided later), `planBill`, the cursor's checkpoints, backoff and `Retry-After`, the
  status words, the review rows and fates.
- The refresh: one refresh for two callers at once, a stale store refused, `invalid_grant` to reconnect.
- The sync runner against a fake provider and fake stores: resume after a 429, needs reconnect, budget.
- The OAuth callback: state mismatch, expired state, another person, a non-member, consent missing, one and several
  organisations, a cancel.
- The migration on PGlite: tenant isolation, the token table closed to the tenant role, the lease and the store, the
  due list, cascades, a second run.
- The settings card and the review list render with sample data (`/docs-shots`).
