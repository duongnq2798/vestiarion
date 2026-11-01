# Bills dropped into a Google Drive folder

Date: 2026-11-01. Status: built on branch `feat/google-drive-intake`: the server, the Settings card, the connect page,
the review list, `/docs-shots/googledrive/<state>` and the guide (`content/docs/guides/google-drive.mdx`). Needs
migration 0148 and the partner's Google Cloud steps below. Not verified against a live Google Drive yet.

## Why

Small businesses keep their bills in Google Drive. Many already have a folder their bookkeeper, a vendor or a scanner
saves PDFs into. Today such a bill reaches Vestiarion three ways:
- From a document, on Bills & receivables, one file at a time;
- forwarded to the workspace's invoice address (`docs/superpowers/specs/2026-10-03-email-invoices-design.md`, E1-E12);
- Add invoice on a Slack message.

This adds a fourth: a workspace chooses one Drive folder, and every PDF added to it is read into a bill waiting for a
person's review, in the same list the emailed invoices wait in. Nothing is added by itself.

Code comments and test names cite the ids, for example "(Google Drive intake GD7)".

## Google facts this rests on (developer docs, read 2026-11-01)

- **Scopes.** `drive.file` (what Google Sheets uses, GS3) reaches only the files the app created or the person opened
  with the app. A file someone later drops into a folder is neither, even when the person chose that folder in the
  Picker. Reading a folder's new files needs `https://www.googleapis.com/auth/drive.readonly`.
- **`drive.readonly` is a restricted scope.** In production it needs Google's restricted-scope verification and a
  security assessment. Until then, Google shows its "Google hasn't verified this app" screen to whoever grants it, and
  at most 100 people can grant it. At four customer workspaces that is enough; the guide says so plainly.
- **OAuth** is the one Sheets uses: `https://accounts.google.com/o/oauth2/v2/auth`, `access_type=offline`,
  `prompt=consent`, the token endpoint for exchange and refresh, revoke at `https://oauth2.googleapis.com/revoke`.
  The account is read from Drive's `about` (`user(permissionId, emailAddress, displayName)`), as Sheets does.
- **Listing a folder.** `GET https://www.googleapis.com/drive/v3/files` with
  `q='<folderId>' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'` (its files, not
  its subfolders), `fields=nextPageToken, files(id, name, mimeType, size, md5Checksum, createdTime, modifiedTime,
  lastModifyingUser(displayName, emailAddress))`, `orderBy=createdTime desc`, `pageSize` up to 1000,
  `supportsAllDrives=true`, `includeItemsFromAllDrives=true` (a folder in a shared drive works too).
- **A folder.** `GET /drive/v3/files/<id>?fields=id, name, mimeType, trashed, driveId&supportsAllDrives=true`; a folder's
  `mimeType` is `application/vnd.google-apps.folder`.
- **A file's bytes.** `GET /drive/v3/files/<id>?alt=media&supportsAllDrives=true`. Google Docs, Sheets and Slides files
  have no bytes to download (they are exported instead); this change does not export them.
- **Errors.** 401 when the access token expired (refresh, then once more); `invalid_grant` on refresh when access was
  removed; 403 `insufficientPermissions` or `appNotAuthorizedToFile`; 404 when the file or folder is gone or no longer
  shared with the account; 403/429 `rateLimitExceeded` / `userRateLimitExceeded` with backoff.

## The rules

- **GD1. Provider.**
  - Google Drive is a provider `googledrive` of a new kind, `intake`, on the connector core: connect, token lease and
    refresh, consent version, disconnect, the 15-minute sweeper. No bills or deals are synced the accounting way; the
    folder's new files are read (GD6).
  - On only with `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` (the id checked as Sheets checks its own).
    Best from a Google OAuth client of its own: Google's revoke ends the account's whole grant to a client, and Sheets'
    disconnect revokes without looking at Drive (Sheets is unchanged), so with one shared client it cuts Drive off for
    the same Google account. Drive's own disconnect keeps the grant while Sheets holds the account on the same client.
    Without them there is no Google Drive card and no connect route.
  - Google's product icons are not used without Google's permission: like Google Sheets, `googledrive` is an unmarked
    provider and its card uses a plain folder icon.
- **GD2. Connecting.**
  - An owner or admin (`integrations.manage`) connects with OAuth, scope `drive.readonly` only, no identity scope.
  - The callback is `https://www.vestiarion.xyz/api/integrations/googledrive/callback`.
  - A grant is one Google account's; the connection reads only the one folder the workspace chose, with that account's
    access. The connection's external id is the account's Drive permission id, as Sheets'.
  - One live Google Drive connection per workspace. The same Google account may be connected to several workspaces,
    each with its own folder.
  - Consent `googledrive-2026-11-01`, saying the permission lets Vestiarion see every file in the account's Drive and
    that it reads only the chosen folder.
  - Disconnect deletes the tokens and forgets the folder, and revokes the grant at Google unless the same Google account
    is still connected elsewhere: in another workspace, or in Google Sheets on the same OAuth client. The rows already
    read stay in the review list.
