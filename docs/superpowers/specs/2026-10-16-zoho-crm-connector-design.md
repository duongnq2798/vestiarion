# Zoho CRM: won deals in, to plan their collections

Date: 2026-10-16. Status: decided (autonomy grant 2026-10-05; the partner said to go on after F14's Zoho Books part on
2026-10-16). Roadmap: F14, its Zoho CRM half. Builds on the HubSpot connector (`2026-10-12-hubspot-connector-design.md`,
H1-H21), Pipedrive's (`2026-10-14-pipedrive-connector-design.md`, P1-P20) and Zoho Books' Zoho OAuth
(`2026-10-16-zoho-books-connector-design.md`, Z2-Z4). Where Zoho CRM differs, the decision says why.

## Why

A small business that sells on Zoho CRM should not open another tool to see whether a deal's money came in, nor type a
won deal again to bill it. Connecting Zoho CRM once brings its won deals in with their account and contact; Plan
collections turns one into a Vestiarion deal through the New deal form, filled in; the deal's page shows the money that
actually arrived on Arc and its cash readiness; and a deal changed in Zoho CRM afterwards says so. With Zoho Books (the
first half of F14), a business on Zoho brings both its bills and its won deals in without leaving its stack.

## What Zoho CRM offers, as of October 2026

Read from Zoho CRM's API v8 documentation (scopes, get records, get deleted records, organization data, layouts and
pipelines, API limits) and Zoho Accounts' multi data center notes.

- **OAuth**: Zoho's, as for Zoho Books: the same accounts servers per data center, the same `location` on the
  callback, a one hour access token and a refresh token that lasts until revoked. Scopes are
  `ZohoCRM.<scope>.<READ|...>`: `ZohoCRM.modules.deals.READ`, `.accounts.READ`, `.contacts.READ`, `ZohoCRM.org.READ`,
  `ZohoCRM.settings.layouts.READ`, `ZohoCRM.settings.pipeline.READ`. The token answer carries `api_domain`
  (`https://www.zohoapis.<tld>`; a developer edition `developer.zohoapis…`, a sandbox `sandbox.zohoapis…`).
- **Records**: `GET /crm/v8/Deals` with `fields` (required, at most 50), `per_page` up to 200, `page` for the first
  2,000 records and `page_token` (`info.next_page_token`) beyond, `sort_by=Modified_Time`, `sort_order=asc`, and an
  `If-Modified-Since` header; 204 for no records, 304 for nothing changed. `info.more_records` says whether a page
  follows. `?ids=` reads records by id.
- **A deal**: `id`, `Deal_Name`, `Amount`, `Currency` (in a multi-currency organization), `Closing_Date`
  (`yyyy-MM-dd`), `Stage`, `Pipeline`, `Account_Name` and `Contact_Name` (`{ name, id }`), `Owner`, `Modified_Time`
  (`yyyy-MM-ddTHH:mm:ss±HH:mm`).
- **A stage's outcome**: each pipeline's stages (`GET /crm/v8/settings/pipeline?layout_id=`, a layout from
  `GET /settings/layouts?module=Deals`) carry `forecast_type`: `Open`, `Closed Won` or `Closed Lost`.
- **The organization**: `GET /crm/v8/org`: `id`, `company_name`, `iso_code` (the home currency), `mc_status`,
  `time_zone`, `type` (production, sandbox, developer).
- **Limits**: API credits per rolling 24 hours by edition (the Free edition 5,000; paid editions from 50,000), and a
  concurrency limit; past either, 429 `TOO_MANY_REQUESTS`, no Retry-After. Free, trial and paid editions all have the
  API. A free Developer Edition exists, on its own API domain.

## Decisions

**C1. A third CRM on the connector core.** (`src/lib/zohocrm/`) `ProviderId` gains `zohocrm`, of kind `crm`. Zoho CRM
implements `CrmProvider`; the sync runner, the sweeper, the token lease, the cursors, the list, the review, Plan
collections and change detection are the core's. Its words: organization, accounts, "won deals", idle days 0, the
customer an "account". Not `exclusive`: several workspaces may connect one organization, as with Xero, since nothing is
written there for them to contend over.

**C2. The Zoho client, shared.** One Zoho "Server-based Applications" client serves Zoho Books and Zoho CRM alike, so
Zoho CRM is on with `ZOHO_BOOKS_CLIENT_ID` and `ZOHO_BOOKS_CLIENT_SECRET`, or with `ZOHO_CRM_CLIENT_ID` and
`ZOHO_CRM_CLIENT_SECRET` when both are set. Its redirect URI, `<origin>/api/integrations/zohocrm/callback`, is
registered on the client beside Zoho Books'. Off without a client: no card, no pages, the routes answer 404.

**C3. Zoho's OAuth, with Zoho CRM's scopes.** Zoho Books' OAuth calls (`src/lib/zohobooks/oauth.ts`) take the app's
scopes and the name its logs carry; Zoho CRM passes its six read scopes. Everything else is Z3 and Z4 unchanged: the
data center from the callback's `location`, read after every other check and only from the fixed table; each token
kept as `<data center>|<token>`; a refresh at the token's own data center keeping the refresh token. Zoho keeps a
limited number of refresh tokens per user (20, by its OAuth notes), shared by every app on the client: Disconnect revokes
the connection's own, so connecting again does not pile them up; a person who connects many times without disconnecting
could see an old connection asked to reconnect.

