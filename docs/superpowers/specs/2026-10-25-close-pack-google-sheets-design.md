# Close pack in Google Sheets (2026-10-25)

Status: accepted. D11, part 2 of the close pack. Built after the monthly close pack
(`docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md`) merges, on top of `src/lib/close-pack/`. Migration
0145. One PR.

## Why

An accountant closes a month in a spreadsheet. The close pack gives them the month as a CSV, which they download,
open in Google Sheets with File > Import, and then keep in step by hand: a payment confirmed late, a booking made after,
and the copy in Drive is stale, with nothing tying it to the ledger.

This connects a workspace to one Google account and writes a month's close pack straight into a spreadsheet in that
account's Drive: one row per payment, the same 51 columns as the CSV, and a summary tab that says how to check every
row against the signed ledger. Exporting the same month again updates that spreadsheet in place. Each export is signed
into the ledger with the spreadsheet's id and the SHA-256 of what was written.

It serves:
- the outside accountant (role `accountant`), who keeps clients' months in Google Sheets;
- the owner or admin, who keeps the business's books in Google Drive and shares them with the accountant there.

It writes a copy; it decides nothing, pays nothing, reads nothing back into Vestiarion, and calls no model.

## Rules

Each rule ends with what it costs if it is wrong. Code comments and test names cite the ids, for example "(close pack
Sheets GS7)".

**GS1. A connector on the core.** Google Sheets is a provider of the connector core (`src/lib/connectors/`), id
`googlesheets`, label "Google Sheets", built like Asana's: `src/lib/googlesheets/{settings,http,oauth,provider,
connect-deps,ready,table,sheets,export,views,panel}.ts`, the routes `src/app/api/integrations/googlesheets/{connect,
callback}/route.ts`, the page `src/app/integrations/googlesheets/connect/page.tsx`, and the actions
`src/app/actions/googlesheets.ts`.
- A new `ProviderKind`, `"export"`: it brings nothing in. `PROVIDER_KINDS.googlesheets = "export"`.
- Every `Record<ProviderId, …>` gets an entry: `PROVIDER_LABELS`, `PROVIDER_KINDS`, `PROVIDER_WORDS` (possessive
  "Google Sheets'", organisation "Google account", contacts "no contacts", accounts "no accounts", idleDays 0, bills
  "close packs", approval "A close pack in Google Sheets is a copy: the signed ledger stays the record."),
  `CONSENT_VERSIONS` and `CONSENT_HISTORY` (`googlesheets-2026-10-25`), `BOOKS_PAYMENTS` and `PICKS_PAYMENT_ACCOUNT`
  (false).
- `AccountingProviderId` becomes `Exclude<ProviderId, CrmProviderId | "asana" | "googlesheets">`, so the new id never
  reads as an accounting tool.
- `accountingProvider`, `accountingProviderOn` and the CRM and work registries return null or false for it, so no
  booking, review list or sync path ever takes it.
- The connection reuses `accounting_connections` and `accounting_tokens`, `startConnect`, `finishConnect`,
  `saveConnection`, `disconnectConnection`, `freshAccessToken` and `connectionTokenStore` unchanged in what they do.
- If wrong: a parallel OAuth stack with its own tokens table repeats the core's CSRF, state, encryption and lease work
  and its tests. Riding the core costs one widened CHECK (0145) and a handful of map entries.

**GS2. Off without the Google client; "not set up" without 0145.**
- `googleSheetsSettingsFromEnv()` returns null unless `GOOGLE_SHEETS_CLIENT_ID` and `GOOGLE_SHEETS_CLIENT_SECRET` are
  both set and the id matches `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$`. A malformed id logs only "Google
  Sheets is off: GOOGLE_SHEETS_CLIENT_ID is not a Google OAuth client id", never a value.
- With null: no Settings card, no export control on the close pack page, both routes answer 404, the connect page
  calls `notFound()`, and the export action answers "Google Sheets is not set up on this deployment yet."
- With the client but before 0145: `googleSheetsReady()` calls the RPC `googlesheets_connector_ready`, which is missing,
  so it throws `NotSetUpError` (`isNotSetUp`: 42883, PGRST202, 42P01, PGRST205). The card says "Google Sheets is not
  set up on this deployment yet.", the connect route sends the person back with `error=not_set_up`, and the close pack
  page shows no export control.
- This refines the lead's "the Settings row says it is not set up" on purpose: every other connector hides its card when
  its client is missing, and a self-hosted deployment that will never have a Google client should not carry a dead
  row. The row shows "not set up" only when the client is there and the migration is not.
- If wrong: before the partner adds the client, nobody can see from Settings that the feature shipped. The 404 of
  `POST /api/integrations/googlesheets/connect` and the guide's "Before the update" line say it instead.

**GS3. One Google scope: `https://www.googleapis.com/auth/drive.file`.**
- It is Google's non-sensitive, recommended Drive scope: per-file access to the files this app creates, and nothing
  else in the Drive. It needs no data-access verification. `spreadsheets` (every sheet the person has) is sensitive, and
  `drive` is restricted; neither is asked for.
- No `openid`, `email` or `profile`. The account is identified with Drive's `about.get?fields=user(displayName,
  emailAddress,permissionId)`, which `drive.file` allows.
- The authorize URL is `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`, `client_id`,
  `redirect_uri`, `scope` (that one value), `state`, `access_type=offline`, `prompt=consent` (so a refresh token comes
  back on every connect) and `include_granted_scopes=false` (so a sign-in grant is never folded in).
- Google's granular consent lets the person untick the Drive box. `organisations()` checks the token response's
  `scope`; without `drive.file` it throws `ConnectRefusal("scopes")` before any other call, and nothing is kept.
- If wrong: should Google stop answering `about.get` under `drive.file`, connecting fails with "Google Sheets did not
  finish connecting". The fix is a new consent version that adds `openid email` and reads the id token, with no change
  to the export.

**GS4. One Google account per workspace, connected by an owner or admin.** Connecting is `integrations.manage` (owner,
admin), as for every connector: the person picks the Drive the business's months go to.
- `accounting_connections_one_active` already allows one live connection per workspace and provider; a second account
  is refused as `other_organisation`.
- The connection is not `exclusive`: the same Google account may be connected to several workspaces (an owner with two
  businesses, an accountant an owner made an admin). Each workspace's spreadsheets are its own (GS7).
- A member who leaves does not end it: `authorized_by` is set null and the connection keeps working, as Slack's and
  GitHub's do.
- If wrong: an accountant who wants the files in their own Drive cannot connect one, since an accountant changes no
  integration (`ROLE_SUMMARIES`). They download the CSV, or the owner shares the spreadsheet. Per-person connections
  later need a flag on the provider and a new partial index; the export keys on the connection id and would not change.

**GS5. Who exports, who sees.** **Export to Google Sheets** is `accounting.book`: owner, admin and accountant. Writing
the month into the business's own tool is the bookkeeping act the accountant already holds for Xero.
- Approvers and viewers see that the month was exported, and its link (GS9's "Last exported" line), but no button. They
  can still download the CSV, which the close pack allows every member.
- Every member sees the connected account as a masked email.
- If wrong: an approver who keeps the books cannot export. Adding a role is one line in `PERMISSIONS` and one test row.

**GS6. The account is named by a masked email.** `organisations()` returns one organisation: `externalOrgId` is the
`permissionId` (checked against `^[A-Za-z0-9_-]{1,100}$`, else `bad_response`), and `name` is
`maskEmail(emailAddress)` from `src/lib/payment-notices.ts` ("du***@gmail.com"), or "A Google account" when Google
gives no email.
- The full address is never stored: `external_org_name` and `accounting_connected.detail.externalOrgName` carry the
  masked one, since the ledger is signed and goes to webhook endpoints.
- If wrong: two accounts with the same first two letters and domain look alike on the card. The card is for knowing
  which Drive to look in, and the person who connected knows their own.

**GS7. One spreadsheet per workspace and month, updated in place.** The spreadsheet is a Drive file Vestiarion creates,
tagged with `appProperties { vestiarionClosePack: "<org id>:<YYYY-MM>" }`, which only this app can read.
- Each export first lists `files?q=appProperties has { key='vestiarionClosePack' and value='<org id>:<YYYY-MM>' } and
  trashed = false` (`fields=files(id,createdTime)`, `orderBy=createdTime`, `pageSize=10`). The org id is a UUID and
  the month passed `closePackMonth`, so nothing a person typed reaches the query.
- None: `files.create` with `mimeType: "application/vnd.google-apps.spreadsheet"`, the name and the tag. It lands in
  the account's My Drive.
- Found: the oldest is the month's spreadsheet. Its name is set again (`files.update`), so "so far" drops once the month
  has ended.
- After a create, the list runs again. If two exports raced and both created, each keeps the oldest and trashes the one
  it made itself (`files.update { trashed: true }`, allowed on its own file).
- A spreadsheet someone trashed or deleted is not found, so the next export makes a new one (`created: true`).
- The name: "Vestiarion close pack · <workspace name> · <month label>[ so far] · <network label>", for example
  "Vestiarion close pack · Pinecrest Studio · October 2026 so far · Arc testnet", cut to 200 characters. The network
  label comes from `networkProfile(network).label`.
- The tabs **Payments** and **Summary** are Vestiarion's: each export writes them afresh, re-adding either if someone
  deleted or renamed it. Any other tab is left alone.
- Why not a table of exports: Drive already holds the one fact needed (which file is the month's), a trashed file
  heals itself, and there is no row to drift from Drive. The race costs one trashed duplicate at worst.
- If wrong: a person who renames the file keeps it (the tag stays); one who copies it gets an untagged copy that is
  never updated. The guide says to export again rather than edit the copy.

**GS8. The Payments tab.** Row 1 is `CLOSE_PACK_COLUMNS`; then one row per `ClosePackRow`, in the pack's order, from
`closePackTable(pack, { origin: publicOrigin() })`.
- Written with `valueInputOption=RAW`, so no cell is parsed: a payee named `=HYPERLINK("x")`, an invoice number `+1`
  and a memo `@SUM(A1)` stay text. `USER_ENTERED` is never sent.
- Six columns are written as numbers so a person can add them up: `bill_amount`, `amount_paid`, `discount`,
  `network_fee_usd` and `route_fee_usdc` when the cell matches `^\d{1,12}\.\d{6}$` and `Number(cell).toFixed(6) ===
  cell`; `earlier_attempts` when it matches `^\d{1,6}$`. Every other cell, and any of those that does not round trip,
  stays the text the table gave (`sheetValues`).
- Formatting, in one `spreadsheets.batchUpdate` before the values: the grid sized to `max(rows + 1, 2)` rows and 51
  columns (which also removes rows left from a longer export), the header frozen (`frozenRowCount: 1`) and bold, the
  five money columns `#,##0.00####` and `earlier_attempts` `0`, every column 160 pixels wide, and data rows clipped
  rather than wrapped.
