# Bring customers and deals in from HubSpot

Date: 2026-10-12. Status: decided (autonomy grant 2026-10-05). Roadmap: F01. Stage: sandbox, against a HubSpot
developer test account. Builds on the connector core of the Xero connector
(`docs/superpowers/specs/2026-10-12-xero-connector-design.md`, X1-X19) and on deals
(`docs/superpowers/specs/2026-10-12-deal-schedule-design.md`, D1-D16); where this differs, the decision says why.

## Why

A services business sells in HubSpot: its customers are companies there, and a signed deal is a deal moved to
"Closed won". It will not type the customer and the deal again to plan its collections. Connecting HubSpot once
brings its companies and deals in; a won deal becomes a Vestiarion deal with one press and the New deal form, and a
deal changed in HubSpot afterwards says so on the deal, for a person to act on.

## What HubSpot offers, as of October 2026

- **OAuth 2.0, authorization code**, for an app on the developer platform (`hsproject.json`, platform 2026.09,
  distribution marketplace): authorize at `https://app.hubspot.com/oauth/authorize` with `client_id`, `redirect_uri`,
  `scope` (space-separated, the app's required scopes) and `state`, and optionally `optional_scope`. A cancel comes
  back with `error`. Tokens at `POST https://api.hubapi.com/oauth/2026-03/token`, form-encoded, the client id and
  secret in the body (the date-versioned endpoints replace v1 and v3, which put them in the URL). The answer carries
  `access_token` (30 minutes, `expires_in`), `refresh_token`, `hub_id` and `scopes`. A refresh token lives until the
  app is uninstalled from the account or the token is revoked; a refused one answers `400` with `error:
  "invalid_grant"` (`status: "BAD_REFRESH_TOKEN"`). `POST /oauth/2026-03/token/introspect` says the account's
  `hub_domain`; `POST /oauth/2026-03/token/revoke` deletes a refresh token.
- **One account per grant.** An install is to one HubSpot account (its hub id); the token answer names it.
- **Account details** (`GET /account-info/2026-03/details`, scope `oauth`): `companyCurrency` and `timeZone`.
- **CRM objects** (`/crm/objects/2026-03/{deals,companies,contacts}`): a deal has `dealname`, `amount` (text),
  `deal_currency_code` (empty when the account has one currency), `closedate` (an instant), `pipeline`, `dealstage`,
  `hs_is_closed`, `hs_is_closed_won`, `hs_lastmodifieddate`. Search (`POST …/search`) takes up to five filter
  groups (OR) of up to six filters (AND), one sort, `limit` up to 200 and `after` (an offset written as an integer);
  it returns `total`, `results` and `paging.next.after`, never archived (deleted) records, at most 10,000 results per
  query, and may lag a change by a few moments. Batch read (`POST …/batch/read`, up to 100 ids) returns the records
  that exist and not archived ones.
- **Associations** (`POST /crm/associations/2026-03/{from}/{to}/batch/read`): each deal's companies and each
  company's contacts, with their association types (the label "Primary" for a deal's primary company).
- **Pipelines** (`GET /crm/pipelines/2026-03/deals`): each pipeline's stages, with `metadata.isClosed` and
  `metadata.probability` (`1.0` closed won, `0.0` closed lost).
- **Limits**: an app distributed on the marketplace gets 110 requests every 10 seconds per installed account, search
  five a second. Past a limit HubSpot answers `429` with `policyName` (`TEN_SECONDLY_ROLLING`, `SECONDLY`, `DAILY`)
  and `X-HubSpot-RateLimit-Interval-Milliseconds`.
- **Scopes**: `crm.objects.deals.read` reads deals and their pipelines; `crm.objects.companies.read` and
  `crm.objects.contacts.read` the companies and contacts. The partner's app config asks for these, with `oauth`, as
  required, and for `crm.objects.deals.write` as optional.

## Decisions

**H1. A CRM on the connector core.** (`src/lib/connectors/crm*.ts`, `src/lib/hubspot/`)
- `ProviderId` gains `hubspot`; `PROVIDER_KINDS` says `crm` for it and `accounting` for Xero and QuickBooks, and the
  core's words follow the kind (deals, not bills).
