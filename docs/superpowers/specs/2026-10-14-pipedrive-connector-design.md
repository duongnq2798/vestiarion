# Pipedrive: won deals in, receipts back

Date: 2026-10-14. Status: decided (autonomy grant 2026-10-05). Roadmap: F16. Stage: sandbox, against the partner's
private app in a Pipedrive developer sandbox. Builds on the HubSpot connector
(`2026-10-12-hubspot-connector-design.md`, H1-H21), the receipts written back to it (`2026-10-13-crm-receipts-design.md`,
R1-R9), deals and their cash readiness (`2026-10-12-deal-schedule-design.md`, `2026-10-13-deal-cash-readiness-design.md`)
and projects (`2026-10-13-project-budgets-design.md`). Where this differs from HubSpot, the decision says why. Pictures:
`pipedrive-shots/`, from the flag-gated `/docs-shots/pipedrive/<state>` (`DOCS_SCREENSHOTS=1`).

## Why

A small business that sells on Pipedrive should not open another tool to see whether a deal's money came in. Connecting
Pipedrive once brings its won deals in with their organization and person; Plan collections turns one into a Vestiarion
deal through the New deal form, filled in; the deal's page shows the money that actually arrived on Arc and its cash
readiness; and, once an owner or admin allows it, the receipt figures go back to the Pipedrive deal, in fields
Vestiarion owns, read back to check.

**The founder's steps saved, for one won deal with a cash gap.** Without Vestiarion: open the deal in Pipedrive, copy
the organization's name, the person's email, the deal's title, its value and currency, and its won date into an
invoicing tool (6 values typed again); later, check the bank or the explorer for the payment, and type what came in, what
is still owed, the date and the amount back on the Pipedrive deal (4 values typed again). With it: Plan collections (1
press), pick how it is billed and Confirm deal (2), Release now when it is time (1); the payment is matched when it lands,
and the deal's page shows the gap against its costs; the figures go back to Pipedrive on their own. Ten values not typed
twice, and two trips between tools not made.

## What Pipedrive offers, as of October 2026

Read from Pipedrive's developer docs (OAuth authorization, scopes, rate limiting, webhooks v2, app uninstallation) and
its OpenAPI files for API v1 and v2.

- **OAuth 2.0, authorization code.** Authorize at `https://oauth.pipedrive.com/oauth/authorize` with `client_id`,
  `redirect_uri` and `state`; the scopes are the app's own, set in Developer Hub, and a person accepts **all of them or
  none**. A cancel comes back with `error=user_denied`. The code lives five minutes. Tokens at
  `POST https://oauth.pipedrive.com/oauth/token`, form-encoded, the client id and secret as HTTP Basic auth. The answer
  carries `access_token`, `token_type`, `refresh_token`, `scope`, `expires_in` and `api_domain`, the company's own base
  URL (`https://<company>.pipedrive.com`), where every API call goes. A refresh (`grant_type=refresh_token`) answers the
  same fields; the docs say the same refresh token is issued again, its 60 days of idle life reset.
- **Uninstalling.** `POST https://oauth.pipedrive.com/oauth/revoke` (RFC 7009, Basic auth) with the refresh token
  removes the app from the company. When a person uninstalls it in Pipedrive, Pipedrive sends `DELETE` to the app's
  callback URL, Basic auth with the client id and secret, a body naming `company_id`.
- **The company and the user**: `GET /api/v1/users/me` (`base`): the user, their `access` (per app, admin or not),
  `company_id`, `company_name`, `company_domain`. Nothing in it, in the token answer or elsewhere in the API says whether
  a company is a developer sandbox; the plan is not readable either.
- **Deals**: `GET /api/v2/deals` (`deals:read`), `limit` up to 500, an opaque `cursor`, `sort_by=update_time`,
  `updated_since`, `status=open,won,lost,deleted` (deleted ones for 30 days), `ids` (up to 100); archived deals only at
  `GET /api/v2/deals/archived`, same parameters. A deal has `id`, `title`, `value`, `currency`, `status` (open, won,
  lost, deleted), `stage_id`, `pipeline_id`, `org_id`, `person_id`, `owner_id`, `update_time`, `won_time`,
  `lost_reason`, `expected_close_date`, the company-local `local_won_date` and `custom_fields`.