- Values go in `values:batchUpdate` requests of at most 500 rows each (2,000 rows of 51 columns are about 3 MB; Google
  recommends 2 MB or less a request).
- If wrong: amounts as text cannot be summed, so the accountant converts them by hand; numbers written for values that
  do not round trip would change an amount. The round-trip check keeps the exact decimal whenever a number would not.

**GS9. The Summary tab.** Two columns, label and value, written RAW. The rows, in order (each value from the pack):

| Label | Value |
|---|---|
| "Vestiarion monthly close pack" | "" |
| "Workspace" | "Pinecrest Studio (pinecrest-studio)" |
| "Network" | the profile's label, "Arc testnet" or "Arc mainnet" |
| "Month" | "October 2026, a calendar month in UTC", or "October 2026 so far, a calendar month in UTC" |
| "Read at" | `utcWords(pack.readAt)`, "2026-10-25 14:03 UTC" |
| "Exported by" | the exporter's email, or "a member (1a2b3c4d)" |
| "Payments settled" | the count of rows (a number) |
| "Paid in <token>" | one row per `totals.onChain` token, the amount (a number when it round trips) |
| "Route fees in <token>" | one row per token whose route fees are above zero |
| "Simulated, in <token>" | one row per `totals.simulated` token: "2 payments, 30.000000" |
| "Not settled in the month" | "<n>: listed on the close pack page, not in this spreadsheet" |
| "Escrow moves" | "<n>: listed on the close pack page, not in this spreadsheet" |
| "Signed entries verified" | "52 of 52" |
| "Ledger head" | "#5832 <hash>", or "None" |
| "Signing keys" | the ids of `pack.keys`, joined with ", " |
| "Payments tab SHA-256" | the hex digest (GS10) |
| "Close pack page" | `<origin>/o/<slug>/evidence/close-pack?month=YYYY-MM` |
| "Cut" (only when `cut`) | "This month has more than 2,000 payments, so this spreadsheet holds the first 2,000. The audit export holds every entry." |
| "People" (only when `unread` has `members`) | "Members could not be read just now, so people are named by the first 8 characters of their id." |
| "Screening" (only when `unread` has `screening`) | "Some screening records could not be read just now. Those payments say so." |
| "How to check it" | "Each row of Payments names the signed ledger entry that records its payment: entry_seq, entry_hash, signature and signing_key_id. Download the month's signed JSON from the close pack page and check any entry with verifyLedgerEntry from @vestiarion/sdk, with the public keys in that file." |
| "" | "Vestiarion read the Payments tab back after writing it, and recorded this export in the workspace's ledger as close_pack_exported, with this spreadsheet's id and the SHA-256 above. Find it in the Audit log." |
| "" | "The SHA-256 is of the Payments tab as written: JSON.stringify of its rows, the header first, each row as wide as the header, with empty cells as empty text." |
| "" | "A change made in this spreadsheet after the export is not in the ledger. Export the month again to write it afresh." |

- Column A is bold; column A is 220 pixels and column B 720 pixels wide, wrapped.
- Not-settled payments and escrow moves are counted, not listed, as in the CSV: the page and the signed JSON list them.
- If wrong: a reader takes the spreadsheet as the record. The last row says it is a copy, and the hash ties it to an
  entry that is.

**GS10. The Payments tab's SHA-256, and the read back.**
- `paymentsSha256(values)` is the SHA-256, lowercase hex, of `JSON.stringify(values)` in UTF-8, where `values` is the
  header and the rows exactly as written (strings and numbers), each row padded with `""` to 51 cells.
- After writing, the tab is read back once (`values/Payments!A1:AY?valueRenderOption=UNFORMATTED_VALUE&
  majorDimension=ROWS`). Google drops trailing empty cells and rows, so each row read is padded to 51 and the hash taken
  the same way. Equal hash and row count: the export is done. Otherwise it failed (`mismatch`), and the ledger says so
  (GS11).
- The same hash is what Apps Script computes from `getDataRange().getValues()`, so anyone with the spreadsheet can
  check it against the ledger entry; the guide gives the six lines.
- If wrong: Google could someday store a RAW text that looks like a number as a number. Every export would then fail
  `mismatch`, which the first prod proof (step 6) would show at once; the fix is to compare cells as text.

**GS11. Each export is recorded, and counted against the close pack's brake.**
- Done: `close_pack_exported` (CP13's kind, actor `human`, domain `system`) with `format: "google_sheets"`:
  `{ by, month, ended, format, payments, notSettled, sha256, headSeq, connectionId, spreadsheetId, created }`.
  `sha256` is the Payments tab's (GS10); `created` says a new spreadsheet was made. Summary: "Close pack for October
  2026 exported to Google Sheets: 14 payments settled, 2 not settled".
- Failed after rows may have reached Google (the values write was sent, or the read back did not match): a new kind,
  `close_pack_export_failed` (actor `human`, domain `system`) `{ by, month, ended, format: "google_sheets",
  connectionId, spreadsheetId, stage, reason }`, where `stage` is `write` or `read_back` and `reason` is one of
  `rate_limited`, `unavailable`, `forbidden`, `drive_full`, `bad_response` or `mismatch`. Summary: "Close pack for
  October 2026 not fully exported to Google Sheets". A failure before any row was sent (no token, the list or the create
  failed) records nothing: nothing of the pack left.
- Both are appended best effort (`appendLedgerEntryBestEffort`) through `src/lib/close-pack/record.ts`:
  `recordClosePackExport` takes `format: "json" | "csv" | "google_sheets"` and, for Sheets, `sheet: { connectionId,
  spreadsheetId, created }`; `recordClosePackExportFailed` is new.
- `recentClosePackExportsBy` counts both kinds, so one brake holds downloads and exports together: ten per person per
  workspace in ten minutes (`CLOSE_PACK_EXPORT_LIMIT`). The eleventh is refused before the pack is read or Google is
  called.
- Neither entry names anyone by email, nor carries a token or a URL; the spreadsheet is named by its id.
- If wrong: a month copied out of Vestiarion with no trace, which is what CP13 exists to prevent; or a ledger entry and
  webhook per failed click, bounded by the brake.

**GS12. Calls to Google.** `src/lib/googlesheets/http.ts` names every address once:
`https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`,
`https://oauth2.googleapis.com/revoke`, `https://www.googleapis.com/drive/v3`, `https://sheets.googleapis.com/v4`.
- `googleFetch` refuses any other host, sends `redirect: "error"`, `cache: "no-store"` and a 20-second timeout. Paths
  are built from checked ids only: a spreadsheet id must match `^[A-Za-z0-9_-]{25,100}$` (`SPREADSHEET_ID`); no link or
  id Google returns is used without that check, and `webViewLink` is never read.
- `googleFailure(response)` reads only Google's short reason code (`error.errors[0].reason`, `error.details[].reason`
  or `error.status`, kept only if it matches `^[A-Za-z_]{1,64}$`), never its message:
  - 429, or `rateLimitExceeded`, `userRateLimitExceeded`, `RESOURCE_EXHAUSTED`: `rate_limited`, with `Retry-After` or
    30 seconds;
  - 401: `unauthorized`;
  - 403 `storageQuotaExceeded`: `drive_full`;
  - 403 `insufficientPermissions` or `ACCESS_TOKEN_SCOPE_INSUFFICIENT`: `reconnect`;
  - 404 on a file, or 403 `insufficientFilePermissions` on a file (a grant made again may not reach the files of the
    one before it): `gone`, so the export makes a new spreadsheet;
  - other 403: `forbidden`;
  - 5xx, timeout or no answer: `unavailable`;
  - anything else, or a body that does not read: `bad_response`.
- Retries, at most one per call:
  - a 401 refreshes the token once (`freshAccessToken({ refused })`) and repeats the call;
  - a rate limit asking for 10 seconds or less waits and repeats it;
  - a 5xx or timeout repeats only reads (`files.list`, `spreadsheets.get`, `values.get`) and the values write, which is
    idempotent; never `files.create`, `files.update` or the format `batchUpdate`: the next export finds the file by its
    tag instead (GS7).
- An export starts no new call after 90 seconds and fails `unavailable`. The close pack page sets
  `export const maxDuration = 120`, which its server actions take (Next 16 `maxDuration`, "Server Actions").
- A log line names the call, the status and the reason code. Never a token, a body, an email or a spreadsheet's name.
- One export is about seven calls (list, create or rename, get, format, values, read back, and a second list after a
  create). Google allows 60 a minute per user and project.
