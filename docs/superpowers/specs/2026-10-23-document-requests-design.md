# Exception resolution, part 1: ask the vendor for the missing document (2026-10-23)

## Why

A bill whose purchase order or goods receipt is missing waits as awaiting_info until someone chases the vendor by email
and types the PO in with **Add details**. The vendor has the document. A one-time link lets them send it straight to the
bill, without an account.

Part 2 (later) matches what they sent to the vendor, amount and PO, runs the checks again and returns the bill to the
normal approval path.

Part 1 asks, collects and shows; it never pays and changes no bill on its own.

Part 2 is docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md (migration 0144). For a document it
checks, it replaces ER6 and ER7: with vendor requests on, a document that matches adds the bill's purchase order, and
a person approves the payment. The rest of part 1 stands.

## Rules

**ER1. The setting.** A column `approval_policies.document_requests text not null default 'off'`, with values `off`,
`shadow` and `on`, in migration 0142.
- An owner (`approval.policy`) changes it in **Settings**, beside the payee lock, under "Ask vendors for missing
  documents".
- Each change is signed as `document_requests_changed { by, from, to }`.
- Before 0142 it reads `off`, and Settings says it is not available yet.

**ER2. Which bills.** At the end of each cycle (a new stage, after term requests), a payable qualifies when all of these
hold:
- its status is `awaiting_info`;
- `missingDetails` of its current row names a purchase order or a goods receipt;
- its counterparty has a billing email;
- its counterparty is not frozen and not screened high risk;
- it has no drafted or open request (at most one of those per bill), no request expired or answered in the last 7 days,
  and no request an owner or admin revoked: a revoked bill is never asked about again.

This matches how the UI already offers **Add details**. It does not key on `guardrailRule`, which most match holds leave
null.

At most 20 requests per workspace a day. The bills' earlier requests are read 100 bills at a time.

**ER3. Shadow first.** With `shadow`, the stage sends nothing.
- It signs `document_request_drafted { invoiceId, counterpartyId, requestId, missing, emailDomain }`. The domain is the
  only part of the address signed.
- The bill's card on Approvals and in the Bills list says "Vestiarion would ask <vendor> for the purchase order. Turn on
  vendor requests in Settings to send it." It says so only while the bill is still `awaiting_info`, and names what its
  current row lacks, not what it lacked when the request was drafted.

**ER4. Asking.** With `on`, the stage:
- creates a request with a one-time token: `vxu_` plus 32 random bytes, of which only the SHA-256 is kept;
- sets it to expire in 14 days;
- emails the vendor's billing address, from the workspace's name, with the bill's invoice number (theirs), amount,
  due date and what is missing, plus the link;
- signs `document_requested { invoiceId, counterpartyId, requestId, missing, emailDomain, expiresAt }`;
- shows on the card "Asked <vendor> for the purchase order on Oct 23; the link expires Nov 6."

A send that fails leaves the request unsent and is tried at the next cycle, at most 3 times.

A sandbox never emails its vendors, which are sample data or real ones a trial added. Its requests, in shadow and on, go
to the member who last set vendor requests to shadow or on, as the latest `document_requests_changed` names them, and
the email is marked `[Sandbox]`, as term requests and early offers do. The request keeps that member's email domain,
and both entries carry `sandbox: true`. With no such entry, or once that member left, a sandbox asks no one. A
workspace in shadow mode asks as a live one does: its bills are the business's own, and a request asks for a
document, never a payment.

**ER5. The vendor's page**, `/documents/[token]`, public and noindex, with no account. It shows:
- the workspace's name;
- the vendor's own invoice number, its amount and due date;
- what is missing.

The vendor:
- uploads one file, a PDF, PNG or JPEG of at most 10 MB, checked by its first bytes, not its name (the page reads them
  too, so a file with no extension, which a browser gives no type, is still taken);
- may type the PO number: plain text on one line, of at most 100 characters, with no control or format character, no
  line or paragraph separator (U+2028, U+2029) and no link;
- may add a note of at most 500 characters, whose line breaks, those separators among them, are kept as line breaks.