- **Organizations and persons** by `ids` at `/api/v2/organizations` and `/api/v2/persons` (`contacts:read`); a person's
  `emails` with the primary one marked. **Stages and pipelines** at `/api/v2/stages`, `/api/v2/pipelines`.
- **Custom deal fields**: `GET`/`POST /api/v2/dealFields` (`deal-fields:full`), each with `field_name`, `field_code` (a
  40-character hash) and `field_type` (`double`, `varchar`, `date`, …); values in a deal's `custom_fields`, read with
  `GET /api/v2/deals/{id}?custom_fields=…` and written with `PATCH /api/v2/deals/{id}` (`deals:full`). No conditional
  write.
- **Webhooks v2**: `POST /api/v1/webhooks` with `subscription_url`, `event_action`, `event_object`, `version` `2.0`,
  `http_auth_user` and `http_auth_password`. Pipedrive answers each event to the URL with that Basic auth; three retries,
  a ban after ten failures in a row, and a webhook deleted after three days without a delivery.
- **Limits**: a daily token budget per company by plan and seats, and a burst limit per token over two seconds; past
  either, `429`, with `x-ratelimit-*` headers.

## Decisions

**P1. A second CRM on the connector core.** (`src/lib/pipedrive/`)
- `ProviderId` gains `pipedrive`, of kind `crm`. Pipedrive implements `CrmProvider` and `CrmReceiptWriter` as HubSpot does;
  the sync runner, the sweeper, the token lease, the cursors, the list, the review, the prefill and the receipts outbox
  are the core's.
- What the core generalizes, cheaply, with HubSpot's behaviour unchanged: a deal's source in its entries is either CRM's
  (`DealSource`), and so is a customer's (`via: "pipedrive"`, `pipedrive: { companyId, dealId, organizationId }`); the
  reference a planned deal carries is the CRM's (`crmDealReference`: HubSpot's deal id as it is, Pipedrive's as
  `pipedrive-<id>`, since Pipedrive's small numbers would meet references people type); a deal the CRM says was deleted
  in a page read is marked so at once (`ExternalDeal.deleted`); a CRM may name no test account
  (`CrmReceiptWriter.testAccounts: false`, P12); a list says "organization" for Pipedrive where HubSpot says "company".

**P2. The schema (migration 0116, additive, re-runnable).**
- The provider checks of `accounting_connections`, `accounting_tokens` and `external_links` take `pipedrive`, and keep
  every value already there and `asana` (migration 0115). The writes switch (`accounting_connections_writes_check`) and
  `crm_receipt_writes.provider` take `pipedrive` beside `hubspot`. Each check is replaced only while it does not take
  `pipedrive` yet, so a re-run never narrows a later widening.
- `crm_receipt_writes_account_test_check` is left as it is: `account_test` is true only beside HubSpot's own word for a
  test account, so a Pipedrive write of payments on Arc testnet or in shadow mode can never reach sending, sent or
  written (`crm_receipt_writes_reality_check`). That is P12, held by the database.
- `accounting_connections_pipedrive_one_workspace`: a Pipedrive company is connected, not revoked, to one workspace at a
  time, as a HubSpot account is (H4).
- `pipedrive_connector_ready()`: the probe the connect flow and the card ask before anyone is sent to Pipedrive.
- Cost if wrong: an additive migration.

**P3. Who does what.** As HubSpot (H3): connecting, Sync now, disconnecting and the receipts switch are
`integrations.manage` (owner, admin); Plan collections, Keep the deal as it is and Use this email are `records.write`;
Write Vestiarion's figures is `integrations.manage`. Every member sees the card and the list.

**P4. Connecting.**
- `/integrations/pipedrive`, `/integrations/pipedrive/connect` (workspace, consent, **Continue to Pipedrive**),
  `POST /api/integrations/pipedrive/connect` and `GET /api/integrations/pipedrive/callback`, registered as
  `https://www.vestiarion.xyz/api/integrations/pipedrive/callback`: the core's signed state, its nonce in an HttpOnly
  cookie on `/api/integrations/pipedrive`, the same checks on the way back.