- **GD3. Schema (0148).** Additive and idempotent, re-runnable by `scripts/migrate.ts`:
  - `googledrive` added to the provider checks of `accounting_connections` and `accounting_tokens`, keeping every value
    the latest migration lists (0147 added `linear`). Each check is replaced only while it does not take `googledrive`.
  - `inbox_emails` becomes the list of every document waiting for review, whatever brought it:
    - `source text not null default 'email'`, checked `in ('email', 'google_drive')`;
    - `drive_file_id` (1-200 characters) and `file_name` (at most 255), both null for an email;
    - `resend_email_id` no longer `not null`; a check keeps an email with its Resend id and no Drive id, and a Drive row
      with its Drive id and no Resend id;
    - one row per Drive file and workspace: `unique (org_id, drive_file_id)` (nulls never collide, so emails are
      untouched).
  - `google_drive_folders`, tenant data under the same RLS and grants as `inbox_emails`: one per workspace
    (`org_id` unique), the connection it reads with (composite reference to `accounting_connections`, deleted with it),
    the folder's id and name, its shared drive id when there is one, the baseline (GD5), who chose it and when, when it
    was last read, and the last error a person reads with its kind (`folder_gone`, `rate_limited`, `unavailable`,
    `failed`) and when it happened; the card offers to choose another folder on `folder_gone` alone.
  - `googledrive_connector_ready(p_org_id)`, true once 0148 has run. Before then the card says Google Drive is not set
    up and no one is sent to Google, as Sheets does before 0145.
  - `accounting_connections_due` is not redefined (a migration that redefines another's function is reverted by any
    migrate run from a branch without it). A Drive connection is due like Asana's and Linear's.
- **GD4. Choosing the folder.** `integrations.manage`. A person pastes the folder's link
  (`https://drive.google.com/drive/folders/<id>`, also with `/u/<n>/` and query strings) or its id. The link is read
  only for its id, never opened. The folder is read once through the connection: it must be a folder, not trashed. Its
  name is shown. Choosing another folder replaces the first, with a new baseline. The same folder chosen again keeps
  its baseline, who chose it and when, and its last read, and clears its error: a file added while the folder could not
  be read, or one whose row a stopped read gave back, is still read, never taken into a new baseline.