- If wrong: a retried create makes duplicate files, or an error message echoes a payee's name into the logs. Neither
  can happen by construction, and both are tested.

**GS13. Tokens.**
- Kept by `saveTokens` in `accounting_tokens`: AES-256-GCM under `VESTIARION_MASTER_KEYS`, the AAD bound to the
  workspace and the column, opened only in the workspace's own scope, never shown in the browser, a log, a model's
  prompt or a webhook.
- Google's refresh answer carries no new refresh token, so the one sent is kept (as HubSpot's `mapTokens(…,
  refreshToken)`). `invalid_grant`, `unauthorized_client` or `invalid_client` mean `reconnect`; anything else is tried
  again at the next export.
- On `reconnect`, from a refresh or from GS12, the connection becomes `needs_reconnect` with `last_error` "Google no
  longer accepts this connection: its access was removed in the Google Account, or it went unused for six months.
  Reconnect Google Sheets to export close packs again." (`markSheetsReconnect` in `src/lib/googlesheets/store.ts`,
  modelled on Asana's `markReconnect`). `connectionStatus` and `readConnectorProblems` then show it as for any
  connector, so the accountant console's problems list names it.
- If wrong: a token leaks to a log, or an expired grant fails every export with "try again". The first is guarded by the
  core and tested here; the second shows on the card as "needs you to reconnect".

**GS14. Disconnecting.** **Disconnect Google Sheets** is `integrations.manage`.
- Google's revoke ends the whole grant of that Google account to this app, so it would cut off every other workspace
  connected with the same account. So it revokes only when `connectedElsewhere("googlesheets", permissionId, orgId)` is
  false; otherwise it passes a revoke that does nothing.
- Either way `disconnectConnection` deletes the tokens, marks the connection revoked and signs
  `accounting_disconnected { by, provider, connectionId, externalOrgId, revokedAtProvider }`.
- The spreadsheets stay in the Drive: Vestiarion never deletes a file it exported.
- Deleting the workspace deletes its tokens with it (the foreign key cascades) without calling Google, as for every
  connector. The guide says where a person removes the access themselves.
- If wrong: one workspace's disconnect breaks another's exports, or a revoke is claimed that never happened. The
  message says which of the three outcomes it was (Screens).

**GS15. The sweeper never picks it.** `accounting_connections_due` (0101) returns every `connected` row whose
`next_sync_after` is null or past, longest unsynced first, 50 at a time; a Sheets connection never syncs, so it would sit
at the head of every sweep.
- `saveConnection` writes `next_sync_after: "9999-12-31T00:00:00.000Z"` (`EXPORT_NEVER_DUE`) for a provider of kind
  `export`, and null for the others, as now. A reconnect goes through `saveConnection` again.
- 0145 does not redefine `accounting_connections_due`: a migration that redefines another's function is reverted by any
  `db:migrate` run from a branch without it, and the migration tests forbid it.
- If wrong: a Sheets connection connected some other way (by hand in SQL) takes a sweep slot and is skipped
  (`sweep.ts` continues past an unknown provider). Harmless until there are 50 of them.

**GS16. No reality rule.** CRM receipts keep testnet and shadow payments out of a real tool's books. A spreadsheet is
a report, not a book of account, and it names its network in its title and its Summary; the `simulated` and `shadow`
columns mark those rows. A workspace on Arc testnet exports like one on Arc mainnet.
- If wrong: someone reads a testnet month as real money. The title says the network before anything else in Drive.

**GS17. Never shares, never reads back, no model.** Vestiarion never changes a spreadsheet's sharing; the Google
account that holds it decides who sees it. The read back (GS10) is compared and dropped: nothing in a spreadsheet comes
into Vestiarion. Nothing about Google Sheets reaches the agent, a prompt or a model.
- If wrong: a sheet a stranger edited would steer something in Vestiarion. Nothing reads it.

**GS18. No Google mark in this change.** Google's product icons are not used in other products' interfaces without
Google's brand permission, and the house rule is the owner's file, unaltered. The card and the connect page write
"Google Sheets" in words beside a neutral icon (lucide `FileSpreadsheet`).
- `PROVIDER_MARKS` becomes `Record<Exclude<ProviderId, "googlesheets">, Brand>`; its test's key list excludes
  `googlesheets`.
- If wrong: the card looks plainer than the others. Adding the mark later is one file in `public/brands/` and one map
  entry, once the partner has Google's permission.

**GS19. Before 0145, and before the close pack.** Every read tolerates a missing migration: the ready RPC (GS2); the
connection row reads, which exist since 0101; an insert of `googlesheets` refused by the old CHECK (23514) answers
"Google Sheets did not finish connecting" and keeps nothing. This PR is opened only after the close pack has merged; it
imports `closePackTable`, `CLOSE_PACK_COLUMNS`, `readClosePack`, `closePackMonth`, `utcWords` and `record.ts` from it.
- If wrong: a branch cut before the close pack merged does not build. The implementation order starts by rebasing.

**GS20. Docs and lists.** See "Docs and lists to update".

## Modules

Pure modules import types only from server modules. Components import `views.ts` only.

```ts
// src/lib/googlesheets/settings.ts (GS2, GS3)
export interface GoogleSheetsSettings { clientId: string; clientSecret: string }
export function googleSheetsSettingsFromEnv(env?: Record<string, string | undefined>): GoogleSheetsSettings | null;
export const GOOGLE_SHEETS_SCOPES = ["https://www.googleapis.com/auth/drive.file"] as const;

// src/lib/googlesheets/http.ts (GS12)
export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const SHEETS_API = "https://sheets.googleapis.com/v4";
export interface GoogleHttp { fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }
export type GoogleFailure = "rate_limited" | "unauthorized" | "reconnect" | "forbidden" | "drive_full" | "gone" | "unavailable" | "bad_response";
export class GoogleError extends Error { readonly failure: GoogleFailure; readonly retryAfterMs: number | null }
export function googleFetch(url: string, init: RequestInit, label: string, deps?: GoogleHttp): Promise<Response>;
export function googleFailure(response: Response, label: string, nowMs: number): Promise<GoogleError>;

// src/lib/googlesheets/provider.ts (GS1, GS3, GS6)
export function googleSheetsProvider(settings: GoogleSheetsSettings, deps?: GoogleHttp): ConnectingProvider;

// src/lib/googlesheets/ready.ts (GS2)
export async function googleSheetsReady(): Promise<void>; // throws NotSetUpError before 0145

// src/lib/googlesheets/table.ts: pure (GS7-GS10)
export const PAYMENTS_TAB = "Payments";
export const SUMMARY_TAB = "Summary";
export const SPREADSHEET_ID: RegExp;
export const SHEET_NUMBER_COLUMNS: readonly ClosePackColumn[]; // the six of GS8
export type SheetCell = string | number;
export function sheetValues(table: { columns: readonly ClosePackColumn[]; rows: string[][] }): SheetCell[][];
export function paymentsSha256(values: readonly (readonly SheetCell[])[], width?: number): string;
export function summaryValues(pack: ClosePack, input: { origin: string; sha256: string; exportedBy: string }): SheetCell[][];
export function spreadsheetTitle(pack: ClosePack): string;
export function spreadsheetUrl(id: string): string; // https://docs.google.com/spreadsheets/d/<id>/edit; throws on a bad id
export function monthTag(orgId: string, month: ClosePackMonth): string; // "<uuid>:2026-10"
export function columnLetter(index: number): string; // 1 = "A", 51 = "AY"

// src/lib/googlesheets/sheets.ts: the Drive and Sheets calls, each through googleFetch (GS7, GS8, GS10)
export function findMonthFile(token: string, tag: string, deps?: GoogleHttp): Promise<Array<{ id: string; createdTime: string }>>;
export function createMonthFile(token: string, input: { name: string; tag: string }, deps?: GoogleHttp): Promise<string>;
export function renameFile(token: string, id: string, name: string, deps?: GoogleHttp): Promise<"ok" | "gone">;
export function trashFile(token: string, id: string, deps?: GoogleHttp): Promise<void>;
export function sheetTabs(token: string, id: string, deps?: GoogleHttp): Promise<Array<{ sheetId: number; title: string }>>;
export function formatTabs(token: string, id: string, input: { tabs: Array<{ sheetId: number; title: string }>; fresh: boolean; rows: number; summaryRows: number }, deps?: GoogleHttp): Promise<void>;
export function writeValues(token: string, id: string, input: { payments: SheetCell[][]; summary: SheetCell[][] }, deps?: GoogleHttp): Promise<void>;
export function readPayments(token: string, id: string, deps?: GoogleHttp): Promise<SheetCell[][]>;

// src/lib/googlesheets/export.ts: in the workspace's scope (GS7-GS13)
export type SheetExportOutcome =
  | { ok: true; spreadsheetId: string; url: string; payments: number; created: boolean; account: string }
  | { ok: false; reason: "off" | "not_set_up" | "not_connected" | "reconnect" | "limited" | "read_failed" | "rate_limited" | "unavailable" | "forbidden" | "drive_full" | "mismatch" | "failed" };
export interface SheetExportDeps {
  provider: ConnectingProvider;
  http?: GoogleHttp;
  tokens?: TokenStore;
  readPack?: (month: ClosePackMonth) => Promise<ClosePack>;
  recentExports?: (userId: string) => Promise<number>;
  record?: { exported: typeof recordClosePackExport; failed: typeof recordClosePackExportFailed };
  origin?: string;
}
export async function exportClosePackToSheet(
  input: { orgId: string; user: { id: string; email: string | null }; workspace: { slug: string; name: string }; month: ClosePackMonth },
  deps: SheetExportDeps,
): Promise<SheetExportOutcome>;

// src/lib/googlesheets/views.ts: pure, browser-safe
export type GoogleSheetsPanelView =
  | { state: "not_set_up" }
  | { state: "not_connected" }
  | { state: "connected"; account: string; connectedAt: string }
  | { state: "needs_reconnect"; account: string; words: string }
  | { state: "revoked"; account: string };
export type ClosePackSheetsView =
  | { state: "hidden" }
  | { state: "connect"; canConnect: boolean }
  | { state: "reconnect"; canConnect: boolean }
  | { state: "ready"; account: string; canExport: boolean; last: { at: string; payments: number; url: string } | null };

// src/lib/googlesheets/panel.ts: server, in the workspace's scope
export async function googleSheetsPanelFor(): Promise<GoogleSheetsPanelView | null>; // null when off (GS2)
export async function closePackSheetsView(input: { month: ClosePackMonth; role: OrgRole }): Promise<ClosePackSheetsView>;

// src/lib/close-pack/record.ts changes (GS11)
export async function recordClosePackExport(input: {
  orgId: string; userId: string; pack: ClosePack; format: "json" | "csv" | "google_sheets"; sha256: string;
  sheet?: { connectionId: string; spreadsheetId: string; created: boolean };
}): Promise<void>;
export async function recordClosePackExportFailed(input: {
  orgId: string; userId: string; pack: ClosePack; connectionId: string; spreadsheetId: string | null;
  stage: "write" | "read_back"; reason: "rate_limited" | "unavailable" | "forbidden" | "drive_full" | "bad_response" | "mismatch";
}): Promise<void>;
// recentClosePackExportsBy counts close_pack_exported and close_pack_export_failed.

// src/lib/connectors/connections.ts change (GS15)
export const EXPORT_NEVER_DUE = "9999-12-31T00:00:00.000Z";
```