- What the connect flow, the token refresh and disconnecting use of a provider is its own type, `ConnectingProvider`
  (id, label, scopes, authorize URL, code exchange, organisations, refresh, revoke, and `exclusive`).
  `AccountingProvider` keeps bills, contacts and accounts; `CrmProvider` adds `kind: "crm"` and two reads: a page of
  deals with their companies, and deals by id. Nothing under `src/lib/connectors/` names HubSpot.
- A CRM sync runner (`crm-sync.ts`) beside the accounting one, on the same lease, cursors, backoff, token refresh and
  status words; the sweeper runs a CRM connection with it.
- Cost if wrong: a second CRM (Pipedrive, Salesforce) may need a wider `ExternalDeal`; the table already takes the
  connection, not the provider.

**H2. The schema (migration 0105, additive, re-runnable).**
- The provider checks of `accounting_connections`, `accounting_tokens` and `external_links` take `hubspot`;
  `external_links.object_type` takes `company` (and `deal`, unused yet); `accounting_sync_cursors.object_type` takes
  `deal` and `company`. Each check is dropped and added again with every value 0101 allowed plus the new ones.
- A HubSpot account is connected, not revoked, to one workspace at a time: the partial unique index
  `accounting_connections_hubspot_one_workspace`, and `accounting_connections_by_external(provider, ids)`, the service
  role's, which the connect flow asks first. It is the same function, word for word, as QuickBooks' (migration 0102 on
  its branch), so either migration may run first.
