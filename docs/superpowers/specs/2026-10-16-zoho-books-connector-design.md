# Bring bills in from Zoho Books

Date: 2026-10-16. Status: decided (autonomy grant 2026-10-05; the partner chose F14 on 2026-10-16). Roadmap: F14.
Builds on the connector core of `docs/superpowers/specs/2026-10-12-xero-connector-design.md` (X1–X19) and follows
`docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md` (Q1–Q19) wherever Zoho Books works the same way;
where it differs, the decision says why and what the core gained.

## Why

Zoho Books is the accounting tool of many small businesses in India, the Gulf, Southeast Asia and Europe, the markets
Xero and QuickBooks cover least. Connecting it brings its open bills into the same review list as Xero's and
QuickBooks', through the same check, so a person adds them and the agent decides them. Reading only: nothing is written
to Zoho Books.

## What Zoho offers, as of October 2026

- **OAuth 2.0, authorization code, server-based client.** Authorize at `<accounts>/oauth/v2/auth` (`client_id`,
  `scope` comma-separated, `redirect_uri`, `response_type=code`, `access_type=offline`, `prompt=consent`, `state`).
  Tokens at `<accounts>/oauth/v2/token`, client id and secret in the form body. Revoke at
  `<accounts>/oauth/v2/token/revoke?token=<refresh token>`. An access token lasts an hour; a refresh token lasts until
  the person revokes it, and a refresh answers a new access token only. Zoho may answer a refused request with HTTP 200
  and an `error` field.
- **Data centers.** Each Zoho account lives in one data center, with its own accounts server and API domain: US
  `accounts.zoho.com` / `www.zohoapis.com`, EU `.eu`, India `.in`, Australia `.com.au`, Japan `.jp`, UK `.uk`, Canada
  `accounts.zohocloud.ca` / `www.zohoapis.ca`, Saudi Arabia `.sa`, UAE `.ae` (`https://accounts.zoho.com/oauth/serverinfo`
  lists them). With multi-DC on for the client, the redirect after authorizing carries `location` (`us`, `eu`, …) and
  `accounts-server`; the code must be exchanged at that data center's accounts server, and the API called at its
  domain.
- **Scopes.** `ZohoBooks.bills.READ`, `ZohoBooks.contacts.READ`, `ZohoBooks.settings.READ` (organizations). Read only.
- **API.** `<api domain>/books/v3/<resource>?organization_id=<id>`, `Authorization: Zoho-oauthtoken <token>`.
  `GET /organizations` lists the organizations the token reaches. 100 requests a minute per organization, and 1,000 to
  10,000 a day by plan; over it, 429.
- **Bills.** `GET /bills`: `filter_by` (`Status.All`, `Status.Open`, …), `last_modified_time` (bills changed after a
  time), `page`, `per_page` (up to 200), `sort_column`. Each: `bill_id`, `vendor_id`, `vendor_name`, `status` (`draft`,
  `open`, `overdue`, `partially_paid`, `paid`, `void`, and `pending_approval` / `approved` under an approval flow),
  `bill_number`, `reference_number`, `date`, `due_date`, `currency_code`, `total`, `balance`, `last_modified_time`.
  `page_context.has_more_page` says whether a page follows. A deleted bill is never listed, and there is no change feed.
- **Vendors.** `GET /contacts?contact_type=vendor&filter_by=Status.All`: `contact_id`, `contact_name`, `company_name`,
  `status` (`active`, `inactive`), `last_modified_time`.
- **Webhooks** are workflow rules a person sets up in Zoho Books' own screens; there is no API to register one.

## Decisions

**Z1. A third accounting provider, `zohobooks`.** Its folder is `src/lib/zohobooks/`, wired in `accounting-providers.ts`
as Xero and QuickBooks are. Its words: organisation "organization", contacts "vendors", bills "open bills", idle days 0
(a refresh token lasts until revoked). One card in Settings, one review panel, one guide.

**Z2. On only with its app.** `ZOHO_BOOKS_CLIENT_ID` and `ZOHO_BOOKS_CLIENT_SECRET`, both set and the id in Zoho's form
(`1000.` and 30 letters and digits); otherwise the card, its pages and its routes are not there. The redirect URI is
`<origin>/api/integrations/zohobooks/callback`.

**Z3. The data center comes from the callback, and only from a list.** The core gained `callbackRegionParam`: a
provider that names it (`location`) gets the callback's value in `exchangeCode`, read after every other check. Zoho
Books keeps a fixed table of data centers, each with its accounts server and API domain; a `location` not in it is
refused, and `accounts-server` is never read, so a callback edited to point elsewhere sends the client secret nowhere. A
callback without `location` is the US data center, where a client without multi-DC lives.

**Z4. The data center travels with the tokens.** Each token the provider hands the core is `<data center>|<Zoho's
token>`, encrypted and kept as any other. A refresh, a revocation and every API call read the data center from the token
they are given, so no column and no core change is needed beyond Z3, and a token from one data center is never sent to
another. A refresh keeps the refresh token it was given, since Zoho answers a new access token only.

**Z5. Organizations.** `organisations` reads `GET /organizations` with the new token. One: it connects. Several: the
person picks one on the connect page, as with Xero's tenants (X4). Several workspaces may connect one organization, as
with Xero; each reads its bills on its own.

**Z6. Reading bills.** A backfill reads every bill (`filter_by=Status.All`), oldest first by `created_time`, 200 to a
page; the core keeps the open ones in the window (X9). An incremental run reads the bills changed since the cursor
(`last_modified_time`). Status: `open`, `overdue`, `partially_paid` and `approved` are open; `paid` paid; `void`
voided; `draft` and `pending_approval` draft (never brought in). A bill's version is its `last_modified_time` in UTC.
Amounts are exact decimal strings.

**Z7. Deletions are not seen.** Zoho Books lists no deleted bill and has no change feed, so a bill deleted there after
it was added stays as it is in Vestiarion; a bill voided there is seen and flagged, as in Xero. The guide says so.

**Z8. Vendors are its contacts.** Every vendor, inactive ones archived, read in full on each run (Zoho has no filter by
change time for contacts).

**Z9. No booking, no webhook.** Zoho Books has no booking provider: its card says nothing about booking, and `accounts`
answers none. Without a webhook API, the sweeper reads every connection every 15 minutes, as for Xero.

**Z10. Errors.** A 429 is `rate_limited` (with Retry-After when sent, a minute otherwise); 401 `unauthorized`; 403
`forbidden`; 5xx and timeouts `unavailable`. A token answer with an `error` is a refusal; at refresh, `invalid_code` or
`invalid_grant` means the connection needs a person (`reconnect`).

**Z11. Consent.** The connect page names what is read (bills, vendors and the organization's name and currency) and that
bill details go to the model provider for the agent's decision, under a new consent version for `zohobooks`, as for
Xero (X15).

**Z12. Migration 0122.** The provider checks of `accounting_connections`, `accounting_tokens` and `external_links` take
`zohobooks`, each replaced only while it does not yet, so a re-run never narrows a later widening (0116's rule); and
`zohobooks_connector_ready(p_org_id)`, which the connect flow asks before anyone is sent to Zoho. It takes the workspace
from the start, as the tenant data layer passes `p_org_id` to every tenant function: Pipedrive's probe took none and was
never found until 0117.

## Not now

Booking payments back into Zoho Books; Zoho's own webhooks; Zoho CRM; China's data center (its accounts are separate).