The export run, in order:
1. The settings, `googleSheetsReady()`, and `connectionFor("googlesheets")`: off, `not_set_up`, `not_connected`
   (none, or revoked) or `reconnect` (`needs_reconnect`).
2. The brake (`recentExports(user.id) >= CLOSE_PACK_EXPORT_LIMIT.count`): `limited`.
3. The pack: `readClosePack({ month, workspace, people: "email" })`. A read that throws: `read_failed`, logged
   without detail.
4. The token: `freshAccessToken({ store: connectionTokenStore(orgId, connection.id), refresh: provider.refresh })`.
   `reconnect` or `missing`: mark the connection (GS13) and answer `reconnect`. `busy` or `unavailable`: `unavailable`.
5. Find or create the month's file, de-duplicate after a create, rename an existing one (GS7). `gone` on rename: create.
6. `sheetTabs`, then `formatTabs` (GS8, GS9).
7. `writeValues` (Payments in chunks of 500, Summary in the first request). From here a failure records
   `close_pack_export_failed` with `stage: "write"`.
8. `readPayments`, padded and hashed; unequal: `close_pack_export_failed` with `stage: "read_back"`, reason `mismatch`.
9. `close_pack_exported` (GS11), and the outcome with `spreadsheetUrl(id)`.

## Data it reads and writes

All tenant reads and writes go through `db()` in the workspace's scope; tokens through `token-store.ts` (`platformDb`,
opened only in the scope's own workspace).