- The authorize URL names no scope: Pipedrive's are the app's. The token answer's `scope` is read, and a grant without
  the read scopes (`deals:read` or `deals:full`, `contacts:read` or `contacts:full`) is refused before anything is kept
  (`?pipedrive=scopes`), in words: the app was set up without them.
- The company is `users/me`'s `company_id`; its name `company_name`. One company per grant, so no choice.
- A company connected to another workspace is refused (`other_workspace`); a workspace connected to another company is
  refused (`other_organisation`); the same company again reconnects its row.
- Before migration 0116 the connect route and the card say Pipedrive is not set up yet.
- Writing is not asked for on the connect page: Pipedrive grants every scope at once, so the switch on the card is the
  only place it is turned on (P11).

**P5. Tokens, and the company's own domain.**
- The token answer's `api_domain` must be an https host under `pipedrive.com` (`https://<name>.pipedrive.com`); any other answer is refused. It is sealed with
  the tokens it came with, as one credential (`pd1|<host>|<token>`), in the access and the refresh token columns: every
  call goes to the domain of the token it carries, a refresh's new domain replaces the old one in the same
  compare-and-set, and no token is ever sent to a host Pipedrive did not name with it.
- A refresh stores the refresh token Pipedrive answers with, else the one sent, under the core's lease and
  compare-and-set (X5): a second refresh racing the first never stores over a newer pair, and a rotated token is never
  lost. `invalid_grant` (or a 400 or 401 for the refresh) marks the connection **needs reconnect**; anything else backs
  off.
- Cost if wrong: a reconnect.

**P6. Reading Pipedrive.**
- Deals from API v2, 100 a page, sorted by `update_time` ascending. A backfill reads open and won deals; an incremental
  run every deal changed since five minutes before `since`, lost and deleted included. The core's page numbers (X8) map
  to Pipedrive's opaque cursors within a run; a run resumed at page N walks the cursors from page 1 first (N − 1 extra
  reads, at most once a run).
- For each page: its organizations and persons by id (two calls). Stages and pipelines once per run.
- Mapping (pure, `map.ts`): `status` is the stage state (open, won, lost); the stage label is the stage's name, or the
  lost reason for a lost deal; the close day is `local_won_date` for a won deal (else `won_time`'s day), the lost day for a
  lost one, `expected_close_date` for an open one; the amount an exact decimal (refused beyond six places); the currency
  three capital letters; the customer the deal's organization, with the deal's person's primary email.
- A deal Pipedrive says was deleted is marked deleted at once, its row kept. Linked deals and won deals still offered are
  read again by id each run (`/deals` and, for those not there, `/deals/archived`): an archived deal is still the deal it
  was; one in neither, or deleted, is `deleted`.
- Cost if wrong: one mapping function, tested against Pipedrive-shaped fixtures.

**P7. Webhooks only nudge.**
- On the first sync after connecting, and on Sync now, Vestiarion makes sure Pipedrive has one webhook for the
  company's deals (`event_object=deal`, `event_action=*`, version 2.0) to
  `https://www.vestiarion.xyz/api/integrations/pipedrive/webhook`, with Basic auth: the user is the company id, the
  password an HMAC of it under a key derived (HKDF) from the master key for this purpose alone. Nothing is stored; a
  second registration is never made. A deployment on localhost registers none.
- `POST /api/integrations/pipedrive/webhook` compares the Basic auth in constant time against every master key, before
  reading the body, and answers at once. An event authenticated for a company starts one sync of that company's
  connections after the answer (Sync now's budget), which reads the deals that changed from Pipedrive itself. The body
  is never trusted: not its deal, not its amounts. A connection waiting out a rate limit or an outage is not nudged.
- A notice costs a read of what changed, never a read of every kept deal by id (`NUDGE_SYNC`): Pipedrive sends one notice
  per deal change, and its API budget is the company's own, shared with its other tools. Reading the linked and offered
  deals again by id is the sweeper's, every 15 minutes. Notices that arrive while a sync runs find it busy (the core's
  lease) and start nothing.
- Pipedrive's uninstall notice (`DELETE` on the callback URL, Basic auth with the app's id and secret, compared in
  constant time) nudges the company's connections the same way: the refresh then fails and the card asks to reconnect.
- The sweeper still runs every connection every 15 minutes: a webhook lost, banned or never registered (Pipedrive
  refuses it) costs at most that wait.