**C4. Connecting.** `/integrations/zohocrm`, `/integrations/zohocrm/connect` (workspace, consent, **Continue to Zoho
CRM**), `POST /api/integrations/zohocrm/connect` and `GET /api/integrations/zohocrm/callback`: the core's signed state,
its nonce cookie and its checks. One organization per grant (`GET /org`), so no pick. A workspace connected to another
Zoho CRM organization is refused (`other_organisation`); the same organization again reconnects its row.

**C5. The API domain is the data center's.** Every call goes to `ZOHO_REGIONS[<the token's data center>].api`
(`https://www.zohoapis.<tld>`), never to a domain an answer names. A Zoho CRM developer edition or sandbox, whose API
lives on `developer.` or `sandbox.zohoapis`, is not read in this version: its organization does not answer there, and
connecting says Zoho CRM did not finish connecting.

**C6. Which deals are won.** A stage's outcome is its `forecast_type` in the Deals layouts' pipelines, read once per run
(`Closed Won` won, `Closed Lost` lost, `Open` open), by its actual and its display value. A stage the pipelines do not
name, or a deployment whose token may not read them (a 403, an edition without pipelines), falls back to Zoho CRM's own
stage names: "Closed Won" won, "Closed Lost" and "Closed-Lost to Competition" lost, anything else open.

**C7. Mapping (pure, `map.ts`).** A deal's version is its `Modified_Time` in UTC; its amount an exact decimal; its
currency its own `Currency`, else the organization's home currency (`iso_code`, read once per run); its close day
`Closing_Date`; its customer `Account_Name`, with the email of its `Contact_Name` (read by id, one call a page). A deal
without an id or a last change is left out.

**C8. Reading.** 200 deals a page, oldest change first. A backfill reads every deal (the core keeps the open ones and
those won in its window, X9 and H9); an incremental run every deal changed since five minutes before the cursor, by
`If-Modified-Since`. Pages by number for the first 2,000, then by Zoho's `page_token`, which the reader remembers; a run
resumed past page 10 walks the tokens from the last one known. The linked deals and the won deals still offered are
read again by id each run; one Zoho CRM no longer has is `deleted` (the core's H12). No webhook: the sweeper reads
every connection every 15 minutes, and **Sync now** at once. Zoho CRM's notifications API needs a channel per module
and a renewal; not in this version.

**C9. The reference** a planned deal carries is `zohocrm-<id>`: it says where the deal came from, and a reference typed
by hand the same way links its deal at the next sync, as HubSpot's and Pipedrive's do.

**C10. Plan collections.** As H11 and P9: a won deal with an amount above zero and an account is offered; one without
says "No amount in Zoho CRM" or "No account in Zoho CRM". The New deal form is filled in from it (customer, title,
total, currency as the core's rules allow, start, the reference read only); nothing is made before the person confirms.
`?zohocrm=<row>` opens it on Bills & receivables, Receivables.

**C11. Consent** (`zohocrm-2026-10-16`): what is read (deals with their accounts and contacts: names, amounts,
currencies, closing dates, pipelines and stages, each deal's contact email, and the organization's name and currency),
that nothing is written, that the model provider may see a deal's facts under its own API terms, no training, and that
disconnecting revokes the access at Zoho.

**C12. Visibility.** The card says Vestiarion sees the deals the Zoho CRM user who connected can see, and writes nothing.

**C13. The ledger.** No new action. `deal_signed` and `deal_revised` say `via: "zohocrm"` with
`zohocrm: { organizationId, dealId, accountId }`; `create_counterparty` and `counterparty_notice_email_changed` with
`zohocrm: { organizationId, accountId }`; `accounting_connected`, `accounting_disconnected`, `crm_deal_changed` and
`crm_deal_change_kept` with `provider: "zohocrm"`.

**C14. Read only, held by the database.** No receipts writer: the card offers no switch, and migration 0123 leaves
`accounting_connections_writes_check` and `crm_receipt_writes_provider_check` taking HubSpot and Pipedrive only, so a
Zoho CRM connection can never turn writing on, nor have a write queued.

**C15. Disconnecting.** The refresh token revoked at Zoho, the tokens deleted, the connection revoked with a signed
`accounting_disconnected`. Planned deals, links and rows stay.

**C16. Where it shows.** Settings, **Zoho CRM** (`ZohoCrmPanel`, beside Zoho CRM's logo); Bills & receivables,
Receivables, **From Zoho CRM: N won deals** (`CrmDeals`), and "N won deals in Zoho CRM" under Waiting for review; a
deal's page, **Changed in Zoho CRM**.

**C17. Migration 0123.** The provider checks of `accounting_connections`, `accounting_tokens` and `external_links`
take `zohocrm`, each replaced only while it does not yet (0116's rule), and `zohocrm_connector_ready(p_org_id)`, which
the connect flow, the card and the list ask before anything else. Before it runs, the card says Zoho CRM is not set up
on this deployment yet, and nothing breaks.

**C18. Errors.** 401 `unauthorized` (a refresh, then a reconnect), 403 `forbidden`, 429 `rate_limited` a minute later,
5xx and timeouts `unavailable`, an answer that does not read `bad_response`: the core's words on the card.

## Not in this version

Writing receipts back to Zoho CRM deals; Zoho CRM's notifications (webhooks); developer edition and sandbox
organizations; several organizations per Zoho user (`X-CRM-ORG`); Zoho CRM's quotes, sales orders and invoices; linking a
Zoho CRM deal to a Zoho Books invoice.