| Read | Columns | Filter |
|---|---|---|
| `accounting_connections` | `CONNECTION_COLUMNS` | `provider = 'googlesheets'` (`connectionFor`) |
| `accounting_tokens` | through `connectionTokenStore` | the connection |
| RPC `googlesheets_connector_ready(p_org_id)` | | none: it reads nothing (0145) |
| RPC `accounting_connections_by_external` (platform) | through `connectedElsewhere` | `googlesheets`, the permission id, on disconnect |
| `ledger_entries` `ts, detail` | | `action in (close_pack_exported, close_pack_export_failed)`, `detail->>by` the person, the last ten minutes (`recentClosePackExportsBy`) |
| `ledger_entries` `ts, detail` | | `action = close_pack_exported`, `detail->>format = google_sheets`, `detail->>month` the month, newest one (the page's "Last exported" line) |
| everything `readClosePack` reads | | close pack spec, "Data it reads and writes" |

| Write | What |
|---|---|
| `accounting_connections` insert or update | `saveConnection`: `provider 'googlesheets'`, `external_org_id` the permission id, `external_org_name` the masked email, `scopes`, `consent_version 'googlesheets-2026-10-25'`, `consented_at`, `connected_by`, `window_from` (unused), `next_sync_after '9999-12-31T00:00:00Z'` |
| `accounting_connections` update | `markSheetsReconnect`: `status 'needs_reconnect'`, `last_error`, `last_error_at`, where `status = 'connected'` |
| `accounting_connections` update | `disconnectConnection`: `status 'revoked'`, `revoked_at`, `revoked_by` |
| `accounting_tokens` | `saveTokens`, a refresh's `accounting_token_store`, `deleteTokens` |
| ledger | `accounting_connected`, `accounting_disconnected`, `close_pack_exported`, `close_pack_export_failed` |
| Google Drive | create one file per month, rename it, trash a duplicate it just made |
| Google Sheets | the Payments and Summary tabs' properties, formats and values |

Ledger kinds, with their payloads:
- `accounting_connected` (existing; actor `human`, domain `system`) `{ by, provider: "googlesheets", connectionId,
  externalOrgId, externalOrgName, scopes, consent: { version, at }, reconnected }`; `externalOrgId` is the Google
  account's permission id and `externalOrgName` its masked email. Summary: "Connected Google Sheets: du***@gmail.com.
  Close packs can be exported to its Google Drive from Monthly close pack" (`comesIn` for kind `export`).
- `accounting_disconnected` (existing) `{ by, provider: "googlesheets", connectionId, externalOrgId,
  revokedAtProvider }`.
- `close_pack_exported` (close pack CP13) with `format: "google_sheets"` and `connectionId`, `spreadsheetId`,
  `created` (GS11).
- `close_pack_export_failed` (new, GS11).

## Migration 0145

`supabase/migrations/0145_google_sheets_connector.sql`, the partner's to run. Additive and idempotent:
- **The provider checks.** `accounting_connections_provider_check` and `accounting_tokens_provider_check` take
  `googlesheets` beside `xero`, `quickbooks`, `hubspot`, `asana`, `pipedrive`, `zohobooks` and `zohocrm`, each replaced
  only while `pg_get_constraintdef` does not yet contain `googlesheets` (0123's pattern), so a re-run never narrows a
  later widening and 0101, 0105, 0115, 0116, 0122 and 0123 re-run after it leave it. The header comment says a later
  widening must keep `googlesheets`.
- `external_links_provider_check` is left as it is: nothing links to Google Sheets, and the database holds it so.
- **`googlesheets_connector_ready(p_org_id uuid) returns boolean`**: `select true`, `stable`, `set search_path = ''`;
  execute revoked from `public, anon, authenticated` and granted to `vestiarion_tenant, service_role`.
- No table, no index, no function of another migration redefined (GS7, GS15).
- `notify pgrst, 'reload schema'`. A "Down (by hand)" comment: drop the function; the checks without `googlesheets`
  once no row holds it.

## Screens and copy

Times on the close pack page read like "2026-10-25 14:03 UTC" (`utcWords`); on the card like "Oct 25". The network
label always comes from the profile; no file in `src/` writes "Arc testnet" or "Arc mainnet" itself.

### Settings > Integrations: the Google Sheets card

`src/components/GoogleSheetsPanel.tsx`, section id `googlesheets-title`, title "Google Sheets", anchor `googlesheets`
(the connect flow lands on `?googlesheets=<outcome>#googlesheets`), after Asana. Header: `FileSpreadsheet` icon, "Google
Sheets", and a `DocsLink` to `/docs/guides/accountants#export-the-close-pack-to-google-sheets`, topic "Google Sheets".

| State | Says | Buttons (owner, admin) |
|---|---|---|
| `not_set_up` | "Google Sheets is not set up on this deployment yet." | none |
| `not_connected` | "Export a month's close pack to a spreadsheet in a Google Drive: one row per payment, each with its signed ledger entry. Vestiarion can open only the spreadsheets it makes." Others: "An owner or admin can connect Google Sheets." | **Connect Google Sheets** (link to `/integrations/googlesheets/connect?org=<slug>`) |
| `connected` | Title "Connected to the Google Drive of du***@gmail.com". "Connected on Oct 25. An owner, admin or accountant exports a month from **Monthly close pack** in the Audit log." with the link **Open the monthly close pack**. "Spreadsheets already exported stay in that Google Drive." | **Disconnect Google Sheets** (pending "Disconnecting…") |
| `needs_reconnect` | Title "Google Sheets needs you to reconnect", then GS13's words | **Reconnect Google Sheets** |
| `revoked` | Title "Disconnected from du***@gmail.com". "Spreadsheets already exported stay in that Google Drive. Nothing more is written to Google Sheets." | **Connect Google Sheets** |

Notices from `?googlesheets=` (`GOOGLE_SHEETS_NOTICES`):
- `connected`: "Google Sheets is connected. Export a month from Monthly close pack in the Audit log."
- `cancelled`: "Connecting Google Sheets was cancelled. Nothing changed."
- `forbidden`: "Only an owner or admin connects Google Sheets, from their own browser."
- `other_organisation`: "This workspace is connected to another Google account. Disconnect it first, then connect the
  one you want."
- `scopes`: "Google did not give access to Drive files, so nothing was connected. Connect again and leave the Google
  Drive box ticked."
- `not_set_up`: "Google Sheets is not set up on this deployment yet."
- `failed`: "Google Sheets did not finish connecting. Try again in a moment."

Disconnect results:
- revoked at Google: "Google Sheets is disconnected. Spreadsheets already exported stay in that Google Drive."
- shared with another workspace: "Google Sheets is disconnected from this workspace. Another workspace is connected with
  the same Google account, so Vestiarion's access there stays until you remove it in that Google Account's settings.
  Spreadsheets already exported stay in that Google Drive."
- Google did not confirm: "Google Sheets is disconnected and its tokens are deleted. Google did not confirm the revoke,
  so remove Vestiarion in that Google Account's settings to be sure."
- not connected: "Google Sheets is not connected to this workspace."
- anything else: "That did not work. Try again in a moment."

### The connect page: `/integrations/googlesheets/connect`

Built like Asana's connect page: `verifySession` first, `notFound()` when off, the workspaces the person may manage
integrations for, real radio buttons when several, `ConnectorConsent`, a required **I agree** checkbox.
- `metadata.title` and `h1`: "Connect Google Sheets" (icon `FileSpreadsheet`, no brand mark, GS18).
- Intro: "Send a month's close pack to a spreadsheet in your Google Drive: one row per payment, each with the signed
  ledger entry that records it. Vestiarion asks Google for one permission: to make spreadsheets and change only the
  ones it made."
- Errors: `forbidden` "Only an owner or admin of a workspace connects Google Sheets to it."; `not_set_up` "Google Sheets
  is not set up on this deployment yet."
- No workspace to manage: `EmptyState` "Only an owner or admin connects Google Sheets", body "Ask an owner or admin of
  your workspace to connect Google Sheets, or sign in with the account that is one."
- Consent title: "What Vestiarion does with your Google Drive". The statement (`consentStatement("googlesheets")`,
  version `googlesheets-2026-10-25`), one line each:
  1. "Vestiarion asks Google only for access to the files it makes (Google's drive.file permission). It cannot see,
     open or list any other file in your Google Drive."
  2. "When an owner, admin or accountant of this workspace exports a month's close pack, Vestiarion makes a
     spreadsheet for that month in the Drive of the Google account you connect, or updates the one it made before, and
     writes the pack into it: each payment's payee and address, amounts, invoice number, approvals with members'
     emails, checks, transaction and signed ledger entry, with a summary naming who exported it. It reads that
     spreadsheet back once to check it was written in full."
  3. "It reads the Google account's id and email address once, when you connect, to show which Drive the spreadsheets
     go to. It keeps the id and a masked email, never the full address."
  4. "Vestiarion never shares a spreadsheet: the Google account that holds it decides who sees it. Nothing in a
     spreadsheet comes back into Vestiarion, and nothing from Google reaches the agent or its model."
  5. "Vestiarion never uses Google data to train or improve any AI model, and never passes it to anyone else without
     your workspace's say."
  6. "Disconnecting revokes Vestiarion's access at Google, unless another workspace is connected with the same Google
     account, and deletes the tokens. Spreadsheets already exported stay in that Drive."
- Under it: "Google asks you to allow access as yourself: the spreadsheets go to the Drive of the Google account you
  choose there, and only that account can open them until it shares them."
- Checkbox description: "Connecting records your agreement, with its date, on the connection and in the workspace's
  signed ledger." Missing: "Tick I agree to connect Google Sheets."
- Button: **Continue to Google**. Foot: "Signed in as <email>."

Google's consent screen then names "Vestiarion" and the one permission, in Google's words: "See, edit, create, and
delete only the specific Google Drive files you use with this app".

### The close pack page: `/o/<slug>/evidence/close-pack`

`ClosePackView` takes a `sheets: ClosePackSheetsView` prop; `src/components/close-pack/SheetsExport.tsx` (client) renders
it beside **Download signed JSON**, `print:hidden`. The page sets `export const maxDuration = 120` and reads the view
with `closePackSheetsView({ month, role: membership.role })` (best effort: a read that fails is `hidden`, logged).

| View | Shows |
|---|---|
| `hidden` | nothing (off, not set up, or a role with nothing to do) |
| `connect`, `canConnect` | "Connect Google Sheets in Settings to export this month to a spreadsheet." with the link **Connect Google Sheets** to `orgHref(slug, "/settings#googlesheets")` |
| `connect`, not `canConnect` (accountant) | "An owner or admin can connect Google Sheets in Settings, so this month can be exported to a spreadsheet." |
| `reconnect` | "Google Sheets needs reconnecting before this month can be exported. An owner or admin can reconnect it in Settings." (with **Reconnect Google Sheets** for an owner or admin) |
| `ready`, `canExport` | Button **Export to Google Sheets** (icon `FileSpreadsheet`, pending "Exporting…"), then "Writes this month to a spreadsheet in the Google Drive of du***@gmail.com. Exporting the same month again updates that spreadsheet." |
| `ready`, any | When `last`: "Last exported to Google Sheets on 2026-10-25 14:03 UTC: 14 payments." and **Open the spreadsheet** |

`approver` and `viewer` get `hidden` for `connect` and `reconnect`, and `ready` without the button.

The action's answers (`exportClosePackToSheetsAction`), kept sticky in the component so a revalidated page does not drop
them:
- done: "Exported 14 payments to Google Sheets." (one: "Exported 1 payment to Google Sheets."; none: "Exported this
  month to Google Sheets: no payment settled in it yet."), then "In the Google Drive of du***@gmail.com." and **Open the
  spreadsheet**;
- `limited`: "Too many close pack exports in the last 10 minutes. Try again later."
- `rate_limited`: "Google asked Vestiarion to slow down. Try again in a minute."
- `unavailable`: "Google did not answer. Try again in a moment."
- `reconnect`: "Google Sheets needs you to reconnect. An owner or admin can reconnect it in Settings."
- `drive_full`: "That Google Drive is full, so the spreadsheet could not be written. Free some space in it, then export
  again."
- `forbidden`: "Google refused to write the spreadsheet in that account. A Google Workspace administrator may have
  turned Drive off for it."
- `mismatch`: "The spreadsheet did not read back as written, so the export is not recorded as done. Export again."
- `read_failed`: "The close pack could not be read. Try again in a moment."
- `not_connected`: "Google Sheets is not connected to this workspace."
- `not_set_up` and `off`: "Google Sheets is not set up on this deployment yet."
- a month that does not read: "Choose a month that has started, from 2020 on."
- anything else: "That did not work. Try again in a moment."

Every **Open the spreadsheet** link is `spreadsheetUrl(id)`, `target="_blank"`, `rel="noreferrer"`, with "(opens in a
new tab)" for screen readers.

## Roles and access

| What | Who |
|---|---|
| Connect, reconnect, disconnect | Owner, admin (`integrations.manage`) |
| Export a month | Owner, admin, accountant (`accounting.book`) |
| See the card, the masked account and the last export's link | Every member who opens Settings or the close pack page |
| Open the spreadsheet | Whoever the Google account that holds it shares it with; Vestiarion grants no one |
| Reach a route signed out | No one: the connect route sends to sign-in, the callback answers `forbidden` |

The export action's first await is `authorize(formData.get("orgSlug"), "accounting.book")`, then `return inOrg(auth,
async () =>`; the disconnect action's is `authorize(formData.get("orgSlug"), "integrations.manage")`. Both read the role
afresh. The callback re-checks the person, membership, role and consent (the core).

## Failure and edge cases

- **No client** (GS2): nothing shows; routes 404.
- **Client, no 0145**: the card says not set up; the connect route refuses with `not_set_up`; no export control.
- **The app still in Testing at Google**: Google ends its refresh tokens after 7 days, so the connection turns to
  "needs you to reconnect" a week later. The partner publishes the app before real use.
- **Access removed at myaccount.google.com, or six months unused**: `invalid_grant`, then `needs_reconnect`.
- **The Drive box unticked** on Google's screen: `?googlesheets=scopes`, nothing kept.
- **A second Google account** while one is connected: `other_organisation`.
- **The same Google account in two workspaces**: both connect; each has its own spreadsheets (the tag holds the org id);
  disconnecting one does not revoke (GS14).
- **More than 100 connections of one Google account**: Google silently ends the oldest refresh token, whose workspace
  then reads "needs you to reconnect".
- **The spreadsheet trashed or deleted**: the next export makes a new one, `created: true`.
- **A tab renamed or deleted**: re-added; its formatting re-applied. **Another tab added**: kept.
- **Cells edited by a person**: overwritten by the next export; the Summary's last line says so.
- **A month with no payment**: the header alone, Summary "Payments settled" 0, and "Exported this month to Google
  Sheets: no payment settled in it yet."
- **This month so far**: the title says "so far"; exported again after the month ends, the same file is renamed.
- **More than 2,000 payments**: the pack is cut (CP15); the Summary's "Cut" row says so.
- **Members or screening not read**: the Summary's rows say so; the cells read as the close pack's do.
- **Two exports of the same month at once**: GS7's de-duplication; if their writes interleave, the read back of one
  fails `mismatch` and the ledger says so; the other is recorded.
- **A disconnect during an export**: the token is gone or revoked; the export fails `reconnect` or `unavailable`.
- **The person who connected leaves**: the connection keeps working; the card still names the masked account.
- **The client removed from the deployment while connected**: the card is gone, as for every connector; the tokens stay
  encrypted until the client returns and someone disconnects, or the workspace is deleted.
- **Drive full, or Drive turned off by a Workspace administrator**: `drive_full` or `forbidden`, in words.
- **A sandbox or a shadow-mode month**: exported like any other; the `simulated` and `shadow` columns mark the rows, and
  the title names the network (GS16).
- **Before 0136** (no `document_pay_to`): the close pack's pay-to check reads "Does not apply" there and here.
- **The close pack's CSV and a Sheets export in the same ten minutes**: one brake for both.

## Security and privacy

- **Least access.** One non-sensitive scope, `drive.file` (GS3): Vestiarion reaches only the spreadsheets it made, and
  cannot list or open anything else in the Drive. No identity scope; the account id and a masked email are all that is
  kept.
- **Tokens.** Encrypted at rest, opened only in the workspace's scope, refreshed under the core's lease, never in the
  browser, a log, a prompt or a webhook (GS13). The connect flow's state, nonce cookie and re-checks are the core's.
- **Where requests go.** Five fixed Google addresses, no redirects followed, timeouts on every call, paths built from
  checked ids (GS12). The callback's redirect URI is the deployment's own origin, registered exactly at Google.
- **Prompt injection.** No model reads or writes anything here. Text from outside (a vendor's name, an invoice number a
  model read from a PDF, a memo, a PO typed on a document request page) is written RAW, so a cell starting with `=`, `+`,
  `-` or `@` is text in Google Sheets, never a formula (GS8). Nothing read from Google is used as an instruction or kept;
  the read back is only compared (GS10, GS17).
- **Untrusted files.** No file is opened or uploaded. Documents stay named by their SHA-256, as in the close pack. The
  only file Vestiarion writes is its own spreadsheet; it never reads one a person made.
- **Links.** The spreadsheet link is built from a checked id; explorer and evidence links are the close pack's own (CP9,
  CP17). Google's `webViewLink` and any URL in an answer are never used.
- **Who sees what.** The spreadsheet holds what the CSV holds: members' emails, payees' names and full payout addresses,
  bank codes and last 4 digits, amounts, checks and signed entries, plus the exporter's email on the Summary. It lands
  in the Drive an owner or admin chose, and Vestiarion never shares it (GS17). The guide says: "The spreadsheet names
  members by email and payees by name, as the close pack does: share it with whoever should see that."
- **The ledger.** Entries name people by id and the spreadsheet by id; never an email, a token or a URL (GS11).
- **Pages.** The privacy page gains a Google Sheets entry and `SUBPROCESSORS` a "Google Sheets" service (only when
  someone connects it); the security page names it among the connectors and their tokens; the terms page gets a
  paragraph. Their dates move to 2026-10-25 (Docs and lists).

## Not in this change

- A connection per person, or exporting to the exporter's own Drive (GS4).
- Choosing a Drive folder (Google Picker) or a shared drive.
- Exporting on a schedule, or keeping a sheet in step as payments settle: a person exports again.
- Not-settled payments and escrow moves as their own tabs.
- Sharing a spreadsheet from Vestiarion.
- Reading anything from Google Sheets into Vestiarion.
- A Google mark (GS18).
- `GET /api/v1/close-packs/{month}` and SDK 0.4 (close pack CP18): no `/api/v1` operation changes here.
- Usage metering of exports.
- Excel, OneDrive or another spreadsheet tool.

## Tests (write these first)

Every new test that walks files, spawns a process or loads ESLint gets `}, 30_000);`. Google is faked through
`fetchImpl`; `tests/setup.ts` refuses every non-loopback fetch, so nothing reaches Google.

`tests/googlesheets-settings.test.ts`
- off unless both variables are set; off with an id that is not a Google OAuth client id, logging that and never the
  value; trims both; takes `1234567890-abc123def456.apps.googleusercontent.com`;
- `GOOGLE_SHEETS_SCOPES` is exactly `["https://www.googleapis.com/auth/drive.file"]`.

`tests/googlesheets-oauth.test.ts`
- the authorize URL is Google's, with `response_type=code`, the client id, the exact redirect URI, `drive.file` as the
  only scope, the state, `access_type=offline`, `prompt=consent` and `include_granted_scopes=false`, and no `openid` or
  `email`;
- the code exchange posts the form to `oauth2.googleapis.com/token` with `grant_type=authorization_code`, maps
  `expires_in` and `scope`; a 400 is `refused`; a 429, a 5xx or no answer is `unavailable`; an answer with no refresh
  token is `refused`;
- a refresh keeps the refresh token it sent; `invalid_grant` is `reconnect`; a 503 is `unavailable` with its
  `Retry-After`;
- revoke posts `token=` to `oauth2.googleapis.com/revoke`: true on 200, false on 400 and on no answer;
- `organisations` calls `about` with `fields=user(displayName,emailAddress,permissionId)` and the bearer token, and
  returns the permission id with `maskEmail`; with no email, "A Google account"; a grant without `drive.file` throws
  `ConnectRefusal("scopes")` before any call; a permission id that does not read is `bad_response`;
- `googleFetch` refuses any other host and sends `redirect: "error"`; no log line holds a token, an email or a body
  (console spied).

`tests/googlesheets-table.test.ts` (pure)
- `sheetValues`: the header is `CLOSE_PACK_COLUMNS`; `"1250.500000"` in `amount_paid` is `1250.5`, `""` stays `""`, a
  13-digit amount stays text, `"2"` in `earlier_attempts` is `2`; `entry_seq` `"5619"`, an invoice number `"00123"` and
  `paid_at` stay text; `=HYPERLINK("x")`, `+1`, `-2` and `@SUM(A1)` stay text with no `'` added;
