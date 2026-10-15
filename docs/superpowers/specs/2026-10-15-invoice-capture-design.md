# Invoice capture for Chrome: drafts a person reviews, from text they select or a file they choose

Date: 2026-10-15. Status: implemented on `feat/invoice-capture`. Roadmap item D3. Decided under the standing autonomy
grant.

## 1. The problem

Invoices reach a business in more places than email: a supplier's billing portal, a web mail thread, a PDF opened in the
browser. Today a member downloads or copies the invoice, opens Bills & receivables and uses **From a document**. The
browser is where the invoice already is; capturing it there should take one click, and must never be a way around the
checks a bill goes through.

## 2. What this builds

A Chrome extension, **Vestiarion Invoice Capture**, with one purpose: capture invoice information the user explicitly
selects or uploads, let the user review the extracted fields, and send a draft to the user's Vestiarion workspace. A
person then turns the draft into a bill from the console, through the same add-invoice command as every other bill, or
discards it. The extension can never create a live invoice, approve, pay, or touch a wallet.

## 3. Rulings

### Drafts

- **C1. A draft is not an invoice.** `invoice_drafts` (migration 0121, a tenant table) holds what was captured: the
  supplier's name, the invoice number, the amount, the currency, the invoice date, the due date, the purchase order and
  a memo; where it came from (`source`: `selection` or `file`, and the document's kind and SHA-256); who captured it,
  through which connection, and when; and its `state`: `draft` (in the extension), `sent` (sent for review),
  `confirmed` (with the invoice it became) or `discarded`. Nothing reads a draft as a payable: the agent, the payment
  plan, the figures and the API see invoices only. A trigger (`invoice_drafts_guard`) holds the states: draft to sent,
  draft or sent to discarded, sent to confirmed, confirmed back to sent only while no bill is linked, and a bill linked
  once, to a confirmed draft only (a check, and one draft per bill). Where a capture came from never changes; its fields
  and matched counterparty change only while it is a draft; the captured text is only ever removed. What the reader
  made of it (`read`) is at most 64 KB.
- **C2. Reading.** A capture is read by the existing reader, `readInvoiceDraft` (From a document's, the Telegram bot's,
  Slack's and email's): selected text as pasted text, a PDF from its text layer, a `.txt` or `.eml` as it is. Every
  figure is checked against the document as there. A picture (PNG, JPEG, WebP) is not read, as the reader reads none:
  the draft starts blank with a note to type the fields from it, and the picture is not kept. Five reads a minute per
  workspace, the reader's own limit.
- **C3. What the extension sees.** Its own drafts: the fields, the fields still missing, and the reader's notes about
  the document (a total that disagrees, a date that could be read two ways, a currency Vestiarion does not pay in).
  Never the workspace's counterparties, invoices, members, wallets or keys: the counterparty match and its warnings,
  which name counterparties and their addresses on file, are kept for the console.
- **C4. Edits and sending.** While a draft is `draft`, the extension may change its fields (`PATCH`), each checked as
  the form checks it (an amount of at most 6 decimals, real dates, lengths). **Send draft** moves it to `sent`, once;
  it is then listed for review and the extension can no longer change it. A `sent` draft is still a draft. A new
  supplier's name forgets the counterparty the reader matched. One connection keeps at most 50 drafts never sent
  (`429` beyond).
- **C5. Review in the console.** Bills & receivables lists the sent drafts under **Waiting for review** as "N
  captured", which opens **Captured drafts**: the fields, who captured it and when, the reader's warnings with the
  counterparty match's, a possible duplicate, and the captured text under **What was captured**, read only when it is
  opened, so the list never carries it on every refresh. Past 50 drafts it says "50+ captured". An owner or admin gets
  **Review and add as bill** (the invoice form, filled from the draft, with the counterparty matched or to choose, and a
  link to add the supplier as a counterparty, `?add=1&draft=<id>`: Counterparties reads the name from the draft in
  the workspace, so a name, often a person's, never travels in an address) and **Discard**. Everyone else reads it. As
  for an emailed invoice, the form offers no project and no shadow-mode currency.
- **C6. Adding goes through the existing command.** **Add as bill** runs `invoice_draft.confirm`, which claims the
  draft (`sent` to `confirmed` in one guarded update, with the id the bill will have, `claimed_invoice_id`), then
  calls `addInvoice` as the person with that id, so every check of the invoice form, the counterparty's screening and
  the agent's decision apply exactly as to any bill. A refusal that wrote nothing (`counterparty_not_found`,
  `forbidden`, `surface`) puts the draft back. Any other failure looks the bill up by its id: found (its ledger
  entry failed after the row was written), the draft stays confirmed and linked, and the person is told the bill was
  added without its ledger entry; never added twice. Not found, the draft goes back. Unknown, it stays confirmed and the
  daily cleanup settles it by the same id an hour or more after. The `create_invoice` entry names `via: "chrome"`, the
  draft's id, the invoice number, and the document with the fields the person changed from what was read.
- **C7. Duplicates are said before adding.** Each draft is checked with the agent's own duplicate check
  (`findDuplicates`) against the bills of its matched counterparty, and against other captured drafts with the same
  supplier and invoice number. A draft that resembles one says so on its card; adding it then needs **This is not a
  duplicate** ticked, and the command checks again with the counterparty, amount and due date the person chose.
- **C8. Ledger.** `invoice_draft_captured` (actor `human`, domain `ap`) when a draft is sent for review: `{ by,
  draftId, source, document, connectionId }`, without the fields or the text. `invoice_draft_confirmed`: `{ by, draftId,
  invoiceId }`, after the `create_invoice` entry (or without one, when the bill was written and its entry was not).
  `invoice_draft_discarded`: `{ by, draftId }`.
  `extension_connected` and `extension_disconnected` (actor `human`, domain `system`): `{ by, connectionId, client }`,
  and for a disconnection `reason`: `extension`, `settings`, `reused_code`, `reused_refresh` (a refresh token used
  again), `role_changed` (a role that can no longer add bills), or `member_removed`, `member_left` or
  `account_deleted` when the membership ended and took the connection with it.

### Retention

- **C9. The captured text.** A draft keeps the text it was read from (`raw_text`: the selection, or the text read from
  a PDF, at most 20,000 characters) so the reviewer can compare. It is removed when the draft is confirmed or
  discarded, and by the daily cleanup from 29 days after capture whatever the state (and from every decided draft), so
  a daily run keeps "30 days at the latest". A file is never kept: only its SHA-256 and kind.
- **C10. Drafts never sent.** A draft still `draft` 6 days after capture is deleted by the daily cleanup, which keeps
  "7 days". A draft left confirmed without its bill linked for an hour is linked to the bill with its claimed id, or put
  back for review when there is none.
- **C11. The rest** (the fields, who and when, the state) is kept until the workspace is deleted, like other records.

### Authorization: no API key in the extension

- **C12. Authorization code with PKCE (S256).** `GET /extension/authorize` with `response_type=code`, `client_id` (the
  extension's id), `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state` and optionally `scope`. A
  `client_id` that is not in `CHROME_EXTENSION_IDS`, or a `redirect_uri` that is not exactly
  `https://<client_id>.chromiumapp.org/`, is refused on the page and never redirected to. Any other problem is
  redirected back as `error=invalid_request`, `invalid_scope` or `unsupported_response_type`, with `state`.
- **C13. Consent.** The signed-in person picks one of their workspaces where they can add bills (owner or admin) and
  reads exactly what the extension can do (create drafts in that workspace and read the drafts it created) and cannot
  do (approve, pay, add a bill, see wallets, members, keys or other records). **Allow** issues a one-time code (32
  random bytes, kept as SHA-256, 5 minutes) bound to the person, the workspace, the client, the redirect URI, the
  challenge and the scopes; **Cancel** redirects with `error=access_denied`. A signed-out visitor is asked to sign in
  first, in this window or another tab, then continue. The page is never shown inside another site's frame
  (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), and its address is never sent on as a referrer.
- **C14. Exchange.** `POST /api/extension/v1/token`, `grant_type=authorization_code` with `code`, `code_verifier`
  (43 to 128 characters), `redirect_uri` and `client_id`. The code is used up in one guarded update before anything is
  compared, so a code works once whatever the outcome. A wrong verifier, client or redirect URI, an expired or unknown
  code, a person no longer a member or no longer allowed to add bills: `400 invalid_grant`. A code presented again is
  marked (`replayed_at`) and revokes the connection it was exchanged for (`reason: "reused_code"`); an exchange checks
  the mark once its connection is written, so a replay that lands between the claim and the insert ends it too.
- **C15. Tokens.** An access token (`vxa_` and 43 base64url characters, 1 hour) and a refresh token (`vxr_…`, 30 days,
  replaced on every refresh), each kept only as its SHA-256 on the connection (`extension_grants`, a platform table, as
  API keys are). The audience is `vestiarion-chrome` and the scopes `invoice_draft:create invoice_draft:read`, nothing
  else: a request for any other scope or audience is refused (`invalid_scope`, `invalid_target`).
  `grant_type=refresh_token` returns a new pair and retires the old; a retired refresh token used again, or two
  refreshes with one token at once (the guarded update matches nothing), end the connection
  (`reason: "reused_refresh"`), with no grace window. The extension refreshes from its service worker only, one
  refresh at a time, so its own use never looks like that. A connection lasts at most 90 days from its making, which a
  refresh never extends (a check on the row too). A person who can no longer add bills ends it at a refresh or a
  request (`role_changed`). The code's hash is written with the connection in one insert, so a reused code always
  finds the connection to end.
- **C16. Only the draft endpoints take it.** The token is not an API key (`vxk_…`): `/api/v1`, the MCP server and every
  other route refuse it. The extension endpoints read the person's role again on every request (`memberActor` on the
  `chrome` surface) and run commands the `chrome` surface may run: `invoice_draft.capture`, `invoice_draft.edit` and
  `invoice_draft.send`, never `invoice.add` or any decision.
- **C17. Revocation.** `POST /api/extension/v1/revoke` (RFC 7009: `token`, `client_id`, always 200) ends the
  connection; the extension's **Disconnect** calls it. Settings lists the connected extensions, a person's own and,
  for an owner or admin, everyone's in the workspace, each with **Disconnect**. Ending a membership deletes its
  connections (a foreign key on the membership, cascading); removing a member, leaving and deleting an account read them
  first and record `extension_disconnected` for each.
- **C18. Limits.** Ten token or revoke requests a minute per address; sixty draft requests a minute per connection;
  ten consents a minute per person; the reader's five reads a minute per workspace. Single-instance buckets, as the
  others in `src/lib/rate-limit.ts`.

### The extension API

- **C19. Endpoints**, under `/api/extension/v1`, not `/api/v1` (they are not part of the public API, the OpenAPI
  document or the SDK):
  - `GET session`: the workspace's name and slug, the scopes, the audience and the token's expiry.
  - `POST invoice-drafts`: JSON `{ source: "selection", text }` or `multipart/form-data` with `file`; an
    `Idempotency-Key` header (1 to 100 characters) is required. Answers `201` with the draft. The same key and the
    same capture answers the same draft (`200`, `Idempotent-Replayed: true`); the same key with another capture,
    `409`.
  - `GET invoice-drafts/{id}` and `PATCH invoice-drafts/{id}`: a draft this connection captured; another is `404`.
  - `POST invoice-drafts/{id}/send`: sends it for review; answers the draft with `reviewUrl`, the console's link.
- **C20. Size caps.** Selected text: at most 20,000 characters, in a JSON body of at most 100 KB. A file: at most 4 MB,
  the reader's limit, sent with its `Content-Length` (`411` without one, so nothing is buffered to find out). A JSON
  body, or a token or revoke request, sent without its length is read chunk by chunk and given up on at the cap.
  Larger is `413`, before the model is called. What is kept is text Postgres can store: no NUL, no half of a character.
- **C21. CORS** answers only the origins `chrome-extension://<id>` of `CHROME_EXTENSION_IDS`, with
  `Vary: Origin`; a preflight or a request from any other origin is refused with `403` and no CORS header. Responses are
  `Cache-Control: no-store`.
- **C22. Not set up.** Before migration 0121, or without `CHROME_EXTENSION_IDS`, the authorize page says invoice
  capture is not set up, the endpoints answer `503`, and Bills & receivables and Settings show nothing new. Nothing
  else changes.

### The extension

- **C23. Manifest V3**, in `extensions/chrome-invoice-capture/extension/`: permissions exactly `activeTab`,
  `scripting`, `storage`, `identity` and `contextMenus`; no host permission: its calls to www.vestiarion.xyz are
  cross-origin requests the server answers with CORS (C21), never with cookies. No content scripts that run by
  themselves, no remote code, no `eval`, no CDN: plain JavaScript modules shipped in the folder, no build step. The
  extension's pages keep MV3's default content security policy. It is packed with Windows' `tar.exe`, whose zip keeps
  forward slashes.
- **C24. Reading the page only on a click.** **Capture selected text** reads the selection of the active tab once,
  through `activeTab` and `scripting`, when pressed; the context menu item **Capture invoice with Vestiarion** does
  the same for a selection, and keeps it in session memory: the popup shows it and sends it only when the person
  presses **Send to Vestiarion**, within 5 minutes, after which it is dropped. Nothing runs on a page otherwise.
- **C25. The popup.** A first-run screen saying what is sent and when; **Connect Vestiarion**
  (`chrome.identity.launchWebAuthFlow`); the workspace connected; capture by selection or **Choose a file** (PDF, text,
  email or picture); the fields, editable, with a warning for each one missing; **Send draft**; **Open in Vestiarion**;
  **Disconnect**, which revokes the token. The access token is kept in `chrome.storage.session` (memory),
  only the refresh token in `chrome.storage.local`, closed to content scripts (`setAccessLevel`) where Chrome supports
  it for local storage. What is captured goes to Vestiarion only, which has it read by the AI model provider it uses
  (DeepSeek on the hosted service, `HOSTED_MODEL_PROVIDER`, under its own API terms and privacy policy, which the guide,
  the privacy page and the store listing link), as for any invoice uploaded to it. No analytics.
- **C26. Store listing** as text in `STORE_LISTING.md`: the name, short and long descriptions with a "What it does not
  do" section, the single-purpose statement, each permission's justification and the privacy answers. Icons are made
  from the brand mark by `scripts/extension-icons.mjs`.

### Docs and tests

- **C27. Docs.** A guide (`content/docs/guides/invoice-capture.mdx`), a Chrome section on the privacy page, the
  architecture, `CHANGELOG.md`, and `content/docs/changelog.mdx` for the new ledger entries, which webhooks deliver.
- **C28. Tests.** The migration (PGlite: RLS, the guard, the composite keys, cascades, the sweep); PKCE (wrong
  verifier, reused code, expired code, wrong redirect, wrong audience or scope); the token reaching only the draft
  endpoints; a draft never becoming an invoice without the console's step, and the console's step going through
  `addInvoice`; idempotency; size caps; CORS; revocation; and the manifest (exact permissions, no remote code, no
  `eval`). Races (two refreshes with one token, two exchanges of one code, a replay between a claim and its insert) run
  against the in-memory PostgREST with a hook that runs a request in between: PGlite is one connection in one
  process, so it cannot hold two transactions open at once, and the guarded updates are what decides.

## 4. Environment

- `CHROME_EXTENSION_IDS`: the extension ids allowed to connect, separated by commas (the Web Store's id, and an
  unpacked build's for testing). Each is 32 letters `a` to `p`. Unset: invoice capture is off.

## 5. Not in this version

Reading pictures (the reader reads no image), capture from Firefox or Safari, a draft discarded from the extension, and
editing a draft in the extension after it was sent.