**P8. Rate limits.** A `429` waits `Retry-After` when sent, else `x-ratelimit-reset` seconds, else two seconds (the burst
window). A wait of at most five seconds is spent in the run once; a longer one ends the run with its checkpoint (X8).

**P9. Plan collections.** As H11: a won deal with a value above zero and an organization is offered; one without says
"No amount in Pipedrive" or "No organization in Pipedrive". The New deal form is filled in from it: the customer (the
counterparty its organization is linked to; else the one client with its name; else a new customer), the title, the
total, USD as USDC and EUR as EURC one for one, any other currency only in shadow mode on Arc testnet (D3), never VND,
the start (the won day) and the reference `pipedrive-<id>`, read-only. Nothing is made before the person confirms;
`crm.plan_deal` reads the row again on the server.

**P10. Changes from Pipedrive after a deal exists.** As H12: the value or its currency changed, the close day moved, the
deal reopened or was marked lost, or deleted: **Changed in Pipedrive** on the deal's page and in the list, recorded once
in a signed `crm_deal_changed`. Nothing is revised or cancelled on its own: **Change deal** (prefilled) or **Keep the
deal as it is**, each acting only on the changes the page showed. A lost or deleted deal deletes nothing: its row, its
Vestiarion deal, its invoices, allocations and receipts all stay; only a person cancels.