- `paymentsSha256` is the SHA-256 of `JSON.stringify` of the rows padded to 51; a read back with trailing cells and rows
  dropped hashes the same once padded; one changed cell changes it;
- `summaryValues`: every row of GS9 in order; "Arc testnet" and "Arc mainnet" from the profile; "so far"; one "Paid in"
  row per token, never USDC plus EURC; the cut, people and screening rows only when they apply; the page URL with
  `?month=`; the exporter's email, or "a member" with 8 characters of the id;
- `spreadsheetTitle` for an ended month, for "so far", and cut to 200; `spreadsheetUrl` for a good id, and throwing for
  `../x`, `a b`, an id of 10 characters and a URL; `columnLetter(51)` is `"AY"`; `monthTag` is `"<uuid>:2026-10"`.

`tests/googlesheets-export.test.ts` (fake Google, fake stores and ledger)
- a first export: lists by the month's tag, creates a spreadsheet file with the name and tag, lists again, reads its
  tabs, renames the first to Payments and adds Summary, freezes and bolds the header, sizes the grid to the rows, writes
  with `valueInputOption=RAW` only, reads back `UNFORMATTED_VALUE`, and records `close_pack_exported` with `format
  google_sheets`, `payments`, `notSettled`, `sha256`, `headSeq`, `connectionId`, `spreadsheetId` and `created: true`;
- a second export of the month: finds the file, renames it ("so far" dropped once ended), creates nothing, `created:
  false`;
- a file gone (404, or 403 `insufficientFilePermissions`, on rename): a new one is made;
- two files under the tag after a create: keeps the oldest and trashes the one it made;
- missing tabs re-added; a third tab untouched;
- a pack of 2,000 rows: four values requests of 500 rows;
- a read back that differs: `close_pack_export_failed` `{ stage: "read_back", reason: "mismatch" }` and no
  `close_pack_exported`;
- a values write answered 503 twice: `close_pack_export_failed` `{ stage: "write", reason: "unavailable" }`;
- a 429 asking 2 seconds: waits once and goes on; asking 30 seconds before anything was written: `rate_limited`, no
  entry; a Drive 403 `userRateLimitExceeded`: `rate_limited`; 403 `storageQuotaExceeded`: `drive_full`;
- a 401: one refresh with the refused token, then the call again; a second 401: `reconnect`, the connection marked
  `needs_reconnect` with GS13's words; a refresh answering `reconnect`: marked, and Google never called;
- `files.create` timing out: `unavailable`, no entry, no second create; the next export finds the file by its tag;
- the brake at ten: refused before the pack is read or Google is called; a `close_pack_export_failed` counts;
- not connected, revoked, `needs_reconnect`, not set up and off each answer before any call;
- no request leaves for a host but the five; no entry holds an email, a token or a URL; nothing is written to the
  database but the entries and, on `reconnect`, the connection's status.

`tests/googlesheets-connect.test.ts` (as `tests/zohocrm-connect.test.ts`)
- both routes answer 404 without the client;
- the connect route, from the same origin with consent, redirects to Google's authorize URL with a signed state and the
  nonce cookie on `/api/integrations/googlesheets`; before 0145 it answers `error=not_set_up`;
- the callback: a grant without `drive.file` lands on `?googlesheets=scopes#googlesheets` and keeps nothing; a good one
  saves the connection with the masked email, `next_sync_after` `9999-12-31T00:00:00.000Z`, the tokens encrypted, and
  `accounting_connected` with `provider: "googlesheets"`; another account while one is connected is
  `other_organisation`; a 23514 from the old check is `failed`.

`tests/googlesheets-migration.test.ts` (PGlite)
- takes `googlesheets` beside every provider taken before, after 0101, 0105, 0115, 0116, 0122, 0123 and 0145 ran again;
- never narrows a later widening when it runs again;
- `external_links` still refuses `googlesheets`;
- `googlesheets_connector_ready` answers the tenant role and refuses `anon`;
- `accounting_connections_due(50)` never returns a `googlesheets` row whose `next_sync_after` is 9999-12-31;
- redefines no function or view an earlier migration made: its one function is its own.

`tests/googlesheets-actions.test.ts`
- export: an approver and a viewer are refused with the role message; an accountant exports; a month that does not
  read; each outcome's words; the result carries the URL and the masked account, never a token;
- disconnect: an owner revokes and deletes the tokens; with `connectedElsewhere` true it does not revoke and says so;
  with Google not confirming it says so; an accountant is refused; `accounting_disconnected` carries
  `revokedAtProvider`.