The page and 0142 refuse the same control characters: the migration names them by code point, never `[[:cntrl:]]`,
whose members follow the database's ctype.

Migration 0142 creates the private `documents` storage bucket, where no file has a public address. The vendor's browser
puts the file there directly, at a signed upload address the server makes for the request under the workspace's own
folder.

On submit:
- the server reads the file back, checks its first bytes and size, and moves it to a path named by its SHA-256, out of
  the upload address's reach; since that address could write again in between, the moved file is read back and kept
  only when it hashes as the file checked;
- the request becomes answered, once;
- `document_received { by: null, via: "document_request", invoiceId, counterpartyId, requestId, poReference?,
  fileSha256, fileType, fileSize }` is signed;
- the owners and admins are emailed, which says whether the vendor typed a PO number, never what they typed.

The page then says the business was told. An expired, answered or revoked link shows one sentence and names nothing.
Submissions are rate-limited per IP and per token.

**ER6. The person.** The bill's card says "<vendor> sent a document on Oct 24", with:
- a members-only link to open it;
- the PO number they typed, prefilled in **Add details**.

The person still adds the details and the agent decides again, as today. If the vendor is asked again later, what they
sent stays on the card under the newer request, with its link and PO.

An owner or admin can **Revoke** an open request, signed as `document_request_revoked`.

**ER7. Never pays.** Neither the stage, the page nor the answer changes a bill's status, amount or address, or moves
money.

**ER8. Docs and lists.**
- The guide: a new section in the approvals or invoices guide.
- The privacy page: what a vendor's page collects, and that the vendor's email is used once per request.
- The security page: one-time link handling.
- The API changelog: the new ledger actions.
- CHANGELOG and ARCHITECTURE.
- Lists to update:
  - `tests/access-gates.test.ts`'s list of `'use server'` files outside `src/app/actions`;
  - `src/app/analytics/redact.ts`, for the token path;
  - `src/lib/dal/index.ts` TENANT_TABLES;
  - `tests/delete-org-migration.test.ts`;
  - `tests/readme-facts.test.ts` and README's cycle stage list.

## Migration 0142

- **The column.** `approval_policies.document_requests`, with its check.
- **The table.** A tenant table `public.document_requests`, under the workspace's RLS like other tenant tables, with
  definer functions for the public page. Its columns:
  - `id`, `org_id`;
  - `invoice_id` and `counterparty_id`, cascading on delete;
  - `token_hash`, unique, matching `^[0-9a-f]{64}$`;
  - `missing jsonb`;
  - `status`: `drafted`, `open`, `answered`, `expired` or `revoked`;
  - `email_domain`, `send_attempts`, `sent_at`, `expires_at`, `answered_at`;
  - `po_reference` (at most 100 characters), `note` (at most 500);
  - `file_path`, `file_sha256`, `file_type`, `file_size`;
  - `created_at`.
- **The functions.** Modelled on 0137's address change checks:
  - `document_request_preview(p_token_hash)`: what the page shows, for an open, unexpired request only;
  - `answer_document_request(p_token_hash, …)`: once, while open.
- **Idempotent**, with no function redefined from another migration.

The vendors' files are not rows: they are named before the rows go, read in pages of 1000 rows, and removed from the
bucket after, when the workspace is deleted by its owner, with its last member's account or by the daily cleanup of an
idle sandbox, and, for the requests to sample vendors, when the sample data is removed. A deleted workspace's whole
`document-requests` folder is listed and emptied too, so a file no row names (kept for an answer that did not go
through, or by an answer after the rows were read) goes with it.

## Tests

- The migration (PGlite): checks, RLS, the functions answering once, and expiry.
- The stage:
  - qualification, including a match hold with a null rule;
  - shadow signs and sends nothing;
  - on sends once;
  - the daily cap and the cooldown;
  - failed sends retried at most 3 times;
  - before 0142, nothing happens.
- The page: preview, file type sniffing, size, one answer, rate limit, the expired, answered and revoked states.
- The card states.
- The setting's action and its authorization.
- Revoke.
- Never pays: no status, amount or address write.