- **GD5. Only files added from now on.** When a folder is chosen, the ids of the files already in it are the baseline,
  and are never read: an old, already paid bill in the folder must not come back as a new one. At most 1,000; a folder
  with more is refused ("That folder holds more than 1,000 files. Choose a new, empty folder, or one with at most 1,000
  files."); one of exactly 1,000 is taken. A file moved into the folder later is new, whatever its dates.
- **GD6. Reading the folder.**
  - The folder's files are listed (no subfolders, at most 2,000 per read). A file is new when its id is in neither the
    baseline nor `inbox_emails` for this workspace.
  - Each new file gets its row first, `source google_drive`, by an insert that ignores a duplicate on
    `(org_id, drive_file_id)`: two reads at once never read a file twice. A file to read gets status `received`; one of
    a type that is not read is inserted `unreadable` with its reason at once.
  - Names from Drive (a file's, the folder's) are kept as Postgres takes them: at most 255 characters counted as
    Postgres counts them, never half of an emoji, since anyone who can add a file chooses its name (GD9). A row the
    database refuses is logged and skipped, never stopping the read; the file is tried again next time.
  - A PDF, `.eml` or `.txt` (by name or type) of at most 4 MB is downloaded and read by `readInvoiceDraft`, the way
    From a document reads one, held to the draft rule every chat shares (`chatDraftOf`). The row becomes `ready`,
    `needs_details` with the reasons, or `unreadable`, as an email's does (E5).
  - Anything else gets a row `unreadable` with a reason a person can act on: a picture or a scan ("Save it as a PDF
    with text"), a Google Docs file ("Download it as PDF into the folder"), larger than 4 MB, or another type.
  - Five documents are read a minute per workspace, as everywhere (`takeDocumentReadToken`). A file over that limit
    gets no row yet and is read next time: nothing is lost and nothing waits with a misleading reason.
  - A read starts no new file after 40 seconds, downloaded or not; what is left is read next time. A file whose read
    stopped on a rate limit or no answer gives its `received` row back, so it is read next time; a row still `received`
    10 minutes after it was made is set `unreadable` at the next read, so none waits without a reason.
  - A read claims each file only while the folder it started with is still the one chosen (the row's id, `folder_id`
    and `chosen_at`), and writes its last read or error on that choice alone: a folder chosen, or forgotten on
    disconnect, while it runs is never written over, and the next sweep reads the new one.
  - A file is read once. A file changed in Drive after it was read is not read again; a person can add it from a
    document, or drop the new version in as a new file.
- **GD7. When it is read.** By the sweeper every 15 minutes, and on **Check Google Drive now** in Settings and in the
  review list (`invoice.add`, as adding from the list needs). There is no push channel in this change.
- **GD8. What a person sees and decides.** The review list on Bills & receivables (E7) holds Drive rows beside emails,
  newest first. A Drive row shows "From Google Drive", the file name, when it was found, and who last changed it in
  Drive (the email masked, as a sender's is, kept in the row's `from_address`): information, never authority. Add, Finish and Dismiss work as they do
  for an email (E7, F5), with the same roles, the same one-use guarded update and the same put-back on failure. Words
  that said "email" in a place both reach say "invoice" or name the source.
- **GD9. Nothing is added by itself.** Anyone who can add a file to the folder can make a row: a file's presence is never
  a reason to pay. A person adds every draft. A payment address in the document goes through the pay-to hold as any
  document's does.
- **GD10. Adding.** `addInvoice` as the member. `create_invoice` names `via: "google_drive"`, `inboxEmailId` (the row,
  under the name it already has) and `driveFileId`, with the document's kind, hash and reader. The agent decides it as
  any payable.
- **GD11. Ledger.**
  - `invoice_drive_file_received` (system, ap): `{ inboxEmailId, driveFileId, fileName (at most 120 characters),
    lastModifiedBy (masked, or null), read, document }`.
  - `invoice_drive_file_dismissed` (human, ap): `{ by, inboxEmailId, driveFileId }`. An email's dismissal keeps
    `invoice_email_dismissed`.
  - `google_drive_folder_chosen` (human, ap): `{ by, folderId, folderName, baseline }` (the count, not the ids); the
    same folder chosen again is signed again with the baseline it kept.
- **GD12. Slack.** A workspace with Slack has its channel told, as for an email (E9): "New invoice from Google Drive:
  <file>: amount, due. A person adds it in Bills & receivables; nothing is paid until then." Best effort.
- **GD13. Errors a person reads.**
  - Access removed (`invalid_grant`, or 401 after a refresh): the connection needs reconnecting, as Sheets' does
    (`markSheetsReconnect`'s pattern), and the accountant console's problems list shows it as for any connector.
  - The folder deleted, trashed or no longer shared with the account (404, or a folder read that fails the GD4 checks):
    the folder's `last_error` says so, on the card and in the review list, and the card offers to choose another.
    Nothing else changes: the folder is read again by itself once the account can open it, and the next good read
    clears the error.
  - Google's rate limits: backoff as the core's, the folder's `last_error` set, read again next time.
  - Errors are logged with the workspace id and a reason, never a token or a file's contents.
- **GD14. What is kept.** The folder's id and name, and the ids of the files already in it when it was chosen (the
  baseline, GD5). For each file read: its id and name, who last changed it in Drive (masked in the ledger, as kept for
  the row), what was read, the draft, and the document's hash. The file itself is never kept, as From a document. The
  consent, the guide and the privacy page list all of it.
- **GD15. Figures.** On the Google Drive card: files read in the last 30 days, waiting for review now, files a person
  added as bills in the last 30 days (by when they were added, whenever they were found), and when the folder was last
  read.
- **GD16. Words and places.**
  - Settings has the Google Drive card: connect, the connected account, the folder (paste a link, Choose), the
    figures, Check Google Drive now, Disconnect.
  - The review list on Bills & receivables shows Drive rows (GD8) and offers Check Google Drive now when connected.
    With a folder to check and nothing waiting, the line under the figures says "Nothing waiting for review" and offers
    "Check Google Drive", which opens the list.
  - The consent, privacy and terms say what is read, kept and written, in plain English, as for Google Sheets and the
    invoice address. Written: nothing, the scope is read-only.
  - A guide, `content/docs/guides/google-drive.mdx`, says how to connect, choose the folder, what happens to a file, and
    the "Google hasn't verified this app" screen until Google verifies the permission.
  - The integrations list, README, ARCHITECTURE, `content/docs/changelog.mdx` (the new ledger actions and `via`) and
    CHANGELOG are updated.

## What the partner does after the merge

1. Run migration 0148.
2. In Google Cloud, in the project of the OAuth client used:
   - Google Drive API enabled (it is, for Sheets, if the same project);
   - Data access: add `https://www.googleapis.com/auth/drive.readonly`;
   - a new OAuth client (Web application) for Google Drive, its authorized redirect URI
     `https://www.vestiarion.xyz/api/integrations/googledrive/callback`.
3. Set `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` in Vercel production to that new client's, then
   redeploy. The Sheets client's values would work, but then disconnecting Google Sheets revokes Google Drive's grant
   too, for the same Google account (GD1).
4. Connect a test Google account in a test workspace, choose an empty folder, drop a PDF bill into it, press Check Google
   Drive now, and add the bill from the review list.
5. Later, when it is worth it: Google's restricted-scope verification, to remove the warning screen and the 100-person
   limit.

## Screens

From `/docs-shots/googledrive/<state>` (sample data, `DOCS_SCREENSHOTS=1` only), as Linear's:

1. `settings`: the Google Drive card, connected, with its folder and figures.
2. `folder`: connected, no folder chosen yet: paste the folder's link.
3. `review`: the review list on Bills & receivables with a Drive row ready to add beside an email.

## What it does not do

- No file is written, moved, renamed or deleted in Drive: the scope is read-only.
- No push notifications (Drive `changes.watch`): reads are every 15 minutes and on Check now.
- Google Docs files are not exported; subfolders are not read; a file changed after it was read is not read again.
- No Google logo (GD1).