`tests/googlesheets-panel.test.tsx` (`renderToStaticMarkup`; `vi.mock("@/app/actions/googlesheets", ...)`)
- the card's five states and their buttons by role; every notice; no full email anywhere;
- `SheetsExport`: each view's words; the button only with `canExport`; the last export line; **Open the spreadsheet**
  opening in a new tab with `rel="noreferrer"`; `print:hidden`.

Existing tests to extend:
- `tests/csp.test.ts`: the `consent` map gets `googlesheets: [GOOGLE_AUTHORIZE]` (its origin is in `form-action`
  already).
- `tests/brand-marks.test.tsx`: `PROVIDER_MARKS` keys are `PROVIDERS` without `googlesheets` (GS18).
- `tests/connector-consent.test.tsx`: the history lists `googlesheets-2026-10-25`; the Google Sheets statement names no
  model provider, as Asana's does (`provider === "asana" || provider === "googlesheets"`).
- `tests/integration-connect-pages.test.tsx`: the `describe.each` list and its render switch get `googlesheets`, with
  `googleSheetsSettingsFromEnv` mocked on; naming no model provider, as Asana.
- `tests/connectors-status.test.ts`: an `export` connection's revoked and reconnect words.
- `tests/close-pack-page.test.tsx`: `vi.mock("@/app/actions/googlesheets", ...)`; each `sheets` view renders; the page
  exports `maxDuration = 120`.
- `tests/close-pack-route.test.ts`: a recent `close_pack_export_failed` counts toward the eleventh download.
- `tests/dal.test.ts` and `tests/tenant-rpcs-migration.test.ts`: `googlesheets_connector_ready` in `TENANT_RPCS`.
- `tests/security-page.test.tsx` and `tests/legal-pages.test.tsx`: the new dates; the subprocessor matches both ways.
- `tests/docs-guides.test.ts`: the accountants guide's new quoted rows (below).
- `tests/docs-links.test.tsx`: `["src/components/GoogleSheetsPanel.tsx", "/docs/guides/accountants#export-the-close-pack-to-google-sheets"]`.
- `tests/access-gates.test.ts` finds both actions in `src/app/actions/googlesheets.ts` on its own; any card render test
  that imports the Settings page's panels gets the `vi.mock`.

## Docs and lists to update

- `CHANGELOG.md`, `[Unreleased]` > `### Added`: "**Close packs in Google Sheets.** An owner or admin connects one Google
  account per workspace from **Settings**, and an owner, admin or accountant sends a month's close pack to a
  spreadsheet in that account's Drive with **Export to Google Sheets** on **Monthly close pack**. The spreadsheet holds
  the close pack's 51 columns on a **Payments** tab, one row per payment, with a frozen header and amounts as numbers,
  and a **Summary** tab with the month's totals, the ledger head, the signing keys, the tab's SHA-256 and how to check
  it. Exporting the same month again updates that spreadsheet. Vestiarion asks Google only for access to the files it
  makes, writes every cell as a value so nothing runs as a formula, reads the tab back, and records the export in the
  ledger as `close_pack_exported` with the spreadsheet's id. Disconnecting revokes the access at Google and deletes the
  tokens; the spreadsheets stay in Drive. Needs `GOOGLE_SHEETS_CLIENT_ID`, `GOOGLE_SHEETS_CLIENT_SECRET` and migration
  0145; until it runs, the Google Sheets card says it is not set up yet."
- `content/docs/changelog.mdx`, newest first, "## 2026-10-25: Close packs exported to Google Sheets":
  - "**`close_pack_exported`** takes `format: "google_sheets"` when a member exports a month to Google Sheets, with
    `connectionId`, `spreadsheetId` (Google's id of the spreadsheet) and `created` (a new spreadsheet was made). Its
    `sha256` is then the SHA-256 of the Payments tab as written: `JSON.stringify` of its rows, the header first, each
    as wide as the header. It names no one by email and carries no URL."
  - "A new entry, actor `human`, domain `system`: **`close_pack_export_failed`** `{ by, month, ended, format,
    connectionId, spreadsheetId, stage, reason }`, when an export failed after rows may have reached Google. `stage` is
    `write` or `read_back`; `reason` is `rate_limited`, `unavailable`, `forbidden`, `drive_full`, `bad_response` or
    `mismatch`."
  - "`accounting_connected` and `accounting_disconnected` may carry `provider: "googlesheets"`; `externalOrgId` is then
    the Google account's permission id and `externalOrgName` a masked email."
  - "Nothing else in `/api/v1` or the webhooks changes."
- `ARCHITECTURE.md`: "## Google Sheets: the close pack exported", after "## The monthly close pack": the provider on the
  core and the `export` kind, the one scope, the masked account, the month's file found by its tag, the two tabs, RAW
  values and the six number columns, the hash and the read back, the two entries and the shared brake, the calls and
  retries, disconnecting with a shared grant, `EXPORT_NEVER_DUE`, and migration 0145. Add `googlesheets` to the
  connectors' provider list in "## Accounting connectors".
- `content/docs/guides/accountants.mdx`: "### Export the close pack to Google Sheets", after "### The monthly close
  pack". It covers:
  - who connects (owner or admin), what Google asks for (one permission, in Google's words), and which Drive;
  - who exports, the button, the two tabs, the title, "so far", updating in place, a trashed file, other tabs, edits
    overwritten;
  - checking it: each row's entry with `verifyLedgerEntry`, the Summary's SHA-256 against `close_pack_exported`, and
    the Apps Script lines:
    ```js
    function paymentsSha256() {
      const rows = SpreadsheetApp.getActive().getSheetByName("Payments").getDataRange().getValues();
      const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(rows), Utilities.Charset.UTF_8);
      return digest.map((b) => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
    }
    ```
  - "The spreadsheet names members by email and payees by name, as the close pack does: share it with whoever should
    see that." Vestiarion never shares it;
  - disconnecting, the shared-account case, and removing the access in the Google Account's settings;
  - the messages ("Too many close pack exports in the last 10 minutes. Try again later.", the read back one);
  - "Before the update": until migration 0145 runs, the Google Sheets card says it is not set up yet.
  - No new "Arc testnet" occurrence is needed (the guide has it); no line puts a quote before a `#` and digits
    (ui-consistency reads it as a colour).
- `tests/docs-guides.test.ts`, the accountants guide's rows: "Export to Google Sheets" and "Open the spreadsheet"
  (`src/components/close-pack/SheetsExport.tsx`); "Connect Google Sheets" and "Disconnect Google Sheets"
  (`src/components/GoogleSheetsPanel.tsx`); "Continue to Google" (the connect page); "Payments tab SHA-256" and
  `PAYMENTS_TAB`'s "Payments" and "Summary" (`src/lib/googlesheets/table.ts`); "Too many close pack exports in the last
  10 minutes. Try again later." and "The spreadsheet did not read back as written, so the export is not recorded as
  done. Export again." (`src/app/actions/googlesheets.ts`); `close_pack_export_failed`
  (`src/lib/close-pack/record.ts`).
- `content/docs/guides/integrations.mdx`: a row "| [Google Sheets](/docs/guides/accountants#export-the-close-pack-to-google-sheets)
  | Nothing: it reads nothing from Google | A month's close pack, in a spreadsheet Vestiarion makes in the connected
  account's Drive, when an owner, admin or accountant exports it | A Google account: when someone exports |".
- `README.md`: "Works with" gains "[Google Sheets](https://www.vestiarion.xyz/docs/guides/accountants#export-the-close-pack-to-google-sheets)";
  the integrations table a row: "A month's close pack exported to a spreadsheet in the connected Google Drive: one row
  per payment with its signed entry, a summary with the tab's SHA-256, updated in place on the next export. Access to
  the files it makes only; it never shares them"; the licence line "Google Sheets and Google Drive are trademarks of
  Google LLC."
- `src/app/privacy/page.tsx`: under services, `<li><strong>Google Sheets</strong>` (after Asana): "Google Sheets
  (Google Drive), for a workspace an owner or admin connects to a Google account after agreeing to it, is written to
  only when an owner, admin or accountant exports a month's close pack. Vestiarion asks Google only for access to the
  files it makes, so it cannot see or open any other file in that Drive. Each export makes or updates one spreadsheet
  for the month in that account's Drive and writes the close pack into it: payees' names and payout addresses,
  amounts, invoice numbers, approvals with members' emails, the checks, the transactions and the signed ledger entries,
  with a summary naming the member who exported it. Vestiarion reads that spreadsheet back once to check it, and reads
  the Google account's id and email once when it is connected, keeping the id and a masked email. Google's tokens are
  kept encrypted, readable only by the server and never shown in the browser, a log, a model's prompt or a webhook.
  Nothing read from Google reaches the agent or a model, and Vestiarion never shares a spreadsheet. Disconnecting
  revokes the access at Google, unless another workspace is connected with the same Google account, and deletes the
  tokens; the spreadsheets already exported stay in that Drive." `updated="2026-10-25"`.
- `src/lib/subprocessors.ts`: `{ name: "Google Sheets", privacyEntry: "Google Sheets", names: ["Google Sheets", "Google
  Drive"], purpose: "written to with the close packs an owner, admin or accountant exports, in spreadsheets Vestiarion
  makes in the connected account's Google Drive", data: "each exported close pack's rows and summary, with members'
  emails, payees' names and addresses, amounts and signed entries, and the Google account's id and email when it is
  connected", when: ONLY_IF_CONNECTED }`, after Asana. `SUBPROCESSORS_AS_OF = "2026-10-25"`.