- `crm_deals`, a tenant table: each deal read, once per connection and HubSpot id, with its facts as HubSpot has them
  now (name, amount, currency, close day, pipeline and stage with their labels, `stage_state` open, won or lost, the
  company's id and name, the company's main contact's email), its version (`hs_lastmodifieddate`), `source_status`
  (`present`, `deleted`), the Vestiarion deal it became (`deal_id`, a composite foreign key to `deals`), `baseline`
  (HubSpot's facts when it was linked, or when a person last reviewed its changes) and `flagged` (the changes last
  recorded in the ledger). Row-level security as 0101: read, insert and update by the workspace's tenant role, never
  delete; everything goes with the workspace.
- Cost if wrong: an additive migration.

**H3. Who does what.**
- Connecting, disconnecting and **Sync now**: `integrations.manage` (owner, admin), as Xero.
- **Plan collections** (a won deal to a Vestiarion deal): `crm.plan_deal`, `records.write`, as `deal.create`;
  **Keep the deal as it is** (changes reviewed without a new version): `crm.keep_change`, `records.write`, as
  `deal.change`; **Use this email** (a contact's email as a customer's billing email): `crm.fill_email`,
  `records.write`, as changing a billing email. All three run from the console only.
- Every member sees the HubSpot card and the review; only those who may act get the buttons.

**H4. Connecting.**
- `/integrations/hubspot`, `/integrations/hubspot/connect` (workspace, consent, **Continue to HubSpot**),
  `POST /api/integrations/hubspot/connect` and `GET /api/integrations/hubspot/callback`, through the core's flow:
  the same signed state and nonce cookie (path `/api/integrations/hubspot`), the same checks (state, expiry, the
  person who started, still a member who may manage integrations, consent), the same outcomes in
  `?hubspot=<outcome>#hubspot`.
- The authorize URL asks for `oauth crm.objects.companies.read crm.objects.contacts.read crm.objects.deals.read` and
  no optional scope: this version writes nothing to HubSpot, so it does not ask to. A later feature that writes asks
  for `crm.objects.deals.write` with a reconnect.
- The account is the token answer's `hub_id`; its name is the introspection's `hub_domain`, else "HubSpot account
  <hub id>". One account per grant, so there is never a choice to make and no pending grant.
- A hub connected to another workspace is refused (`other_workspace`, "This HubSpot account is connected to another
  Vestiarion workspace"), and the tokens just granted are neither kept nor revoked. Two workspaces on one account
  would bring the same won deals in twice and plan two sets of receivables for one sale. The unique index closes the
  race between two callbacks.
- A workspace connected to another hub is refused (`other_organisation`); the same hub again reconnects its row.
- Before migration 0105 has run, the connect route and the card say HubSpot is not set up yet (a probe of
  `crm_deals`, `ConnectDeps.ready`), rather than send the person to HubSpot for nothing.
- Cost if wrong: the flow is the core's, tested by its failures.

**H5. Tokens.** The core's lease and compare-and-set (X5) unchanged. A refresh answer without a refresh token keeps
the one sent; `invalid_grant` marks the connection **needs reconnect**; anything else backs off. Cost if wrong: a
reconnect.

**H6. Reading HubSpot.** (`src/lib/hubspot/`)
- Endpoints of the 2026-03 API version, named once (`HUBSPOT_API_VERSION`), on `https://api.hubapi.com`.
  Cost if wrong: one constant, when HubSpot retires the version.
- Deals by search, 100 a page, sorted by `hs_lastmodifieddate` ascending, `after` = (page − 1) × 100, so the core's
  page-numbered cursor (X8) works unchanged. A backfill asks for open deals (`hs_is_closed = false`) or won deals
  closed on or after the window's first day (`hs_is_closed_won = true` and `closedate ≥ window_from`). An incremental
  run asks for every deal changed since five minutes before `since`, whatever its stage: search lags a change by a
  few moments, and a deal read twice is ignored by its version.
- The search caps a query at 10,000 results: the page that reaches it ends the run as the last page read (`capped`),
  with no restart; a backfill becomes incremental, an incremental run resumes from the latest change it read, that
  instant itself and not five minutes before it, or more than 10,000 deals changed within five minutes (a bulk edit)
  would be read again, the same ones, run after run, and no change after them ever. When every result read shares the
  instant the run started at, the next run starts a millisecond after it: a search in that order reaches no further.
  Cost if wrong: an account with more than 10,000 open deals brings in the first 10,000 by last change, and more than
  10,000 deals changed at one same millisecond are read only as far as the cap.
- For each page: the deals' companies (associations; the one labelled Primary, else the lowest id), those companies
  (batch read: `name`, `domain`), their contacts (associations; the lowest id of those whose primary company it is,
  else the lowest id) and those contacts' `email`. Up to five calls a page.
- Pipelines and account details are read once per run: stage labels; won or lost from the deal's own
  `hs_is_closed_won` and `hs_is_closed`, else from the stage's metadata; the account's currency for a deal without
  `deal_currency_code`; and its time zone for the close day (HubSpot's `closedate` is an instant; the day is the one
  in the account's time zone).
- Deleted deals never appear in search, so each run reads the linked deals by id (batch read, 100 at a time, at most
  500): a linked deal HubSpot no longer returns is `deleted`; one that comes back (restored) is `present` again.
- Mapping is pure (`src/lib/hubspot/map.ts`): amounts as exact decimals (refused beyond six places), currencies
  three capital letters, an unreadable record left out, an unreadable answer a bad response.
- Cost if wrong: one mapping function, tested against recorded HubSpot-shaped fixtures.

**H7. Syncing.** On connect (`after()`, 10 pages), **Sync now** (5 pages) and the sweeper (20 pages, every 15
minutes, `POST /api/platform/accounting-sync`), with the core's sync lease, checkpoints (object type `deal`) and
backoff (X7, X8). Each page is read, then written; no HubSpot call runs inside a write.

**H8. Rate limits.** A `429` waits `Retry-After` when HubSpot sends it; else one second for `SECONDLY` (search), ten
seconds (the interval header) for `TEN_SECONDLY_ROLLING`, and an hour for `DAILY`. A wait of at most five seconds is
spent in the run once (X8); a longer one ends the run with its checkpoint and sets the next sync. The card says
"HubSpot asked Vestiarion to slow down. Syncing again at 14:05 UTC."

**H9. A bounded backfill.** `window_from` is 90 days before the first connection, kept on reconnect (X9). A deal is
kept when it is open, or won or lost with a close day on or after `window_from` (or none); a row already kept follows
its deal whatever happens to it. So the open pipeline and the last 90 days of won deals come in, and a deal won years
ago stays out until someone changes it. Lost deals are kept only once they had a row.

**H10. One HubSpot deal, one row, one Vestiarion deal.**
- A deal read is compared with its row by version: older or equal is ignored (`planCrmDeal`, pure), so re-reading a
  page, two runs or a resumed run change nothing.
- A Vestiarion deal is made only by a person, through the New deal form and `create_deal`; its `external_ref` is the
  HubSpot deal id, which `deals` keeps unique per workspace, so a second plan for the same HubSpot deal is refused
  ("This HubSpot deal is planned already"). A Vestiarion deal whose reference was typed by hand as a HubSpot deal id
  is linked at the next sync, with HubSpot's facts then as its baseline.
- Cost if wrong: a deal planned in another workspace is not seen; H4 keeps one account to one workspace.

**H11. Plan collections: the New deal form, prefilled.** (`dealPrefill`, pure)
- A deal is offered when it is won, still in HubSpot, has an amount above zero and a company, and is not linked. One
  without an amount or a company is listed with why ("No amount in HubSpot", "No company in HubSpot"); open deals are
  listed as **Not won yet**, read-only.
- **Plan collections** opens the New deal form prefilled (`?hubspot=<row>#plan-from-hubspot`): the customer (the
  counterparty the company is linked to by its HubSpot id; else the one client with its name; else a new customer
  with its name; two clients with the name leave the choice to the person), the title (the deal's name), the total
  and currency, the start (the close day, else today) and the external reference (the HubSpot deal id, read-only).
  The person picks how it is billed and confirms; nothing is made before.
- Currency, under today's rules (D3): USDC and EURC as they are; a deal in US dollars is planned in USDC, and one in
  euros in EURC, at par, as Xero books USDC as USD (X14); any other code only in shadow mode, as the deal's own
  currency (converted at release, D3); otherwise USDC with the total left for the person to type, and a note giving
  HubSpot's amount. VND is never offered and never named: such a deal's amount is not shown, and the note asks for
  the total in USDC. An amount with more decimals than the currency writes is left for the person to type too.
- `crm.plan_deal` reads the HubSpot row again on the server (won, present, a company, not linked), forces the
  reference, confirms the deal through `confirmDeal` (`create_deal`), links the row (`deal_id`, `baseline`) and the
  company to the customer (`external_links`, object `company`, unless either is linked already), and records the deal's
  `deal_signed` entry with `via: "hubspot"` and `hubspot: { hubId, dealId, companyId }`; a customer added with it gets
  `create_counterparty` with the same `via`.
- Cost if wrong: one pure function; the form is the one every deal uses.

**H12. Changes from HubSpot after a deal exists.** (`crmChanges`, pure)
- Against the baseline: the amount (or its currency) changed, the close day moved, the stage left won (to lost, or
  back to open), the deal was deleted. A cancelled Vestiarion deal shows none.
- The deal's page says **Changed in HubSpot** with each change in words; Bills & receivables counts them. Nothing is
  revised or cancelled automatically: a won deal moved to lost is flagged, and the person cancels it if it is off.
- **Change deal** opens the Change deal form prefilled (`?from=hubspot#change`): the new total when HubSpot's amount
  is in the deal's currency (USD for USDC, EUR for EURC), a correction proposed for the lines not invoiced (D8), and
  a reason naming the changes. Saving it is the revise path (`revise_deal`); the version's `deal_revised` entry says
  `via: "hubspot"`, and the changes count as reviewed (the baseline becomes HubSpot's facts now).
- **Keep the deal as it is** reviews them without a version, with a signed `crm_deal_change_kept`.
- The sync records a new set of changes once, in a signed `crm_deal_changed` (actor `system`): what changed, from and
  to; the same set is not recorded again (`flagged`).
- Cost if wrong: the person reviews a change they did not need to; never a receivable changed behind them.

**H13. Customers.** A company is linked to the counterparty its deal was planned for, by HubSpot id
(`external_links`, object `company`), so the next plan finds it whatever its name. A linked customer with no billing
email, whose company's main contact has one, gets **Use this email** under the HubSpot list; pressing it sets the
billing email only while it is still empty (`counterparty_notice_email_changed`, with `via: "hubspot"`). Never
automatically.

**H14. Consent, in plain words, before connecting** (`hubspot-2026-10-12`): what is read (the companies, contacts and
deals of the account: names, amounts, close dates, stages, each company's main contact email); who sees it (the
workspace's members, and its agent, whose model provider may see a deal's facts to decide on its collections and may
not train on them); that Vestiarion never uses HubSpot data to train or improve any model, nor passes it on without
the workspace's say; that disconnecting stops the reading at once. Recorded in the state, the connection and the
signed `accounting_connected` entry; `/terms` and `/privacy` say the same.

**H15. Disconnecting.** As X13: the refresh token is revoked at HubSpot (best effort), the tokens deleted, the
connection marked revoked with a signed `accounting_disconnected`. Deals planned, their links and the HubSpot rows
stay; the list is hidden. Revoking is safe because the account is this workspace's alone (H4).

**H16. Status in business words**, the core's (X15) with a CRM's words: "Connected to example.com", "Last synced 5
minutes ago", "2 won deals to plan", "1 deal changed in HubSpot", "HubSpot needs you to reconnect" ("…the app was
uninstalled in HubSpot or its access was removed…"), and the last error.

**H17. Before migration 0105 runs, nothing breaks.** The card says "HubSpot is not set up on this deployment yet", the
connect route says so, the list is hidden, and the sweeper never sees a HubSpot connection. Without
`HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`, the card and the routes are not there.

**H18. What never leaves.** Tokens are read only in `token-store.ts` and sent only to HubSpot. Logs carry a label, a
status and ids. Ledger entries carry ids, names and amounts, and a masked email. Webhooks carry the entries.

**H19. The ledger.** New: `crm_deal_changed` (`system`, domain `ar`) and `crm_deal_change_kept` (`human`, `ar`).
`deal_signed` and `deal_revised` gain `via: "hubspot"` and `hubspot: { hubId, dealId, companyId }`;
`create_counterparty` and `counterparty_notice_email_changed` gain `via: "hubspot"` and `hubspot: { hubId,
companyId }`; `accounting_connected` and `accounting_disconnected` carry `provider: "hubspot"`. Syncs write no entry
of their own. The changelog lists them.

**H20. Where it shows.**
- Settings, Integrations, **HubSpot** (`HubSpotPanel`): status, won deals to plan, changes, **Connect HubSpot**,
  **Reconnect HubSpot**, **Sync now**, **Disconnect HubSpot**.
- Bills & receivables, Deals, **From HubSpot: N won deals** (`HubSpotDeals`): each won deal with its company, amount,
  close day and **Plan collections**; linked ones with their Vestiarion deal; changed ones; **Not won yet**; billing
  emails to confirm. **Plan collections** opens the prefilled New deal form above the list.
- A deal's page: **Changed in HubSpot**, **Change deal** (prefilled) and **Keep the deal as it is**.

**H21. The app config lives in the repository** (`integrations/hubspot/`: `hsproject.json`,
`src/app/app-hsmeta.json`), uploaded with the HubSpot CLI (`hs project upload`). No secret is in it.

## Not in this version

Webhooks from HubSpot (polled every 15 minutes instead), writing anything back to HubSpot (stage, payments),
line items and products, quotes and HubSpot invoices, deal owners, several pipelines' own rules, and a deal split
across several companies (the primary company is the customer).

## Testing

- Pure: the mapping against recorded HubSpot-shaped fixtures (search pages, paging and `after`, the 10,000 cap,
  associations, companies, contacts, pipelines, amounts, currencies, close days by time zone, tokens, introspection,
  429 bodies), `planCrmDeal`, `crmChanges` (amount changed, stage lost, deleted, unchanged), `dealPrefill`.
- The HubSpot client against a fake fetch: search bodies for a backfill and an incremental page, the five calls a
  page, linked deals by id, failures by status, the token requests, refresh, revoke.
- The CRM runner against a fake provider and fake stores: checkpoints, a 429 resumed, needs reconnect, deleted deals.
- The OAuth callback, mirroring Xero's: state, expiry, another person, a non-member, consent missing, a hub connected
  to another workspace, reconnect.
- The migration on PGlite: the widened checks, `crm_deals` isolation and cascade, one workspace per hub, a second run.
- The settings card and the list render with sample data (`/docs-shots`).