**P11. Receipts back to the deal.** (`src/lib/pipedrive/receipts.ts`)
- The nine figures of R2 as custom deal fields Vestiarion makes once per company, named "Vestiarion: Collected",
  "Vestiarion: Still owed", "Vestiarion: Collection currency", "Vestiarion: Collection status", "Vestiarion: Last receipt
  date", "Vestiarion: Last receipt amount", "Vestiarion: Last receipt", "Vestiarion: Reconciliation status" and
  "Vestiarion: Evidence": numbers as `double`, the day as `date`, the rest as `varchar`, the statuses in words ("Paid in
  full"), read back into their codes. A field of one of these names with another type is someone else's: never changed,
  and nothing is written.
- The outbox, the read-back, field ownership and conflicts are R5 and R6 unchanged: a value someone changed in
  Pipedrive is a conflict, never written over, until an owner or admin chooses **Write Vestiarion's figures**. Only money
  confirmed on Arc and applied counts (R1, `src/lib/deals/collection.ts`).
- Writing needs `deals:full` and `deal-fields:full`, which the app is granted whole. An owner or admin turns it on with
  **Write receipts to Pipedrive** on the card; disconnecting turns it off in the same update (0107).

**P12. The reality rule, and the sandbox signal: there is none.** Pipedrive's API names no developer sandbox: not
`users/me`, not the token answer, not the company's fields. A developer sandbox is "essentially like a regular Pipedrive
company account". The company domain is chosen by whoever made the company, so a pattern in it proves nothing. So
Vestiarion never treats a Pipedrive company as a test one: `account()` answers `COMPANY`, not a test account.
- Payments on Arc mainnet outside shadow mode are written to the company once allowed.
- Payments on Arc testnet or in shadow mode are never written to Pipedrive: the card offers such a workspace no switch,
  only the reason, and so does a deal's receipt card; the command refuses it anyway ("Writing to Pipedrive stays off …");
  a write queued anyway (shadow turned on later, a deal in its own currency) is refused with the reason; and the database
  refuses its sending (P2). Reading, planning and change detection work as everywhere.
- Cost if wrong: a sandbox's live test of the write-back needs a workspace on Arc mainnet outside shadow mode.

**P13. Plan and scopes, in plain words.** The scopes are checked at the callback (P4) and before writing (the gate,
R3). Pipedrive's plan is not readable by its API, so it is not guessed: making the fields is the check, and a refusal
(a plan's custom field limit, or a user who may not add fields) is said in Pipedrive's words with what to do, on the
deal's receipt card and the Settings card. The card also says that Vestiarion sees the deals the Pipedrive user who
connected can see.

**P14. Consent, in plain words** (`pipedrive-2026-10-14`): what is read (deals, their organizations and persons: names,
values, close dates, stages, each person's email), that Pipedrive tells Vestiarion when a deal changes, what is written
once allowed, that payments on Arc testnet or in shadow mode are never written, who sees it, no training, disconnecting.
Recorded on the connection and in `accounting_connected`; `/terms` and `/privacy` say the same.

**P15. Disconnecting.** As H15: the refresh token is revoked at Pipedrive (which uninstalls the app and its webhook), the
tokens deleted, the connection revoked with a signed `accounting_disconnected`. Planned deals, links and rows stay.

**P16. Status in business words**: the core's for a CRM ("Connected to Cedar & Co", "2 won deals to plan", "1 deal
changed in Pipedrive", "Pipedrive needs you to reconnect").

**P17. Before migration 0116 runs, or without `PIPEDRIVE_CLIENT_ID` and `PIPEDRIVE_CLIENT_SECRET`, nothing breaks**: the
card says Pipedrive is not set up yet, or is not there; the routes answer 404 without the app; the sweeper never sees a
Pipedrive connection.

**P18. What never leaves.** Tokens are read only in `token-store.ts` and sent only to Pipedrive, at the domain they came
with. Logs carry a label, a status and ids. The webhook's password is never stored or logged.

**P19. The ledger.** No new action. `deal_signed` and `deal_revised` say `via: "pipedrive"` with `pipedrive: { companyId,
dealId, organizationId }`; `create_counterparty` and `counterparty_notice_email_changed` with `pipedrive: { companyId,
organizationId }`; `accounting_connected`, `accounting_disconnected`, `crm_deal_changed`, `crm_deal_change_kept` and the
`crm_receipt_*` entries with `provider: "pipedrive"`. They reach webhooks as `ledger.appended`.

**P20. Where it shows.** Settings, **Pipedrive** (`PipedrivePanel`, its name beside Pipedrive's app icon since
2026-10-14: integration marks I13); Bills & receivables, Deals, **From Pipedrive: N won deals** (`CrmDeals`, the HubSpot
list made generic); a deal's page, **Changed in Pipedrive** and **Receipts in Pipedrive**, beside its cash readiness and
project.

## Not in this version

Pipedrive's products and line items, its own invoices, a deal without an organization (a person alone), several
companies per workspace, the collections context's "ask the deal's owner" (HubSpot only), a Pipedrive app panel, and
writing to a Pipedrive developer sandbox from Arc testnet (P12).

## Testing

- Pure: the mapping against Pipedrive-shaped fixtures (deals, organizations, persons, stages, tokens, `api_domain`),
  the credential, the webhook's Basic auth, field names and words.
- The client against a recording fetch: the authorize URL, the code exchange and refresh with Basic auth, a bad
  `api_domain` refused, a 429's wait, the deal pages and their cursors, a resumed page, deals by id with archived and
  deleted ones, the fields made and read, the write.
- Token rotation under concurrency: two refreshes racing over the core's lease keep one pair, and a rotated refresh
  token is stored.
- The connect flow: state and nonce bound, scopes refused, another workspace refused, reconnect.
- The runner: won deal to plan, lost and deleted deals keeping their history, change detection.
- Receipts: write, read-back, conflict, the reality rule for testnet and shadow, the switch refused.
- The webhook and the uninstall notice: wrong or missing auth refused before the body is read, nudges only.
- The migration on PGlite: the widened checks with `asana`, a re-run, one workspace per company, the reality check for
  Pipedrive, tenancy.
- The card, the list and the receipt card with sample data (`/docs-shots/pipedrive`).
- Not verified here: a live OAuth run against the partner's sandbox, which needs the deployment.

## Pictures

From `/docs-shots/pipedrive/<state>` (`DOCS_SCREENSHOTS=1`), each at 1440 and 390 px wide, in `pipedrive-shots/`:
`01-settings-mainnet` (the card, writing on), `02-settings-testnet` (the card on Arc testnet: the rule, no switch),
`03-won-deals` (From Pipedrive: won deals to plan, one planned and changed, one without an organization, one not won
yet), `04-plan-collections` (Plan collections' form filled in), `05-deal-cash-readiness` (the planned deal short by
130.00 USDC on Oct 22 before its balance arrives, with its receipts written), `06-receipts-written`, `07-conflict` (a
value someone changed in Pipedrive, with Write Vestiarion's figures to Pipedrive) and `08-changed-in-pipedrive`.