- `src/app/security/page.tsx`: "Google Sheets" added to the tokens list (line "the OAuth access and refresh tokens of
  …"), to **Connecting** ("…, Asana, Google Sheets, Slack or GitHub, and for the first eight only after agreeing…"), to
  **Storing**, and to the no-training line; **Disconnecting** adds "Google's grant is revoked only when no other
  workspace is connected with the same Google account, since revoking it ends that account's access for every
  workspace."; a new bullet "<strong>Google Sheets.</strong> Vestiarion asks Google for one permission, drive.file, so
  it reaches only the spreadsheets it makes. Each export writes cells as values, never formulas, reads the tab back,
  and records the export in the ledger with the tab's SHA-256. A link to a spreadsheet is built from its checked id,
  never from an address Google returns."; "Last updated 2026-10-25".
- `src/app/terms/page.tsx`: a paragraph after Asana's: "When an owner or admin connects Google Sheets to a workspace,
  they agree, for the workspace, that Vestiarion makes spreadsheets in the Drive of the Google account they connect and
  writes to them the close packs an owner, admin or accountant exports, with Google's access to the files it makes
  only. Vestiarion never shares a spreadsheet and reads nothing from one back; who sees it is up to that Google
  account. Vestiarion never uses Google data to train or improve any AI model, and never passes it to anyone else
  without the workspace's say. Disconnecting revokes the access at Google, unless another workspace uses the same
  Google account, and deletes the tokens; the spreadsheets already exported stay in that Drive."
  `updated="2026-10-25"`.
- The pinned dates move together: privacy and terms in `tests/legal-pages.test.tsx` `PAGES[].updated`, security in
  `tests/security-page.test.tsx`. If another D11 PR moved them the same day, keep 2026-10-25.
- `.env.example`, after Asana's block:
  ```
  # --- Google Sheets (optional) ---------------------------------------------------
  # One Google OAuth client (Web application) for the whole deployment
  # (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md): an owner or admin connects a workspace to
  # one Google account from Settings, and an owner, admin or accountant exports a month's close pack to a spreadsheet
  # in its Drive. Enable the Google Sheets API and the Google Drive API; the one scope is
  # https://www.googleapis.com/auth/drive.file. Authorized redirect URI, exactly:
  # <origin>/api/integrations/googlesheets/callback. Publish the app: in Testing, Google ends refresh tokens after
  # 7 days. Set both, or Google Sheets is off and /api/integrations/googlesheets/* answers 404. Needs migration 0145.
  GOOGLE_SHEETS_CLIENT_ID=
  GOOGLE_SHEETS_CLIENT_SECRET=
  ```
- `docs/self-hosting.md`: a paragraph after Asana's, with the same facts and a link to the guide section.
- Lists: `src/lib/dal/index.ts` `TENANT_RPCS` gets `"googlesheets_connector_ready"` with the comment "Whether
  migration 0145 has run (close pack Sheets GS2): it reads nothing."; `ConnectorProblem.provider` in
  `src/lib/usage/read.ts` gets `"googlesheets"`.
- The screenshot: `accountants-google-sheets` in `DOCS_SHOTS` (`src/app/docs-shots/shots.tsx`, page `settings`,
  `GoogleSheetsPanel` in its `connected` view with "ow***@pinecrest.test") and in `SHOTS`
  (`scripts/docs-screenshots.mjs`); `public/docs/guides/accountants-google-sheets.png`, 1520 px wide, under 250 KB,
  shown once in the accountants guide through `<Screenshot>` with alt text and a caption.
- No change to the OpenAPI document, the SDK, Postman, the MCP tools, the CSP itself, `src/lib/analytics/redact.ts` or
  `src/lib/auth/routes.ts`.

## Implementation order (one PR, TDD)

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, `page.md` and
`02-route-segment-config/maxDuration.md` first (AGENTS.md): route handlers take `Request`, `searchParams` is a Promise,
`maxDuration` on the page sets its Server Actions' timeout, keep `force-dynamic`, never `cacheComponents`.

1. Branch from `origin/main` after the close pack merged; commit this spec: "Add the design for exporting the close pack
   to Google Sheets".
2. `tests/googlesheets-migration.test.ts`, then `0145_google_sheets_connector.sql`; `TENANT_RPCS` and the tenant RPC
   test.
3. The provider id: `PROVIDERS` and every map (GS1), `AccountingProviderId`, the `export` kind's words in
   `status.ts` and `connections.ts` (`comesIn`, `EXPORT_NEVER_DUE`), `PROVIDER_MARKS` (GS18), the consent statement
   and version; then `npm run typecheck` to find every record it missed. Extend the brand-marks, connector-consent and
   connectors-status tests.
4. `tests/googlesheets-settings.test.ts` and `tests/googlesheets-oauth.test.ts`, then `settings.ts`, `http.ts`,
   `oauth.ts`, `provider.ts`, `ready.ts`.
5. `tests/googlesheets-connect.test.ts`, then `connect-deps.ts`, the two routes (`maxDuration = 60` on the callback)
   and the connect page; the CSP and connect-pages test rows.
6. `tests/googlesheets-table.test.ts`, then `table.ts`.
7. `tests/googlesheets-export.test.ts`, then `sheets.ts`, `store.ts` (`markSheetsReconnect`), `export.ts`, and the
   `record.ts` changes with the close pack route test's new case.
8. `tests/googlesheets-actions.test.ts` and `tests/googlesheets-panel.test.tsx`, then `views.ts`, `panel.ts`,
   `src/app/actions/googlesheets.ts`, `GoogleSheetsPanel.tsx`, `SheetsExport.tsx`; the Settings section; the close pack
   page's `sheets` prop and `maxDuration = 120`; the close pack page test.
9. The privacy, security and terms pages, `SUBPROCESSORS`, the three dates and their tests.
10. The docs-shots entry and `npm run docs:screenshots` for the one image (Edge, Windows).
11. The docs: the guide section and its quoted rows, integrations, CHANGELOG, changelog.mdx, ARCHITECTURE, README,
    `.env.example`, self-hosting. Grep for stale text ("first seven", the connector lists) and for local paths.
12. `npm run verify`, then `npm run build`. Rerun `tests/ui-consistency.test.ts` and `tests/security-page.test.tsx`
    alone if they time out in the full run.
13. Commits: "Add Google Sheets to the connector core (migration 0145)", "Export the close pack to Google Sheets",
    "Document the close pack in Google Sheets". Then the PR, whose body says the partner adds the Google client and
    runs 0145.

## How to prove it on prod

On pinecrest-studio, live on Arc testnet, after the merge deploys:

1. Before the client is set: `POST https://www.vestiarion.xyz/api/integrations/googlesheets/connect` answers 404;
   Settings has no Google Sheets card; the close pack page has no export control.
2. After the partner adds both variables, redeploys and runs 0145: reload every open app tab (skew protection). Settings
   > Integrations shows the Google Sheets card, "not connected".
3. **Connect Google Sheets**, tick **I agree**, **Continue to Google**. Google's screen names Vestiarion and only "See,
   edit, create, and delete only the specific Google Drive files you use with this app". Allow. The browser lands on
   `?googlesheets=connected#googlesheets` and the card reads "Connected to the Google Drive of <masked email>". The
   Audit log has `accounting_connected` with `provider: "googlesheets"` and the masked email.
4. Read-only probe (Supabase, SELECT only): `select status, next_sync_after, external_org_name, scopes from
   accounting_connections where provider = 'googlesheets' and org_id = (select id from orgs where slug =
   'pinecrest-studio')` gives `connected`, `9999-12-31`, the masked email and the one scope; `select count(*) from
   accounting_tokens where provider = 'googlesheets' and org_id = (…)` gives 1, and its `access_token_enc` is an
   envelope, not a token in the clear.
5. Open `/o/pinecrest-studio/evidence/close-pack?month=2026-10`, **Export to Google Sheets**. It answers "Exported
   <n> payments to Google Sheets." with **Open the spreadsheet**. In Drive: "Vestiarion close pack · Pinecrest Studio ·
   October 2026 so far · Arc testnet", tabs Payments and Summary, the header frozen and bold, `n` rows equal to the
   page's **Payments settled**, `=SUM` of `amount_paid` equal to its **Paid**, and a `tx_url` opening
   explorer.testnet.arc.io at the same hash.
6. The Audit log has `close_pack_exported` with `format: "google_sheets"`, the `spreadsheetId` in the sheet's address,
   `payments` n, and `sha256` equal to the Summary's "Payments tab SHA-256". The guide's Apps Script lines, run in
   that spreadsheet, return the same hex. `/api/ledger/verify` passes.
7. Export again: the same address, no second file in Drive (search "Vestiarion close pack"), the entry `created:
   false`. Move the file to the trash, export again: a new file, `created: true`.
8. As an accountant member of pinecrest-studio: the export works. As a viewer: no button, and the "Last exported" line
   with its link.
9. On a sandbox workspace (simulated payments, nothing on chain): add a sample vendor named `=HYPERLINK("https://example.com","x")`,
   pay one of its bills, connect the same Google account there, export: the payee cell is that text, not a link, and
   the pinecrest-studio spreadsheet is untouched.
10. An eleventh export or download within ten minutes answers "Too many close pack exports in the last 10 minutes. Try
    again later."
11. Disconnect in the sandbox first: the message says another workspace uses the same account, and Vestiarion still
    shows at myaccount.google.com/permissions. Then disconnect in pinecrest-studio: "Google Sheets is disconnected.",
    Vestiarion gone from that page, `accounting_disconnected` with `revokedAtProvider: true`, the token probe gives 0,
    and both spreadsheets are still in Drive.
12. `vercel logs` for the deployment, searched for `ya29.` and `1//`: nothing.
